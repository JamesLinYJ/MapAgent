// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象 Worker 客户端
//
//   文件:       meteorologyWorkerClient.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 统一封装气象 Python Worker 的 HTTP 调用、短期签名和 catalog 契约校验。
// Worker 内部 API 的 schema 由 Python Pydantic model 生成，Node 在启动和
// 调用时消费该 catalog，不维护第二份手写 Worker schema。

import { createHash } from 'node:crypto'
import {
  workerToolCatalogSchema,
  type WorkerToolCatalog,
  type WorkerToolSpec,
} from '@geo-agent-platform/shared-types/worker'
import { parametersFromJsonSchema, stableJson } from '../../framework/schema.js'
import { currentLogContext } from '../../observability/logger.js'
import { signWorkerRequest } from './workerAuth.js'
import { abortSignalWithTimeout } from '../../utils/abort.js'

export const REQUIRED_METEOROLOGY_WORKER_TOOLS = [
  'meteorological_inspect',
  'meteorological_render',
  'render_nowcast_raster',
  'meteorological_stats',
  'meteorological_threshold',
  'meteorological_contour',
  'meteorological_report',
  'meteorological_nowcast_report',
  'create_nowcast_sequence',
  'inspect_nowcast_sequence',
  'meteorological_precipitation_nowcast',
  'answer_nowcast_question',
  'generate_nowcast_forecast_text',
  'inspect_radar_station_collection',
  'recommend_radar_mosaic_strategy',
  'render_radar_mosaic',
  'compare_radar_mosaic_reference',
  'render_rainfall_risk_map',
  'generate_area_rainfall_table',
] as const

export type MeteorologyWorkerToolName = typeof REQUIRED_METEOROLOGY_WORKER_TOOLS[number]

export interface MeteorologyWorkerClientConfig {
  workerUrl?: string
  workerSharedSecret?: string
  requestTimeoutMs: number
}

const cachedCatalogs = new Map<string, WorkerToolCatalog>()

export async function callMeteorologyWorker(
  config: MeteorologyWorkerClientConfig,
  name: MeteorologyWorkerToolName,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const url = config.workerUrl
  if (!url) throw new Error('WORKER_URL 未配置')
  if (!config.workerSharedSecret) throw new Error('WORKER_SHARED_SECRET 未配置')
  const spec = await getWorkerToolSpec(url, config.workerSharedSecret, name)
  const validatedArgs = validateAgainstJsonSchema(`Worker 工具 "${name}" 参数`, spec.contract.parametersSchema, args)
  const body = JSON.stringify({ args: validatedArgs })
  const response = await fetch(`${url.replace(/\/$/u, '')}/tools/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: signWorkerRequest(config.workerSharedSecret, name, body),
      ...traceHeaders(),
    },
    body,
    signal: abortSignalWithTimeout(signal, config.requestTimeoutMs),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(workerErrorDetail(detail) || `Worker HTTP ${response.status}`)
  }
  const responseBody: unknown = await response.json()
  if (!isRecord(responseBody) || !isRecord(responseBody.payload) || typeof responseBody.message !== 'string') {
    throw new Error(`Worker 工具 "${name}" 返回无效 payload`)
  }
  const payload = validateAgainstJsonSchema(`Worker 工具 "${name}" 返回结果`, spec.contract.resultSchema, responseBody.payload)
  return { message: responseBody.message, payload }
}

export async function fetchMeteorologyWorkerCatalog(workerUrl: string, workerSharedSecret: string): Promise<WorkerToolCatalog> {
  const normalizedUrl = workerUrl.replace(/\/+$/u, '')
  const cached = cachedCatalogs.get(normalizedUrl)
  if (cached) return cached
  const response = await fetch(`${normalizedUrl}/tools/catalog`, {
    headers: {
      Authorization: signWorkerRequest(workerSharedSecret, 'catalog', ''),
      ...traceHeaders(),
    },
  })
  if (!response.ok) {
    throw new Error(`Worker /tools/catalog 返回 HTTP ${response.status}`)
  }
  const body: unknown = await response.json()
  const parsed = workerToolCatalogSchema.safeParse(body)
  if (!parsed.success) {
    const details = parsed.error.issues.map(issue => `${issue.path.join('.') || 'catalog'}: ${issue.message}`).join('；')
    throw new Error(`Worker /tools/catalog 返回结构不符合共享协议：${details}`)
  }
  if (parsed.data.count !== parsed.data.tools.length) {
    throw new Error(`Worker /tools/catalog count=${parsed.data.count} 与 tools.length=${parsed.data.tools.length} 不一致`)
  }
  for (const spec of parsed.data.tools) {
    const expectedHash = workerContractHash(spec.contract)
    if (spec.schemaHash !== expectedHash) {
      throw new Error(`Worker 工具 "${spec.toolName}" catalog hash 不一致：${spec.schemaHash} != ${expectedHash}`)
    }
  }
  cachedCatalogs.set(normalizedUrl, parsed.data)
  return parsed.data
}

function traceHeaders(): Record<string, string> {
  const currentTraceId = currentLogContext().traceId
  return currentTraceId ? { 'x-geo-agent-platform-trace-id': currentTraceId } : {}
}

export function clearMeteorologyWorkerCatalogCache(): void {
  cachedCatalogs.clear()
}

export function workerContractHash(contract: WorkerToolSpec['contract']): string {
  return `sha256:${createHash('sha256').update(stableJson(contract)).digest('hex')}`
}

async function getWorkerToolSpec(
  workerUrl: string,
  workerSharedSecret: string,
  name: MeteorologyWorkerToolName,
): Promise<WorkerToolSpec> {
  const catalog = await fetchMeteorologyWorkerCatalog(workerUrl, workerSharedSecret)
  const spec = catalog.tools.find(candidate => candidate.toolName === name)
  if (!spec) throw new Error(`Worker catalog 缺少工具 "${name}"`)
  return spec
}

function validateAgainstJsonSchema(
  label: string,
  schema: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  const result = parametersFromJsonSchema(schema).safeParse(stripUndefined(value))
  if (!result.success) {
    const details = result.error.issues.map(issue => `${issue.path.join('.') || '参数'}: ${issue.message}`).join('；')
    throw new Error(`${label}不符合 Pydantic catalog 契约：${details}`)
  }
  return result.data as Record<string, unknown>
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => stripUndefined(item))
  if (!isRecord(value)) return value
  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    if (nested === undefined) continue
    output[key] = stripUndefined(nested)
  }
  return output
}

function workerErrorDetail(raw: string): string {
  if (!raw.trim()) return ''
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed) && typeof parsed.detail === 'string' && parsed.detail.trim()) return parsed.detail.trim()
  } catch {
    // 非 JSON 错误正文原样上浮，避免隐藏 Worker 的真实失败。
  }
  return raw.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

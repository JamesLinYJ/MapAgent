// +-------------------------------------------------------------------------
//
//   地理智能平台 - 自定义 Provider 模型发现
//
//   文件:       customProviderModelDiscovery.ts
//
//   日期:       2026年08月28日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'
import {
  providerModelDiscoverySchema,
  type ProviderModelDiscovery,
} from '@geo-agent-platform/shared-types'

import {
  assertCustomProviderBaseUrl,
  createProviderDnsResolver,
} from './providerEndpointPolicy.js'
import {
  BoundedDnsLookupCache,
  OpenAIProviderTransport,
  type OpenAIClientTransport,
} from './providers/openaiTransport.js'

const DISCOVERY_TIMEOUT_MS = 10_000
const DISCOVERY_RESPONSE_MAX_BYTES = 512 * 1_024
const DISCOVERY_RESULT_MAX_MODELS = 200

const modelsResponseSchema = z.object({
  data: z.array(z.object({
    id: z.string().trim().min(1).max(200),
    owned_by: z.string().trim().min(1).max(200).nullable().optional(),
  }).passthrough()).max(10_000),
}).passthrough()

export interface CustomProviderModelDiscoveryInput {
  baseUrl: string
  apiKey: string
}

export interface CustomProviderModelDiscoveryDependencies {
  createTransport?: (baseUrl: string) => OpenAIClientTransport
  now?: () => number
}

export interface CustomProviderConnectionProbe {
  latencyMs: number
  testedAt: string
}

/**
 * 只验证目标地址是否能建立 HTTP 连接；401、404 等远端响应同样证明服务可达。
 * 模型目录格式与模型调用能力由另外两个测试模式独立判断。
 */
export async function probeCustomProviderConnection(
  input: CustomProviderModelDiscoveryInput,
  dependencies: CustomProviderModelDiscoveryDependencies = {},
): Promise<CustomProviderConnectionProbe> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const transport = createTransport(baseUrl, dependencies)
  const now = dependencies.now ?? Date.now
  const startedAt = now()
  try {
    const response = await transport.fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })
    await response.body?.cancel().catch(() => undefined)
    const completedAt = now()
    return {
      latencyMs: elapsedMilliseconds(startedAt, completedAt),
      testedAt: new Date(completedAt).toISOString(),
    }
  } catch (error) {
    if (isAbortError(error)) throw new Error('模型服务连通测试超时，请检查服务地址和网络。')
    if (isEndpointPolicyError(error)) throw error
    throw new Error('无法连接模型服务，请检查地址、网络和服务状态。')
  } finally {
    await transport.close().catch(() => undefined)
  }
}

/**
 * 通过 OpenAI-compatible `/models` 边界读取模型目录。
 * 用户明确填写的 HTTP/HTTPS 地址不限制网络范围；响应体仍有资源上限，
 * 错误不会包含远端响应正文或凭据。
 */
export async function discoverCustomProviderModels(
  input: CustomProviderModelDiscoveryInput,
  dependencies: CustomProviderModelDiscoveryDependencies = {},
): Promise<ProviderModelDiscovery> {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const transport = createTransport(baseUrl, dependencies)
  const now = dependencies.now ?? Date.now
  const startedAt = now()

  try {
    const response = await transport.fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })
    if (!response.ok) throw discoveryHttpError(response.status)

    const raw = JSON.parse(await readBoundedResponseText(response, DISCOVERY_RESPONSE_MAX_BYTES))
    const parsed = modelsResponseSchema.safeParse(raw)
    if (!parsed.success) throw new ModelDiscoveryError('模型服务返回的模型目录格式无效。')

    const unique = new Map<string, string | null>()
    for (const item of parsed.data.data) {
      if (!unique.has(item.id)) unique.set(item.id, item.owned_by ?? null)
      if (unique.size >= DISCOVERY_RESULT_MAX_MODELS) break
    }
    if (!unique.size) throw new ModelDiscoveryError('模型服务没有返回可用模型。')

    const completedAt = now()
    return providerModelDiscoverySchema.parse({
      models: [...unique].map(([modelId, ownedBy]) => ({ modelId, ownedBy })),
      latencyMs: elapsedMilliseconds(startedAt, completedAt),
      testedAt: new Date(completedAt).toISOString(),
    })
  } catch (error) {
    if (error instanceof ModelDiscoveryError) throw error
    if (isAbortError(error)) throw new Error('模型发现超时，请检查服务地址和网络。')
    if (error instanceof SyntaxError) throw new Error('模型服务返回的模型目录不是有效 JSON。')
    if (isEndpointPolicyError(error)) throw error
    throw new Error('无法连接模型服务，请检查地址、网络和服务状态。')
  } finally {
    await transport.close().catch(() => undefined)
  }
}

function normalizeBaseUrl(input: string): string {
  return assertCustomProviderBaseUrl(input).toString().replace(/\/$/u, '')
}

function createTransport(
  baseUrl: string,
  dependencies: CustomProviderModelDiscoveryDependencies,
): OpenAIClientTransport {
  return dependencies.createTransport?.(baseUrl)
    ?? new OpenAIProviderTransport(baseUrl, {
      dnsStrategy: 'guarded',
      dnsCache: new BoundedDnsLookupCache({ resolver: createProviderDnsResolver() }),
    })
}

class ModelDiscoveryError extends Error {}

function discoveryHttpError(status: number): ModelDiscoveryError {
  if (status === 401 || status === 403) {
    return new ModelDiscoveryError(`API Key 无效或无权列出模型（HTTP ${status}）。`)
  }
  if (status === 404) {
    return new ModelDiscoveryError('该端点没有提供 OpenAI-compatible /models 接口（HTTP 404）。')
  }
  if (status === 429) return new ModelDiscoveryError('模型服务正在限流（HTTP 429），请稍后重试。')
  return new ModelDiscoveryError(`模型发现失败（HTTP ${status}）。`)
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new ModelDiscoveryError('模型目录响应超过 512 KiB 安全上限。')
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ModelDiscoveryError('模型目录响应超过 512 KiB 安全上限。')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

function elapsedMilliseconds(startedAt: number, completedAt: number): number {
  return Math.round(Math.max(0, completedAt - startedAt) * 100) / 100
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function isEndpointPolicyError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.startsWith('自定义 Provider')
    || error.message.startsWith('本机 Provider')
    || error.message.startsWith('OpenAI 兼容 transport')
  )
}

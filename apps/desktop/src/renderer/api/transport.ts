// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面 Renderer 传输门面
//
//   文件:       transport.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-07-29):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 网络与文件上传所有权迁入 Electron Main，Renderer 仅调用窄 IPC。
// --------------------------------------------------------------------------

// 模块职责
//
// 统一投影 HTTP、句柄式 multipart、WebSocket 控制命令和协议校验。
// 真实网络连接由 Electron Main 持有，业务 API 只描述资源语义。

import {
  wsCommandContract,
  wsControlFailureCodeSchema,
  type WsCommandPayload,
  type WsCommandResponse,
  type WsControlCommand,
} from '@geo-agent-platform/shared-types'
import {
  PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME,
} from '@geo-agent-platform/shared-types/product-identity'

import type {
  DesktopAuthProjection,
  DesktopControlResponse,
  DesktopFileSelectionHandle,
} from '../../contracts/desktopIpc'
import { wsClient } from '../ws/client'
import {
  API_UNAVAILABLE_MESSAGE,
  formatApiError,
  PlatformTransportError,
  isApiUnavailableMessage,
} from './errors'

export interface SchemaParseError {
  issues: Array<{ path: PropertyKey[]; message: string }>
}

export type ResponseSchema<T> = {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: SchemaParseError }
}

export interface DesktopUploadBody {
  fields: Array<{ name: string; value: string }>
  files: Array<{
    fieldName: string
    file: DesktopFileSelectionHandle
  }>
}

export function formatSchemaValidationError(context: string, issues: SchemaParseError['issues']): string {
  const detail = issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length ? issue.path.map(part => String(part)).join('.') : '(根)'
      return `${path}: ${issue.message}`
    })
    .join('；')
  return `服务响应格式不符合平台协议（${context}）：${detail}`
}

// Renderer 只能通过受控资源协议引用图片、瓦片和下载目标；真实 API 地址和
// 认证 Cookie 均由 Electron Main 持有。
export const apiBaseUrl = `${PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME}://api`

export function setAuthProjection(auth: DesktopAuthProjection | null) {
  wsClient.setAuthContext(auth?.user.userId ?? null)
}

// 错误消息格式化
//
// 把网络层异常和后端 detail 统一整理成前端可直接展示的中文提示。
export function formatApiErrorMessage(prefix: string, detail?: string) {
  return formatApiError(prefix, detail)
}

export async function requestJson<T>(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  schema: ResponseSchema<T>,
): Promise<T> {
  // 通用 JSON 请求入口 — 每个调用必须提供对应的 Zod schema，
  // 防止后端协议变更时字段缺失或类型错误穿透到业务层。
  let response: Response
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = new Headers(init?.headers ?? {})
    if (init?.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    const bridge = requireDesktopBridge()
    const body = normalizeDesktopBody(init?.body)
    const desktopResponse = await Promise.race([
      bridge.api.request({
        method: normalizeDesktopMethod(init?.method),
        path,
        body,
        headers: pickDesktopHeaders(headers),
      }),
      aborted(controller.signal),
    ])
    response = new Response(desktopResponse.body, {
      status: desktopResponse.status,
      headers: desktopResponse.headers,
    })
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new PlatformTransportError(
        formatApiErrorMessage(`请求超时（${path}），请检查 API 服务是否响应正常。`, detail),
        { transport: 'http', code: 'timeout', cause: error },
      )
    }
    throw new PlatformTransportError(
      formatApiErrorMessage(`暂时无法连接分析服务，请确认本地 API 已启动（接口：${path}，传输：Electron Main）`, detail),
      { transport: 'http', code: 'unavailable', cause: error },
    )
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw await httpResponseError(response)
  }

  const data = await response.json()

  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    throw new Error(formatSchemaValidationError(`HTTP ${path}`, parsed.error.issues))
  }
  return parsed.data
}

export async function requestFormJson<T>(
  path: string,
  body: DesktopUploadBody,
  failurePrefix: string,
  timeoutMs: number,
  schema: ResponseSchema<T>,
): Promise<T> {
  // 句柄背书的 multipart 请求同样走统一超时和错误提取。
  //
  // 图层上传、后台导入和数据替换都可能传较大文件；这里不给它们另起一套
  // 网络语义，避免图层管理在端口/代理异常时只抛出浏览器原始 TypeError。
  let response: Response
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const bridge = requireDesktopBridge()
    const desktopResponse = await Promise.race([
      bridge.api.upload({
        path,
        fields: body.fields,
        files: body.files.map(({ fieldName, file }) => ({
          fieldName,
          handleId: file.handleId,
          fileName: file.name,
          mediaType: file.mediaType,
        })),
        headers: {},
      }),
      aborted(controller.signal),
    ])
    response = new Response(desktopResponse.body, {
      status: desktopResponse.status,
      headers: desktopResponse.headers,
    })
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new PlatformTransportError(
        formatApiErrorMessage(`${failurePrefix}超时（接口：${path}）。`, detail),
        { transport: 'http', code: 'timeout', cause: error },
      )
    }
    throw new PlatformTransportError(
      formatApiErrorMessage(`${failurePrefix}，请确认本地 API 已启动（接口：${path}，传输：Electron Main）`, detail),
      { transport: 'http', code: 'unavailable', cause: error },
    )
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw await httpResponseError(response)
  }

  const data: unknown = await response.json()
  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    throw new Error(formatSchemaValidationError(`HTTP ${path}`, parsed.error.issues))
  }
  return parsed.data
}

// 业务控制命令统一走 /ws；响应必须是具有关联请求 ID 的成功/错误 envelope。
//
// 命令 key 直接选择 shared-types 中的 payload/response schema，
// 校验通过后才返回，失败时抛出稳定中文协议错误。
export async function requestControl<K extends WsControlCommand>(
  type: K,
  payload?: WsCommandPayload<K>,
): Promise<WsCommandResponse<K>> {
  const contract = wsCommandContract(type)
  const payloadValue = payload ?? {}
  const parsedPayload = contract.payload.safeParse(payloadValue)
  if (!parsedPayload.success) {
    throw new Error(formatSchemaValidationError(`WS ${type} 请求`, parsedPayload.error.issues))
  }
  let response: DesktopControlResponse
  try {
    const bridge = requireDesktopBridge()
    response = await bridge.control.request({
      version: 1,
      requestId: crypto.randomUUID(),
      command: type,
      payload: payloadValue,
    })
    if (!response.ok) {
      if (!response.error) {
        throw new PlatformTransportError(
          `WebSocket 命令 ${type} 返回了缺少错误详情的无效控制响应。`,
          { transport: 'websocket', code: 'protocol_error' },
        )
      }
      const parsedErrorCode = wsControlFailureCodeSchema.safeParse(response.error.code)
      if (!parsedErrorCode.success) {
        throw new PlatformTransportError(
          `WebSocket 命令 ${type} 返回了未知错误代码。`,
          { transport: 'websocket', code: 'protocol_error' },
        )
      }
      throw new PlatformTransportError(response.error.message, {
        transport: 'websocket',
        code: parsedErrorCode.data,
      })
    }
  } catch (error) {
    if (error instanceof PlatformTransportError) throw error
    throw new PlatformTransportError(
      formatApiErrorMessage(`WebSocket 命令 ${type} 发送失败。`, error instanceof Error ? error.message : String(error)),
      { transport: 'websocket', code: 'unavailable', cause: error },
    )
  }
  const data = response.data

  const parsed = contract.response.safeParse(data)
  if (!parsed.success) {
    throw new Error(formatSchemaValidationError(`WS ${type}`, parsed.error.issues))
  }
  return parsed.data as WsCommandResponse<K>
}

async function extractErrorDetail(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      const payload = (await response.json()) as { detail?: unknown; error?: unknown; message?: unknown }
      const detail = payload.detail ?? payload.error ?? payload.message
      if (typeof detail === 'string' && detail.trim()) {
        return detail
      }
      if (Array.isArray(detail)) {
        return detail.map((item) => String(item)).join('；')
      }
      return JSON.stringify(payload)
    } catch {
      return response.statusText || `HTTP ${response.status}`
    }
  }

  const text = await response.text()
  return text.trim() || response.statusText || `HTTP ${response.status}`
}

async function httpResponseError(response: Response): Promise<PlatformTransportError> {
  const detail = await extractErrorDetail(response)
  const message = formatHttpError(response, detail)
  return new PlatformTransportError(message, {
    transport: 'http',
    code: httpStatusCode(response.status),
    status: response.status,
  })
}

function formatHttpError(response: Response, detail: string): string {
  if (response.status === 502 || response.status === 503 || isApiUnavailableMessage(detail)) {
    return API_UNAVAILABLE_MESSAGE
  }
  return detail
}

function httpStatusCode(status: number): string {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status === 502 || status === 503) return 'unavailable'
  return status >= 500 ? 'internal_error' : 'invalid_request'
}

export function requestDesktopDownload(
  path: string,
  suggestedName: string,
) {
  return requireDesktopBridge().api.download({ path, suggestedName })
}

export function requestDesktopOpen(
  path: string,
  suggestedName: string,
) {
  return requireDesktopBridge().api.open({ path, suggestedName })
}

function desktopBridge() {
  return typeof window === 'undefined' ? undefined : window.platformDesktop
}

export function requireDesktopBridge() {
  const bridge = desktopBridge()
  if (!bridge) throw new Error('产品界面只能在 Electron 桌面应用中运行。')
  return bridge
}

function normalizeDesktopBody(body: BodyInit | null | undefined): string | null {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') return body
  throw new Error('桌面 JSON 数据面不接受二进制或流式请求体，请使用文件上传边界。')
}

function normalizeDesktopMethod(method: string | undefined): 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' {
  const normalized = (method ?? 'GET').toUpperCase()
  if (
    normalized === 'GET'
    || normalized === 'POST'
    || normalized === 'PUT'
    || normalized === 'PATCH'
    || normalized === 'DELETE'
  ) {
    return normalized
  }
  throw new Error(`桌面 API 不支持 HTTP 方法 ${normalized}。`)
}

function pickDesktopHeaders(headers: Headers): Partial<Record<'accept' | 'content-type', string>> {
  const selected: Partial<Record<'accept' | 'content-type', string>> = {}
  for (const name of ['accept', 'content-type'] as const) {
    const value = headers.get(name)
    if (value) selected[name] = value
  }
  return selected
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new DOMException('请求已取消。', 'AbortError'))
      return
    }
    signal.addEventListener(
      'abort',
      () => reject(new DOMException('请求已取消。', 'AbortError')),
      { once: true },
    )
  })
}

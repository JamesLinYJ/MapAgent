// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 进程内认证客户端
//
//   文件:       desktopAuthClient.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { PLATFORM_DESKTOP_APP_ORIGIN } from '@geo-agent-platform/shared-types/product-identity'

import { readBoundedResponseText } from './boundedResponseBody.js'

const AUTH_RESPONSE_MAX_BYTES = 1024 * 1024
const AUTH_REQUEST_TIMEOUT_MS = 30_000

export interface DesktopAuthOperationResult {
  data: unknown
  error: null | {
    message?: string
    statusText: string
  }
}

export interface DesktopAuthClientPort {
  getCookie(): string
  signIn: {
    email(input: { email: string; password: string }): Promise<DesktopAuthOperationResult>
  }
  signUp: {
    email(input: { name: string; email: string; password: string }): Promise<DesktopAuthOperationResult>
  }
  signOut(): Promise<DesktopAuthOperationResult>
}

export type DesktopAuthFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>

/**
 * 只在 Electron Main 内存中维护认证 Cookie。实现直接调用 Better Auth 的公开
 * HTTP 端点，不加载 Electron 系统安全存储适配器，不访问钥匙串或用户配置。
 */
export class InMemoryDesktopAuthClient implements DesktopAuthClientPort {
  private readonly cookies = new Map<string, string>()

  readonly signIn = {
    email: (input: { email: string; password: string }) => (
      this.request('/api/auth/sign-in/email', input)
    ),
  }

  readonly signUp = {
    email: (input: { name: string; email: string; password: string }) => (
      this.request('/api/auth/sign-up/email', input)
    ),
  }

  constructor(
    private readonly apiBaseUrl: string,
    private readonly fetchApi: DesktopAuthFetch,
  ) {}

  getCookie(): string {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
  }

  async signOut(): Promise<DesktopAuthOperationResult> {
    const result = await this.request('/api/auth/sign-out', {})
    if (!result.error) this.cookies.clear()
    return result
  }

  private async request(
    pathname: string,
    body: Record<string, string>,
  ): Promise<DesktopAuthOperationResult> {
    const headers = new Headers({
      accept: 'application/json',
      'content-type': 'application/json',
      origin: PLATFORM_DESKTOP_APP_ORIGIN,
    })
    const cookie = this.getCookie()
    if (cookie) headers.set('cookie', cookie)
    const response = await this.fetchApi(
      new URL(pathname, `${this.apiBaseUrl}/`).toString(),
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
      },
    )
    const text = await readBoundedResponseText(response, AUTH_RESPONSE_MAX_BYTES, '认证响应')
    const data = parseJsonBody(text)
    if (!response.ok) {
      return {
        data: null,
        error: {
          message: responseErrorMessage(data),
          statusText: response.statusText || `HTTP ${response.status}`,
        },
      }
    }
    this.applySetCookies(response.headers)
    return { data, error: null }
  }

  private applySetCookies(headers: Headers): void {
    const values = headers.getSetCookie()
    const setCookies = values.length ? values : fallbackSetCookie(headers)
    for (const value of setCookies) {
      const pair = value.split(';', 1)[0]
      if (!pair) continue
      const separator = pair.indexOf('=')
      if (separator <= 0) continue
      const name = pair.slice(0, separator).trim()
      const cookieValue = pair.slice(separator + 1).trim()
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) continue
      if (cookieValue) this.cookies.set(name, cookieValue)
      else this.cookies.delete(name)
    }
  }
}

function fallbackSetCookie(headers: Headers): string[] {
  const value = headers.get('set-cookie')
  return value ? [value] : []
}

function parseJsonBody(text: string): unknown {
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function responseErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  for (const candidate of [
    'message' in value ? value.message : undefined,
    'detail' in value ? value.detail : undefined,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 500)
  }
  if ('error' in value && value.error && typeof value.error === 'object' && !Array.isArray(value.error)) {
    const candidate = 'message' in value.error ? value.error.message : undefined
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 500)
  }
  return undefined
}

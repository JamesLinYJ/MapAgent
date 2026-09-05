// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 可信应用位置判定
//
//   文件:       trustedApplicationLocation.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  PLATFORM_DESKTOP_PROTOCOL_SCHEME,
} from '@geo-agent-platform/shared-types/product-identity'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

/**
 * 可信来源必须按解析后的协议、主机和端口精确匹配。字符串前缀不能作为
 * 安全边界，否则 `geo-agent-platform://app.evil` 或相似开发域名会被错误接受。
 */
export function isTrustedApplicationUrl(
  value: string,
  developmentUrl = process.env.ELECTRON_RENDERER_URL,
): boolean {
  const candidate = parseCredentialFreeUrl(value)
  if (!candidate) return false
  if (
    candidate.protocol === `${PLATFORM_DESKTOP_PROTOCOL_SCHEME}:`
    && candidate.hostname === 'app'
    && candidate.port === ''
  ) {
    return true
  }

  const development = parseTrustedDevelopmentRendererUrl(developmentUrl)
  if (!development) return false
  return candidate.protocol === development.protocol
    && candidate.hostname === development.hostname
    && candidate.port === development.port
}

export function isTrustedDevelopmentRendererUrl(value?: string): boolean {
  return parseTrustedDevelopmentRendererUrl(value) !== null
}

function parseTrustedDevelopmentRendererUrl(value?: string): URL | null {
  const url = parseCredentialFreeUrl(value)
  if (
    !url
    || !['http:', 'https:'].includes(url.protocol)
    || !LOOPBACK_HOSTS.has(url.hostname)
  ) {
    return null
  }
  return url
}

function parseCredentialFreeUrl(value?: string): URL | null {
  if (!value?.trim()) return null
  try {
    const url = new URL(value)
    return url.username || url.password ? null : url
  } catch {
    return null
  }
}

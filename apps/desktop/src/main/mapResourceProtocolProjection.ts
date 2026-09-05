// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面地图资源协议投影
//
//   文件:       mapResourceProtocolProjection.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mapTileJsonSchema, type MapTileJson } from '@geo-agent-platform/shared-types'
import {
  PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME,
} from '@geo-agent-platform/shared-types/product-identity'

const API_RESOURCE_PATH = /^\/api\/v1\/(?:map|results|artifacts)\//u

export interface DesktopApiResourceProjection {
  targetPath: string
}

/**
 * 资源协议只收窄到既有数据面和固定 API 主机。具体路由及查询参数由 Server
 * 的权威 schema 校验，桌面端不再维护一份容易漂移的业务路由门禁。
 */
export function projectDesktopApiResourceRequest(
  url: URL,
): DesktopApiResourceProjection | null {
  if (url.username || url.password || url.hash) return null
  const pathname = safeDecodePath(url.pathname)
  if (!pathname || !API_RESOURCE_PATH.test(pathname)) return null

  return {
    targetPath: `${pathname}${url.search}`,
  }
}

/**
 * TileJSON 是服务器事实的传输投影。共享契约仍保存相对地址，只有交给
 * MapLibre 的响应使用受控桌面协议，避免相对地址退回窗口协议。
 */
export function projectMapTileJsonForDesktop(payload: unknown): MapTileJson | null {
  const parsed = mapTileJsonSchema.safeParse(payload)
  if (!parsed.success) return null
  const canonical = parsed.data
  return {
    ...canonical,
    tiles: canonical.tiles.map(
      tileUrl => `${PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME}://api${tileUrl}`,
    ),
  }
}

function safeDecodePath(pathname: string): string | null {
  try {
    const decoded = decodeURIComponent(pathname)
    if (
      decoded.includes('\0')
      || decoded.includes('\\')
      || /(^|\/)\.\.?($|\/)/u.test(decoded)
    ) {
      return null
    }
    return decoded
  } catch {
    return null
  }
}

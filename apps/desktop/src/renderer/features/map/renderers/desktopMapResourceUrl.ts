// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面地图资源地址适配器
//
//   文件:       desktopMapResourceUrl.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME,
} from '@geo-agent-platform/shared-types/product-identity'

const CONTROLLED_MAP_RESOURCE_PATH = /^\/api\/v1\/(?:map|results|artifacts)\//u

/**
 * 业务契约始终保存服务器相对地址；仅在交给 MapLibre 时投影为 Main 进程
 * 托管的资源协议，避免把桌面协议反写进共享 schema 或数据库事实。
 */
export function desktopMapResourceUrl(relativeUrl: string): string {
  if (!CONTROLLED_MAP_RESOURCE_PATH.test(relativeUrl)) {
    throw new Error(`地图资源地址不在桌面受控范围内：${relativeUrl}`)
  }
  return `${PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME}://api${relativeUrl}`
}

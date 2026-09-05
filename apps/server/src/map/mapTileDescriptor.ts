// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图瓦片描述器
//
//   文件:       mapTileDescriptor.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { MapLayerManifest } from '../schemas/types.js'

export const AUTHENTICATED_TILE_CACHE_CONTROL = 'private, max-age=31536000, immutable'

/**
 * 瓦片 URL 绑定数据版本。数据更新会生成新 URL，静态版本则可由浏览器长期缓存。
 */
export function buildTileJson(manifest: MapLayerManifest, tileUrl: string) {
  const separator = tileUrl.includes('?') ? '&' : '?'
  return {
    tilejson: '3.0.0' as const,
    name: manifest.title,
    tiles: [`${tileUrl}${separator}v=${manifest.dataVersion}`],
    minzoom: manifest.minZoom,
    maxzoom: manifest.maxZoom,
    bounds: manifest.bounds,
    ...(manifest.source.kind === 'vector_tiles' ? { vector_layers: [{ id: manifest.source.sourceLayer }] } : {}),
  }
}

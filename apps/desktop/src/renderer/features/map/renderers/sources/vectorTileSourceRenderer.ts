// +-------------------------------------------------------------------------
//
//   地理智能平台 - 矢量瓦片数据源渲染器
//
//   文件:       vectorTileSourceRenderer.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { defineSourceRenderer } from '../rendererTypes'
import { desktopMapResourceUrl } from '../desktopMapResourceUrl'

export const vectorTileSourceRenderer = defineSourceRenderer('vector_tiles', (map, id, source) => {
  map.addSource(id, { type: 'vector', url: desktopMapResourceUrl(source.tileJsonUrl) })
})
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 矢量瓦片数据源渲染器
//
//   文件:       vectorTileSourceRenderer.ts
// --------------------------------------------------------------------------

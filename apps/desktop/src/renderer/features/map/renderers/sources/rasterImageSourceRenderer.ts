// +-------------------------------------------------------------------------
//
//   地理智能平台 - 栅格图片数据源渲染器
//
//   文件:       rasterImageSourceRenderer.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { defineSourceRenderer } from '../rendererTypes'
import { desktopMapResourceUrl } from '../desktopMapResourceUrl'

export const rasterImageSourceRenderer = defineSourceRenderer('raster_image', (map, id, source) => {
  map.addSource(id, {
    type: 'image',
    url: desktopMapResourceUrl(source.url),
    coordinates: source.coordinates,
  })
})
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 栅格图片数据源渲染器
//
//   文件:       rasterImageSourceRenderer.ts
// --------------------------------------------------------------------------

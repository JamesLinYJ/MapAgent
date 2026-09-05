// +-------------------------------------------------------------------------
//
//   地理智能平台 - 栅格样式渲染器
//
//   文件:       rasterStyleRenderers.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { MapStyleRenderer } from '../rendererTypes'
import { defineStyleRenderer } from '../rendererTypes'
import { effectiveOpacity, layerBase } from './styleUtils'

function addRasterLayer(context: Parameters<MapStyleRenderer['add']>[0]): void {
  if (context.source.kind !== 'raster_image' && context.source.kind !== 'raster_tiles') {
    throw new Error(`${context.style.kind} 样式需要栅格图片或栅格瓦片数据源`)
  }
  context.map.addLayer({
    id: `${context.id}-raster`,
    type: 'raster',
    ...layerBase(context),
    paint: {
      'raster-opacity': effectiveOpacity(context),
      'raster-fade-duration': 120,
    },
  })
}

export const rasterStyleRenderers: MapStyleRenderer[] = [
  defineStyleRenderer('continuous_raster', addRasterLayer),
  defineStyleRenderer('categorical_raster', addRasterLayer),
]
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 栅格样式渲染器
//
//   文件:       rasterStyleRenderers.ts
// --------------------------------------------------------------------------

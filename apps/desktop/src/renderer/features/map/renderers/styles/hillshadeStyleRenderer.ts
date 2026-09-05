// +-------------------------------------------------------------------------
//
//   地理智能平台 - 山影样式渲染器
//
//   文件:       hillshadeStyleRenderer.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { defineStyleRenderer } from '../rendererTypes'
import { layerBase } from './styleUtils'

export const hillshadeStyleRenderer = defineStyleRenderer('hillshade', context => {
  if (context.source.kind !== 'raster_dem') throw new Error('山影样式只能用于 DEM 数据源')
  context.map.addLayer({
    id: `${context.id}-hillshade`,
    type: 'hillshade',
    ...layerBase(context),
    paint: {
      'hillshade-exaggeration': context.style.exaggeration,
      'hillshade-shadow-color': context.style.shadowColor,
      'hillshade-highlight-color': context.style.highlightColor,
      'hillshade-accent-color': context.style.accentColor,
    },
  })
})
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 山影样式渲染器
//
//   文件:       hillshadeStyleRenderer.ts
// --------------------------------------------------------------------------

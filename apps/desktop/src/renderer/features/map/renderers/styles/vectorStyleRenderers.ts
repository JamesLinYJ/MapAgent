// +-------------------------------------------------------------------------
//
//   地理智能平台 - 矢量样式渲染器
//
//   文件:       vectorStyleRenderers.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { MapStyleRenderer } from '../rendererTypes'
import { defineStyleRenderer } from '../rendererTypes'
import { addVectorLabel } from './labelRenderer'
import {
  categoricalColor,
  effectiveOpacity,
  interpolateHeatmapStops,
  layerBase,
} from './styleUtils'

const pointRenderer = defineStyleRenderer('point', context => {
  const { style } = context
  context.map.addLayer({
    id: `${context.id}-point`,
    type: 'circle',
    ...layerBase(context),
    paint: {
      'circle-color': categoricalColor(style, style.color),
      'circle-radius': context.selected ? style.radius + 2 : style.radius,
      'circle-opacity': effectiveOpacity(context),
      'circle-stroke-color': style.strokeColor,
      'circle-stroke-width': context.selected ? style.strokeWidth + 1 : style.strokeWidth,
    },
  })
  addVectorLabel(context, style)
})

const lineRenderer = defineStyleRenderer('line', context => {
  const { style } = context
  context.map.addLayer({
    id: `${context.id}-line`,
    type: 'line',
    ...layerBase(context),
    paint: {
      'line-color': categoricalColor(style, style.color),
      'line-width': context.selected ? style.width + 1.5 : style.width,
      'line-opacity': effectiveOpacity(context),
      ...(style.dashArray ? { 'line-dasharray': style.dashArray } : {}),
    },
  })
  addVectorLabel(context, style)
})

const polygonRenderer = defineStyleRenderer('polygon', context => {
  const { style } = context
  const opacity = effectiveOpacity(context)
  context.map.addLayer({
    id: `${context.id}-fill`,
    type: 'fill',
    ...layerBase(context),
    paint: {
      'fill-color': categoricalColor(style, style.color),
      'fill-opacity': opacity,
    },
  })
  context.map.addLayer({
    id: `${context.id}-outline`,
    type: 'line',
    ...layerBase(context),
    paint: {
      'line-color': style.outlineColor,
      'line-width': context.selected ? style.outlineWidth + 1.5 : style.outlineWidth,
      'line-opacity': Math.min(1, opacity + 0.2),
    },
  })
  addVectorLabel(context, style)
})

const heatmapRenderer = defineStyleRenderer('heatmap', context => {
  const { style } = context
  context.map.addLayer({
    id: `${context.id}-heatmap`,
    type: 'heatmap',
    ...layerBase(context),
    paint: {
      'heatmap-radius': style.radius,
      'heatmap-intensity': style.intensity,
      'heatmap-opacity': effectiveOpacity(context),
      'heatmap-weight': style.field ? ['coalesce', ['to-number', ['get', style.field]], 0] : 1,
      'heatmap-color': interpolateHeatmapStops(style.colorStops),
    },
  })
})

const contourRenderer = defineStyleRenderer('contour', context => {
  const { style } = context
  context.map.addLayer({
    id: `${context.id}-contour`,
    type: 'line',
    ...layerBase(context),
    paint: {
      'line-color': style.color,
      'line-width': style.width,
      'line-opacity': effectiveOpacity(context),
    },
  })
  if (!style.label) return
  context.map.addLayer({
    id: `${context.id}-contour-label`,
    type: 'symbol',
    ...layerBase(context),
    layout: {
      visibility: context.visible && context.sceneOpacity > 0 ? 'visible' : 'none',
      'symbol-placement': 'line',
      'text-field': ['to-string', ['get', style.valueField]],
      'text-size': 11,
    },
    paint: {
      'text-color': style.color,
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.5,
    },
  })
})

export const vectorStyleRenderers: MapStyleRenderer[] = [
  pointRenderer,
  lineRenderer,
  polygonRenderer,
  heatmapRenderer,
  contourRenderer,
]
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 矢量样式渲染器
//
//   文件:       vectorStyleRenderers.ts
// --------------------------------------------------------------------------

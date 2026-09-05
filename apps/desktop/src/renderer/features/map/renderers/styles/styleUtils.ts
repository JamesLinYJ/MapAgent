// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图样式渲染公共语义
//
//   文件:       styleUtils.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec'
import type { MapLayerStyle } from '@geo-agent-platform/shared-types'
import type { MapStyleRenderContext } from '../rendererTypes'

export function layerBase(context: MapStyleRenderContext) {
  const sourceLayer = context.source.kind === 'vector_tiles' ? context.source.sourceLayer : undefined
  return {
    source: context.id,
    ...(sourceLayer ? { 'source-layer': sourceLayer } : {}),
    layout: { visibility: context.visible && context.sceneOpacity > 0 ? 'visible' : 'none' } as const,
  }
}

export function effectiveOpacity(context: MapStyleRenderContext): number {
  return context.sceneOpacity * ('opacity' in context.style ? context.style.opacity : 1)
}

export function categoricalColor(
  style: Extract<MapLayerStyle, { kind: 'point' | 'line' | 'polygon' }>,
  fallback: string,
): string | ExpressionSpecification {
  if (!style.colorField || !style.categories.length) return fallback
  const expression: unknown[] = ['match', ['get', style.colorField]]
  for (const category of style.categories) expression.push(category.value, category.color)
  expression.push(fallback)
  return expression as ExpressionSpecification
}

export function interpolateHeatmapStops(
  stops: Array<{ value: number; color: string }>,
): ExpressionSpecification {
  const expression: unknown[] = ['interpolate', ['linear'], ['heatmap-density']]
  const min = stops[0]?.value ?? 0
  const max = stops.at(-1)?.value ?? 1
  const span = max - min || 1
  for (const stop of stops) expression.push((stop.value - min) / span, stop.color)
  return expression as ExpressionSpecification
}
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图样式渲染公共语义
//
//   文件:       styleUtils.ts
// --------------------------------------------------------------------------

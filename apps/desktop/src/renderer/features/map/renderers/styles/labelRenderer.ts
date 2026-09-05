// +-------------------------------------------------------------------------
//
//   地理智能平台 - 矢量标注渲染器
//
//   文件:       labelRenderer.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec'
import type {
  MapLayerLabel,
  MapLayerSource,
  MapLayerStyle,
} from '@geo-agent-platform/shared-types'
import type { MapStyleRenderContext } from '../rendererTypes'

export function addVectorLabel(
  context: MapStyleRenderContext,
  style: Extract<MapLayerStyle, { kind: 'point' | 'line' | 'polygon' }>,
): void {
  if (!context.label) return
  if (context.source.kind !== 'geojson' && context.source.kind !== 'vector_tiles') {
    throw new Error('标注仅支持 GeoJSON 或矢量瓦片数据源')
  }
  context.map.addLayer(buildLabelLayerDefinition(
    context.id,
    context.source,
    style,
    context.label,
    context.visible,
    context.sceneOpacity,
  ))
}

export function buildLabelLayerDefinition(
  id: string,
  source: Extract<MapLayerSource, { kind: 'geojson' | 'vector_tiles' }>,
  style: Extract<MapLayerStyle, { kind: 'point' | 'line' | 'polygon' }>,
  label: MapLayerLabel,
  visible: boolean,
  sceneOpacity: number,
): LayerSpecification {
  const placement = label.placement === 'auto'
    ? (style.kind === 'line' ? 'line' : 'point')
    : label.placement
  return {
    id: `${id}-label`,
    type: 'symbol',
    source: id,
    ...(source.kind === 'vector_tiles' ? { 'source-layer': source.sourceLayer } : {}),
    layout: {
      visibility: visible && sceneOpacity > 0 ? 'visible' : 'none',
      'symbol-placement': placement,
      'text-field': ['to-string', ['get', label.field]],
      'text-size': label.size,
      'text-max-width': 12,
      'text-allow-overlap': false,
      'text-ignore-placement': false,
    },
    paint: {
      'text-color': label.color,
      'text-opacity': sceneOpacity,
      'text-halo-color': label.haloColor,
      'text-halo-width': label.haloWidth,
    },
  }
}
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 矢量标注渲染器
//
//   文件:       labelRenderer.ts
// --------------------------------------------------------------------------

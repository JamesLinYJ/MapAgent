// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图渲染器类型
//
//   文件:       rendererTypes.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  MapLayerLabel,
  MapLayerSource,
  MapLayerStyle,
} from '@geo-agent-platform/shared-types'
import type { Map as MapLibreMap } from 'maplibre-gl/dist/maplibre-gl-csp'

export type MapSourceKind = MapLayerSource['kind']
export type MapStyleKind = MapLayerStyle['kind']

export interface MapSourceRenderer {
  kind: MapSourceKind
  add: (map: MapLibreMap, id: string, source: MapLayerSource, style: MapLayerStyle) => void
}

export interface MapStyleRenderContext {
  map: MapLibreMap
  id: string
  source: MapLayerSource
  style: MapLayerStyle
  label: MapLayerLabel | null
  visible: boolean
  sceneOpacity: number
  selected: boolean
}

export interface MapStyleRenderer {
  kind: MapStyleKind
  add: (context: MapStyleRenderContext) => void
}

export function defineSourceRenderer<K extends MapSourceKind>(
  kind: K,
  add: (
    map: MapLibreMap,
    id: string,
    source: Extract<MapLayerSource, { kind: K }>,
    style: MapLayerStyle,
  ) => void,
): MapSourceRenderer {
  return {
    kind,
    add: (map, id, source, style) => {
      if (source.kind !== kind) throw new Error(`数据源渲染器 '${kind}' 收到不匹配的数据源 '${source.kind}'`)
      add(map, id, source as Extract<MapLayerSource, { kind: K }>, style)
    },
  }
}

export function defineStyleRenderer<K extends MapStyleKind>(
  kind: K,
  add: (context: MapStyleRenderContext & { style: Extract<MapLayerStyle, { kind: K }> }) => void,
): MapStyleRenderer {
  return {
    kind,
    add: context => {
      if (context.style.kind !== kind) {
        throw new Error(`样式渲染器 '${kind}' 收到不匹配的样式 '${context.style.kind}'`)
      }
      add({ ...context, style: context.style as Extract<MapLayerStyle, { kind: K }> })
    },
  }
}
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图渲染器类型
//
//   文件:       rendererTypes.ts
// --------------------------------------------------------------------------

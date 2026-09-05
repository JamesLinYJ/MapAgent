// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图图层渲染器注册表
//
//   文件:       MapLayerRendererRegistry.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { MapLayerSource, MapLayerStyle } from '@geo-agent-platform/shared-types'
import type { Map as MapLibreMap } from 'maplibre-gl/dist/maplibre-gl-csp'
import type {
  MapSourceRenderer,
  MapStyleRenderContext,
  MapStyleRenderer,
} from './rendererTypes'

/** MapLibre 渲染扩展点；注册完整性在构造时验证。 */
export class MapLayerRendererRegistry {
  readonly #sources: ReadonlyMap<MapLayerSource['kind'], MapSourceRenderer>
  readonly #styles: ReadonlyMap<MapLayerStyle['kind'], MapStyleRenderer>

  constructor(sourceRenderers: MapSourceRenderer[], styleRenderers: MapStyleRenderer[]) {
    this.#sources = createUniqueRegistry(sourceRenderers, '数据源')
    this.#styles = createUniqueRegistry(styleRenderers, '样式')
  }

  addSource(map: MapLibreMap, id: string, source: MapLayerSource, style: MapLayerStyle): void {
    const renderer = this.#sources.get(source.kind)
    if (!renderer) throw new Error(`未注册地图数据源渲染器：${source.kind}`)
    renderer.add(map, id, source, style)
  }

  addStyle(context: MapStyleRenderContext): void {
    const renderer = this.#styles.get(context.style.kind)
    if (!renderer) throw new Error(`未注册地图样式渲染器：${context.style.kind}`)
    renderer.add(context)
  }
}

function createUniqueRegistry<K extends string, T extends { kind: K }>(
  entries: T[],
  label: string,
): ReadonlyMap<K, T> {
  const registry = new Map<K, T>()
  for (const entry of entries) {
    if (registry.has(entry.kind)) throw new Error(`${label}渲染器重复注册：${entry.kind}`)
    registry.set(entry.kind, entry)
  }
  return registry
}
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图图层渲染器注册表
//
//   文件:       MapLayerRendererRegistry.ts
// --------------------------------------------------------------------------

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图渲染器注册表测试
//
//   文件:       mapRendererRegistry.test.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import type { Map as MapLibreMap } from 'maplibre-gl/dist/maplibre-gl-csp'
import type { MapLayerStyle } from '@geo-agent-platform/shared-types'
import { MapLayerRendererRegistry } from '../features/map/renderers/MapLayerRendererRegistry'
import type {
  MapSourceRenderer,
  MapStyleRenderer,
} from '../features/map/renderers/rendererTypes'

const geoJsonRenderer: MapSourceRenderer = {
  kind: 'geojson',
  add: vi.fn(),
}

const polygonRenderer: MapStyleRenderer = {
  kind: 'polygon',
  add: vi.fn(),
}

describe('MapLayerRendererRegistry', () => {
  it('dispatches source and style rendering through independent registries', () => {
    const registry = new MapLayerRendererRegistry([geoJsonRenderer], [polygonRenderer])
    const map = {} as unknown as MapLibreMap
    const source = { kind: 'geojson', url: '/layer.geojson', featureCount: 1, sizeBytes: 32 } as const
    const style: MapLayerStyle = {
      kind: 'polygon',
      opacity: 1,
      colorField: null,
      categories: [],
      color: '#228b6b',
      outlineColor: '#ffffff',
      outlineWidth: 1,
    }

    registry.addSource(map, 'districts', source, style)
    registry.addStyle({
      map,
      id: 'districts',
      source,
      style,
      label: null,
      visible: true,
      sceneOpacity: 1,
      selected: false,
    })

    expect(geoJsonRenderer.add).toHaveBeenCalledOnce()
    expect(polygonRenderer.add).toHaveBeenCalledOnce()
  })

  it('rejects duplicate renderer registration', () => {
    expect(() => new MapLayerRendererRegistry(
      [geoJsonRenderer, { ...geoJsonRenderer }],
      [polygonRenderer],
    )).toThrow('数据源渲染器重复注册：geojson')
  })

  it('fails explicitly when a source or style has no renderer', () => {
    const map = {} as unknown as MapLibreMap
    const source = { kind: 'geojson', url: '/layer.geojson', featureCount: 1, sizeBytes: 32 } as const
    const style: MapLayerStyle = {
      kind: 'polygon',
      opacity: 1,
      colorField: null,
      categories: [],
      color: '#228b6b',
      outlineColor: '#ffffff',
      outlineWidth: 1,
    }

    expect(() => new MapLayerRendererRegistry([], [polygonRenderer])
      .addSource(map, 'districts', source, style)).toThrow('未注册地图数据源渲染器：geojson')
    expect(() => new MapLayerRendererRegistry([geoJsonRenderer], [])
      .addStyle({
        map,
        id: 'districts',
        source,
        style,
        label: null,
        visible: true,
        sceneOpacity: 1,
        selected: false,
      })).toThrow('未注册地图样式渲染器：polygon')
  })
})

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图图层同步测试
//
//   文件:       mapCanvasLayerSync.test.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { Map as MapLibreMap } from 'maplibre-gl/dist/maplibre-gl-csp'
import {
  buildLabelLayerDefinition,
  sceneSourceId,
  syncSceneLayers,
} from '../features/map/MapCanvasLayerSync'
import { MapSourceReadinessTracker } from '../features/map/mapScreenshot'
import { MapLayerRendererRegistry } from '../features/map/renderers/MapLayerRendererRegistry'
import type { MapStyleRenderContext } from '../features/map/renderers/rendererTypes'
import { layerBase } from '../features/map/renderers/styles/styleUtils'
import type { SceneRenderLayer } from '../features/map/useMapScene'

describe('map label renderer', () => {
  it('builds a persisted vector label as a MapLibre symbol layer', () => {
    const layer = buildLabelLayerDefinition(
      'map-layer-districts',
      { kind: 'vector_tiles', tileJsonUrl: '/tilejson', sourceLayer: 'features' },
      {
        kind: 'polygon', opacity: 0.7, colorField: null, categories: [], color: '#2e9f7d',
        outlineColor: '#176c55', outlineWidth: 1,
      },
      {
        field: 'name', placement: 'auto', size: 13, color: '#17202a',
        haloColor: '#ffffff', haloWidth: 2,
      },
      true,
      0.8,
    )

    expect(layer.type).toBe('symbol')
    expect(layer).toMatchObject({
      source: 'map-layer-districts',
      'source-layer': 'features',
      layout: {
        visibility: 'visible',
        'symbol-placement': 'point',
        'text-field': ['to-string', ['get', 'name']],
        'text-size': 13,
      },
      paint: {
        'text-color': '#17202a',
        'text-opacity': 0.8,
        'text-halo-color': '#ffffff',
        'text-halo-width': 2,
      },
    })
  })

  it('makes even opacity-less MapLibre styles invisible when scene opacity is zero', () => {
    const context = {
      id: 'map-layer-dem',
      source: { kind: 'raster_dem' },
      visible: true,
      sceneOpacity: 0,
    } as unknown as MapStyleRenderContext

    expect(layerBase(context).layout.visibility).toBe('none')
    expect(buildLabelLayerDefinition(
      'map-layer-districts',
      { kind: 'geojson', url: '/districts.geojson', featureCount: 1, sizeBytes: 32 },
      {
        kind: 'polygon', opacity: 1, colorField: null, categories: [], color: '#2e9f7d',
        outlineColor: '#176c55', outlineWidth: 1,
      },
      {
        field: 'name', placement: 'auto', size: 13, color: '#17202a',
        haloColor: '#ffffff', haloWidth: 2,
      },
      true,
      0,
    ).layout?.visibility).toBe('none')
  })

  it('starts a new source generation only when source identity changes and removes stale state', () => {
    const sources = new Map<string, unknown>()
    const styleLayers: Array<{ id: string; source: string }> = []
    const map = {
      getSource: (id: string) => sources.get(id),
      addSource: (id: string, source: unknown) => { sources.set(id, source) },
      removeSource: (id: string) => { sources.delete(id) },
      getStyle: () => ({ layers: styleLayers }),
      getLayer: (id: string) => styleLayers.find(layer => layer.id === id),
      addLayer: (layer: { id: string; source: string }) => { styleLayers.push(layer) },
      removeLayer: (id: string) => {
        const index = styleLayers.findIndex(layer => layer.id === id)
        if (index >= 0) styleLayers.splice(index, 1)
      },
    } as unknown as MapLibreMap
    const registry = new MapLayerRendererRegistry([{
      kind: 'geojson',
      add: (target, id, source) => {
        if (source.kind !== 'geojson') throw new Error('unexpected source kind')
        target.addSource(id, { type: 'geojson', data: source.url })
      },
    }], [{
      kind: 'polygon',
      add: context => { context.map.addLayer({
        id: `${context.id}-fill`,
        type: 'fill',
        source: context.id,
      }) },
    }])
    const readiness = new MapSourceReadinessTracker()
    const layer = createSceneLayer('/first.geojson', 1)
    const sourceId = sceneSourceId(layer.manifest.mapLayerId)

    syncSceneLayers(map, [layer], undefined, registry, readiness)
    const generation1 = readiness.currentGeneration(sourceId)
    expect(generation1).toBe(1)

    syncSceneLayers(map, [{ ...layer, scene: { ...layer.scene, opacity: 0.4 } }], undefined, registry, readiness)
    expect(readiness.currentGeneration(sourceId)).toBe(generation1)

    syncSceneLayers(map, [createSceneLayer('/second.geojson', 1)], undefined, registry, readiness)
    expect(readiness.currentGeneration(sourceId)).toBe(2)

    syncSceneLayers(map, [], undefined, registry, readiness)
    expect(readiness.currentGeneration(sourceId)).toBeNull()
  })
})

function createSceneLayer(url: string, opacity: number): SceneRenderLayer {
  return {
    manifest: {
      mapLayerId: 'districts',
      status: 'ready',
      bounds: [100, 20, 110, 30],
      source: { kind: 'geojson', url, featureCount: 1, sizeBytes: 32 },
      style: {
        kind: 'polygon',
        opacity: 1,
        colorField: null,
        categories: [],
        color: '#228b6b',
        outlineColor: '#ffffff',
        outlineWidth: 1,
      },
    },
    scene: {
      visible: true,
      opacity,
      styleOverride: null,
      label: null,
      currentFrameId: null,
    },
  } as unknown as SceneRenderLayer
}

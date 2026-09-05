// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面地图资源边界测试
//
//   文件:       mapResourceBoundary.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { boundsFromCollection, buildBasemapStyle } from '../features/map/MapCanvasEngine'
import { desktopMapResourceUrl } from '../features/map/renderers/desktopMapResourceUrl'
import { DEFAULT_BASEMAP } from '../shared/constants'

describe('desktop map resource boundary', () => {
  it('routes the bootstrap basemap through the controlled Main-process protocol', () => {
    expect(DEFAULT_BASEMAP.tileUrls).toEqual([
      'geo-agent-platform-resource://api/api/v1/map/basemaps/tianditu-vector/tiles/vector/{z}/{x}/{y}',
    ])
    expect(DEFAULT_BASEMAP.labelTileUrls).toEqual([
      'geo-agent-platform-resource://api/api/v1/map/basemaps/tianditu-vector/tiles/labels/{z}/{x}/{y}',
    ])

    const style = buildBasemapStyle(DEFAULT_BASEMAP)
    expect(style.sources.basemap).toMatchObject({
      type: 'raster',
      tiles: DEFAULT_BASEMAP.tileUrls,
    })
    expect(style.sources.labels).toMatchObject({
      type: 'raster',
      tiles: DEFAULT_BASEMAP.labelTileUrls,
    })
    expect(style.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'basemap', paint: { 'raster-opacity': 1 } }),
      expect.objectContaining({ id: 'labels', paint: { 'raster-opacity': 1 } }),
    ]))
  })

  it('projects only validated relative API resources at the MapLibre boundary', () => {
    expect(desktopMapResourceUrl('/api/v1/map/layers/layer_1/tilejson')).toBe(
      'geo-agent-platform-resource://api/api/v1/map/layers/layer_1/tilejson',
    )
    expect(() => desktopMapResourceUrl('https://example.com/tilejson')).toThrow(
      '地图资源地址不在桌面受控范围内',
    )
  })

  it('computes fit bounds without loading the MapLibre runtime', () => {
    expect(boundsFromCollection({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [110, 30],
            [100, 20],
            [105, 28],
            [110, 30],
          ]],
        },
      }],
    })).toEqual([100, 20, 110, 30])
  })
})

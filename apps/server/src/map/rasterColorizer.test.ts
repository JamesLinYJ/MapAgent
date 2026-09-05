// +-------------------------------------------------------------------------
//
//   地理智能平台 - 栅格像素着色器测试
//
//   文件:       rasterColorizer.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { mapLayerSourceSchema, mapLayerStyleSchema } from '../schemas/types.js'
import { colorizeRaster } from './rasterColorizer.js'

describe('colorizeRaster', () => {
  it('interpolates continuous colors and preserves nodata transparency', () => {
    const pixels = colorizeRaster({
      values: new Float32Array([0, 5, 10, -9999]),
      width: 2,
      height: 2,
      source: mapLayerSourceSchema.parse({ kind: 'raster_tiles', tileJsonUrl: '/tiles.json', tileSize: 256 }),
      style: mapLayerStyleSchema.parse({
        kind: 'continuous_raster',
        rangeMode: 'custom',
        dataRange: [0, 10],
        renderRange: [0, 10],
        colorStops: [{ value: 0, color: '#000000' }, { value: 10, color: '#ffffff' }],
        opacity: 0.5,
      }),
      noData: -9999,
    })

    expect([...pixels.slice(0, 4)]).toEqual([0, 0, 0, 128])
    expect([...pixels.slice(4, 8)]).toEqual([128, 128, 128, 128])
    expect([...pixels.slice(8, 12)]).toEqual([255, 255, 255, 128])
    expect([...pixels.slice(12, 16)]).toEqual([0, 0, 0, 0])
  })

  it('uses exact numeric classes and leaves unknown values transparent', () => {
    const pixels = colorizeRaster({
      values: new Uint8Array([1, 2, 3]),
      width: 3,
      height: 1,
      source: mapLayerSourceSchema.parse({ kind: 'raster_tiles', tileJsonUrl: '/tiles.json', tileSize: 256 }),
      style: mapLayerStyleSchema.parse({
        kind: 'categorical_raster',
        categories: [
          { value: 1, label: '雨', color: '#0066cc' },
          { value: 2, label: '雪', color: '#ffffff80' },
        ],
        opacity: 1,
      }),
      noData: null,
    })

    expect([...pixels.slice(0, 4)]).toEqual([0, 102, 204, 255])
    expect([...pixels.slice(4, 8)]).toEqual([255, 255, 255, 128])
    expect([...pixels.slice(8, 12)]).toEqual([0, 0, 0, 0])
  })

  it('encodes elevation using the declared MapLibre DEM convention', () => {
    const mapbox = colorizeRaster({
      values: new Float32Array([100]),
      width: 1,
      height: 1,
      source: mapLayerSourceSchema.parse({
        kind: 'raster_dem',
        tileJsonUrl: '/tiles.json',
        encoding: 'mapbox',
        tileSize: 256,
      }),
      style: mapLayerStyleSchema.parse({ kind: 'hillshade' }),
      noData: null,
    })
    const encoded = mapbox[0] * 65_536 + mapbox[1] * 256 + mapbox[2]
    expect(-10_000 + encoded * 0.1).toBe(100)
    expect(mapbox[3]).toBe(255)

    const terrarium = colorizeRaster({
      values: new Float32Array([100.5]),
      width: 1,
      height: 1,
      source: mapLayerSourceSchema.parse({
        kind: 'raster_dem',
        tileJsonUrl: '/tiles.json',
        encoding: 'terrarium',
        tileSize: 256,
      }),
      style: mapLayerStyleSchema.parse({ kind: 'hillshade' }),
      noData: null,
    })
    expect(terrarium[0] * 256 + terrarium[1] + terrarium[2] / 256 - 32_768).toBe(100.5)
  })
})

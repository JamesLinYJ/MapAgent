// +-------------------------------------------------------------------------
//
//   地理智能平台 - GeoJSON CRS 规范化测试
//
//   文件:       geojsonCrs.test.ts
//
//   日期:       2026年08月09日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { GEOJSON_CRS84 } from './crs.js'
import { parseGeoJsonEntity, requireSingleFeature } from './geojson.js'
import { normalizeGeoJsonToCrs84, requireRenderableCrs84Bounds } from './geojsonCrs.js'

const WEB_MERCATOR_120E_30N = [13358338.895192828, 3503549.843504374] as const

describe('GeoJSON CRS contract', () => {
  it('rejects projected-looking coordinates without an explicit source CRS', () => {
    expect(() => parseGeoJsonEntity({
      type: 'Point',
      coordinates: WEB_MERCATOR_120E_30N,
    }, 'projected point')).toThrow('投影坐标必须显式声明 CRS')
  })

  it('reprojects EPSG:3857 to RFC 7946 longitude-latitude order', () => {
    const normalized = normalizeGeoJsonToCrs84({
      type: 'Feature',
      crs: 'EPSG:3857',
      properties: { name: '杭州' },
      geometry: { type: 'Point', coordinates: WEB_MERCATOR_120E_30N },
    })
    const point = requireSingleFeature(normalized.entity, 'point').geometry

    expect(normalized).toMatchObject({
      crs: GEOJSON_CRS84,
      sourceCrs: 'EPSG:3857',
      reprojected: true,
    })
    expect(point.type).toBe('Point')
    if (point.type !== 'Point') throw new Error('测试几何不是 Point')
    expect(point.coordinates[0]).toBeCloseTo(120, 9)
    expect(point.coordinates[1]).toBeCloseTo(30, 9)
    expect(normalized.bounds).toEqual([
      expect.closeTo(119.9999, 8),
      expect.closeTo(29.9999, 8),
      expect.closeTo(120.0001, 8),
      expect.closeTo(30.0001, 8),
    ])
  })

  it('treats EPSG:4326 and CRS:84 aliases as CRS84 with fixed [longitude, latitude] axis order', () => {
    for (const crs of [
      'EPSG:4326',
      'CRS:84',
      'OGC:CRS84',
      'urn:ogc:def:crs:OGC::CRS84',
      'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
    ]) {
      const normalized = normalizeGeoJsonToCrs84({
        type: 'Point',
        crs,
        coordinates: [120, 30, 88],
      })
      expect(normalized).toMatchObject({ crs: GEOJSON_CRS84, sourceCrs: GEOJSON_CRS84, reprojected: false })
      expect(requireSingleFeature(normalized.entity, 'point').geometry).toEqual({
        type: 'Point', coordinates: [120, 30, 88],
      })
    }

    expect(() => normalizeGeoJsonToCrs84({
      type: 'Point',
      crs: 'EPSG:4326',
      coordinates: [30, 120],
    })).toThrow('[经度, 纬度]')
  })

  it('reprojects GeometryCollection children and preserves third ordinates', () => {
    const normalized = normalizeGeoJsonToCrs84({
      type: 'GeometryCollection',
      crs: { type: 'name', properties: { name: 'EPSG:3857' } },
      geometries: [
        { type: 'Point', coordinates: [...WEB_MERCATOR_120E_30N, 123] },
        {
          type: 'LineString',
          coordinates: [
            [...WEB_MERCATOR_120E_30N, 10],
            [WEB_MERCATOR_120E_30N[0] + 1000, WEB_MERCATOR_120E_30N[1], 20],
          ],
        },
      ],
    })
    const collection = requireSingleFeature(normalized.entity, 'collection').geometry
    expect(collection.type).toBe('GeometryCollection')
    if (collection.type !== 'GeometryCollection') throw new Error('测试几何不是 GeometryCollection')
    expect(collection.geometries[0]).toMatchObject({ type: 'Point', coordinates: [expect.closeTo(120, 9), expect.closeTo(30, 9), 123] })
    expect(collection.geometries[1]).toMatchObject({
      type: 'LineString',
      coordinates: [
        [expect.closeTo(120, 9), expect.closeTo(30, 9), 10],
        [expect.any(Number), expect.closeTo(30, 9), 20],
      ],
    })
  })

  it('preserves RFC antimeridian bounds for analysis but hard-fails map publication', () => {
    const normalized = normalizeGeoJsonToCrs84({
      type: 'LineString',
      coordinates: [[179, 20], [-179, 20]],
    })
    expect(normalized.bounds).toEqual([179, 19.9999, -179, 20.0001])
    expect(() => requireRenderableCrs84Bounds(normalized.bounds, '跨反经线路线')).toThrow('跨越反经线')
  })

  it('rejects EPSG:3857 coordinates outside the projection domain', () => {
    expect(() => normalizeGeoJsonToCrs84({
      type: 'Point',
      crs: 'EPSG:3857',
      coordinates: [20_037_509, 0],
    })).toThrow('超出 EPSG:3857 有效范围')
  })

  it('accepts reproducible EPSG URN and OGC URL identifiers', () => {
    for (const crs of [
      'urn:ogc:def:crs:EPSG::3857',
      'http://www.opengis.net/def/crs/EPSG/0/3857',
    ]) {
      const normalized = normalizeGeoJsonToCrs84({
        type: 'Point', crs, coordinates: WEB_MERCATOR_120E_30N,
      })
      expect(normalized).toMatchObject({ sourceCrs: 'EPSG:3857', crs: 'OGC:CRS84' })
    }
  })

  it('derives bounds for large geometries without spreading the coordinate array', () => {
    const coordinates = Array.from({ length: 150_000 }, (_, index) => [
      120 + (index % 1_000) / 1_000_000,
      30 + (index % 100) / 1_000_000,
    ])
    const normalized = normalizeGeoJsonToCrs84({ type: 'LineString', coordinates })

    expect(normalized.bounds).toEqual([
      120,
      30,
      expect.closeTo(120.000999, 9),
      expect.closeTo(30.000099, 9),
    ])
  })
})

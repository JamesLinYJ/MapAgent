// +-------------------------------------------------------------------------
//
//   地理智能平台 - CRS 投影器测试
//
//   文件:       crs.test.ts
//
//   日期:       2026年08月09日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

const proj4Invocations = vi.hoisted(() => ({ count: 0 }))

vi.mock('proj4', async importOriginal => {
  const actual = await importOriginal<typeof import('proj4')>()
  const monitored = new Proxy(actual.default, {
    apply(target, thisArg, argumentsList) {
      proj4Invocations.count += 1
      return Reflect.apply(target, thisArg, argumentsList)
    },
  })
  return { ...actual, default: monitored }
})

import { normalizeGeoJsonToCrs84 } from './geojsonCrs.js'

const WEB_MERCATOR_120E_30N = [13358338.895192828, 3503549.843504374] as const

describe('CRS projection transformer', () => {
  it('builds one proj4 converter across every feature and coordinate in one normalization', () => {
    proj4Invocations.count = 0
    const normalized = normalizeGeoJsonToCrs84({
      type: 'FeatureCollection',
      crs: 'EPSG:3857',
      features: [
        {
          type: 'Feature',
          properties: { id: 1 },
          geometry: { type: 'Point', coordinates: [...WEB_MERCATOR_120E_30N, 8] },
        },
        {
          type: 'Feature',
          properties: { id: 2 },
          geometry: {
            type: 'GeometryCollection',
            geometries: [
              { type: 'Point', coordinates: WEB_MERCATOR_120E_30N },
              {
                type: 'LineString',
                coordinates: [
                  WEB_MERCATOR_120E_30N,
                  [WEB_MERCATOR_120E_30N[0] + 1_000, WEB_MERCATOR_120E_30N[1]],
                ],
              },
            ],
          },
        },
      ],
    })

    expect(proj4Invocations.count).toBe(1)
    expect(normalized.entity).toMatchObject({
      type: 'FeatureCollection',
      features: [
        { geometry: { type: 'Point', coordinates: [expect.closeTo(120, 9), expect.closeTo(30, 9), 8] } },
        {
          geometry: {
            type: 'GeometryCollection',
            geometries: [
              { type: 'Point', coordinates: [expect.closeTo(120, 9), expect.closeTo(30, 9)] },
              {
                type: 'LineString',
                coordinates: [
                  [expect.closeTo(120, 9), expect.closeTo(30, 9)],
                  [expect.any(Number), expect.closeTo(30, 9)],
                ],
              },
            ],
          },
        },
      ],
    })
  })
})

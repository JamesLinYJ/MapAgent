// +-------------------------------------------------------------------------
//
//   地理智能平台 - 空间分析 CRS 契约测试
//
//   文件:       spatialAnalysisCrs.test.ts
//
//   日期:       2026年08月09日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { ToolContext } from '../../framework/types.js'
import { GEOJSON_CRS84 } from '../../gis/crs.js'
import { createSpatialAnalysisTool } from './spatialAnalysis.js'

describe('spatial_analysis CRS boundary', () => {
  it('rejects projected coordinates that omit their CRS before Turf executes', async () => {
    await expect(createSpatialAnalysisTool().handler({
      operation: 'distance',
      units: 'meters',
      sourceGeojson: point([13358338.895192828, 3503549.843504374]),
      targetGeojson: point([13359452.090100735, 3503549.843504374]),
    }, runtime())).rejects.toThrow('投影坐标必须显式声明 CRS')
  })

  it('matches CRS84 geodesic distance after explicit EPSG:3857 reprojection', async () => {
    const tool = createSpatialAnalysisTool()
    const canonical = await tool.handler({
      operation: 'distance',
      units: 'meters',
      sourceGeojson: point([120, 30]),
      targetGeojson: point([120.01, 30]),
    }, runtime())
    const projected = await tool.handler({
      operation: 'distance',
      units: 'meters',
      sourceGeojson: projectedPoint(120, 30),
      targetGeojson: projectedPoint(120.01, 30),
    }, runtime())
    const expected = canonical.payload.distance as number
    const actual = projected.payload.distance as number

    expect(expected).toBeGreaterThan(962)
    expect(expected).toBeLessThan(964)
    expect(Math.abs(actual - expected)).toBeLessThan(0.001)
    expect(projected.provenance).toMatchObject({ coordinateCrs: GEOJSON_CRS84 })
  })

  it('matches CRS84 geodesic area after explicit EPSG:3857 reprojection', async () => {
    const tool = createSpatialAnalysisTool()
    const ring = [[120, 30], [120.01, 30], [120.01, 30.01], [120, 30.01], [120, 30]]
    const canonical = await tool.handler({
      operation: 'area',
      sourceGeojson: polygon(ring),
    }, runtime())
    const projected = await tool.handler({
      operation: 'area',
      sourceGeojson: {
        ...polygon(ring.map(([longitude, latitude]) => webMercator(longitude!, latitude!))),
        crs: 'EPSG:3857',
      },
    }, runtime())
    const expected = canonical.payload.areaSqm as number
    const actual = projected.payload.areaSqm as number

    expect(expected).toBeGreaterThan(1_070_000)
    expect(expected).toBeLessThan(1_075_000)
    expect(Math.abs(actual - expected) / expected).toBeLessThan(1e-7)
  })
})

function point(coordinates: number[]) {
  return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates } }
}

function projectedPoint(longitude: number, latitude: number) {
  return { ...point(webMercator(longitude, latitude)), crs: 'EPSG:3857' }
}

function polygon(coordinates: number[][]) {
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coordinates] } }
}

// 独立使用 Web Mercator 公开公式构造测试输入，不复用生产重投影实现。
function webMercator(longitude: number, latitude: number): number[] {
  const earthRadius = 6_378_137
  return [
    earthRadius * longitude * Math.PI / 180,
    earthRadius * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)),
  ]
}

function runtime(): ToolContext {
  return {
    runId: 'run_crs',
    sessionId: 'session_crs',
    threadId: 'thread_crs',
    signal: new AbortController().signal,
    state: new Map(),
    resolveValueRef: refId => { throw new Error(`未知 valueRef '${refId}'`) },
    invokeStructuredModel: async () => ({}),
    log: () => undefined,
  }
}

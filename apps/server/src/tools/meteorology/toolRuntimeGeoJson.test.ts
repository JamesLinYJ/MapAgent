// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象 Worker GeoJSON Artifact CRS 测试
//
//   文件:       toolRuntimeGeoJson.test.ts
//
//   日期:       2026年08月09日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from '../../framework/types.js'
import { geoJsonSpatialMetadata } from '../../gis/geojsonCrs.js'
import type { MeteorologyToolDeps } from './toolDefinition.js'
import {
  artifactTarget,
  geoJsonDisplay,
  mergeArtifactMetadata,
  normalizeGeoJsonArtifactFile,
  writeJsonArtifact,
} from './toolRuntime.js'

describe('meteorology Worker GeoJSON artifact boundary', () => {
  it('validates and reprojects Worker GeoJSON before file and display metadata publication', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'meteorology-geojson-crs-'))
    try {
      const deps: MeteorologyToolDeps = {
        runtimeRoot: root,
        callWorker: async () => { throw new Error('本测试不调用 Worker') },
      }
      const relativePath = 'artifacts/run_worker/threshold.geojson'
      const canonical = await writeJsonArtifact(deps, relativePath, {
        type: 'FeatureCollection',
        crs: 'EPSG:3857',
        features: [{
          type: 'Feature',
          properties: { level: 'heavy' },
          geometry: {
            type: 'Polygon',
            coordinates: [[
              webMercator(120, 30), webMercator(120.01, 30),
              webMercator(120.01, 30.01), webMercator(120, 30.01), webMercator(120, 30),
            ]],
          },
        }],
      })
      const artifact = artifactTarget(context(), 'geojson', '阈值区域')
      artifact.relativePath = relativePath
      mergeArtifactMetadata(
        artifact,
        geoJsonSpatialMetadata(canonical),
        geoJsonDisplay(
          artifact,
          canonical.entity as unknown as Record<string, unknown>,
          'polygon',
          { bounds: canonical.bounds, coordinateCrs: canonical.crs },
        ),
      )

      const persisted = JSON.parse(await readFile(path.join(root, relativePath), 'utf8'))
      expect(persisted).not.toHaveProperty('crs')
      expect(persisted.features[0].geometry.coordinates[0][0]).toEqual([
        expect.closeTo(120, 8), expect.closeTo(30, 8),
      ])
      expect(artifact.display.map).toMatchObject({
        crs: 'OGC:CRS84',
        bounds: canonical.bounds,
      })
      expect(artifact.metadata).toMatchObject({
        crs: 'OGC:CRS84',
        sourceCrs: 'EPSG:3857',
        reprojected: true,
        bounds: canonical.bounds,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('normalizes a GeoJSON file written directly by a Worker before publication', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'meteorology-worker-file-crs-'))
    try {
      const deps: MeteorologyToolDeps = {
        runtimeRoot: root,
        callWorker: async () => { throw new Error('本测试不调用 Worker') },
      }
      const relativePath = 'artifacts/run_worker/risk.geojson'
      const target = path.join(root, relativePath)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, JSON.stringify({
        type: 'Point', crs: 'EPSG:3857', coordinates: webMercator(120, 30),
      }), 'utf8')

      const canonical = await normalizeGeoJsonArtifactFile(deps, relativePath)

      expect(canonical).toMatchObject({ crs: 'OGC:CRS84', sourceCrs: 'EPSG:3857', reprojected: true })
      expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({
        type: 'Feature', geometry: { type: 'Point', coordinates: [expect.closeTo(120, 8), expect.closeTo(30, 8)] },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function webMercator(longitude: number, latitude: number): [number, number] {
  const earthRadius = 6_378_137
  return [
    earthRadius * longitude * Math.PI / 180,
    earthRadius * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)),
  ]
}

function context(): ToolContext {
  return {
    runId: 'run_worker',
    sessionId: 'session_worker',
    threadId: 'thread_worker',
    signal: new AbortController().signal,
    state: new Map(),
    resolveValueRef: refId => { throw new Error(`未知 valueRef '${refId}'`) },
    invokeStructuredModel: async () => ({}),
    log: () => undefined,
  }
}

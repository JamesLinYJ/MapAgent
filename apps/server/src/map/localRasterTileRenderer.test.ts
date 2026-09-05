// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本地 GeoTIFF 栅格瓦片渲染测试
//
//   文件:       localRasterTileRenderer.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { writeArrayBuffer } from 'geotiff'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

import { mapLayerManifestSchema } from '../schemas/types.js'
import { LocalRasterTileRenderer } from './localRasterTileRenderer.js'

const cleanupDirectories: string[] = []

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('LocalRasterTileRenderer', () => {
  it('reads a GeoTIFF window and returns a cached 256px PNG without Python sidecars', async () => {
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-raster-render-'))
    cleanupDirectories.push(runtimeRoot)
    const relativePath = 'artifacts/run_1/rain.tif'
    const rasterPath = path.join(runtimeRoot, ...relativePath.split('/'))
    await fs.mkdir(path.dirname(rasterPath), { recursive: true })
    const tiff = writeArrayBuffer(new Uint8Array([0, 10, 20, 30]), {
      width: 2,
      height: 2,
      GeographicTypeGeoKey: 4326,
      ModelPixelScale: [180, 90, 0],
      ModelTiepoint: [0, 0, 0, -180, 90, 0],
      SamplesPerPixel: 1,
      BitsPerSample: [8],
      SampleFormat: [1],
    })
    await fs.writeFile(rasterPath, new Uint8Array(tiff))
    const renderer = new LocalRasterTileRenderer({ runtimeRoot, timeoutMs: 10_000, concurrency: 1 })
    const spec = rasterSpec(relativePath)

    const first = await renderer.renderTile(spec, 0, 0, 0)
    const second = await renderer.renderTile(spec, 0, 0, 0)
    const decoded = await sharp(Buffer.from(first.body)).raw().toBuffer({ resolveWithObject: true })

    expect(first.contentType).toBe('image/png')
    expect(first.etag).toBe(second.etag)
    expect(Buffer.from(first.body)).toEqual(Buffer.from(second.body))
    expect(decoded.info.width).toBe(256)
    expect(decoded.info.height).toBe(256)
    expect(decoded.info.channels).toBe(4)
    expect(decoded.data[3]).toBeGreaterThan(0)
    expect(decoded.data.at(-1)).toBeGreaterThan(0)

    await renderer.close()
    await expect(renderer.renderTile(spec, 0, 0, 0)).rejects.toThrow('已经关闭')
  })
})

function rasterSpec(relativePath: string) {
  return {
    manifest: mapLayerManifestSchema.parse({
      mapLayerId: 'map_layer_raster',
      ownershipScope: 'thread',
      workspaceId: 'workspace_1',
      threadId: 'thread_1',
      artifactId: 'artifact_1',
      managedLayerKey: null,
      title: '降水栅格',
      status: 'ready',
      errorMessage: null,
      bounds: [-180, -85, 180, 85],
      crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
      minZoom: 0,
      maxZoom: 22,
      source: { kind: 'raster_tiles', tileJsonUrl: '/tiles.json', tileSize: 256 },
      style: {
        kind: 'continuous_raster',
        rangeMode: 'data',
        dataRange: [0, 30],
        renderRange: [0, 30],
        colorStops: [{ value: 0, color: '#000000' }, { value: 30, color: '#ffffff' }],
        opacity: 1,
      },
      legend: null,
      temporal: null,
      capabilities: { query: true, labels: false, style: true, temporal: false, opacity: true, download: true },
      dataVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    artifactRelativePath: relativePath,
  }
}

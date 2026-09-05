// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图瓦片网关测试
//
//   文件:       mapTileGateway.test.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import { mapLayerManifestSchema } from '../schemas/types.js'
import { MapTileGateway } from './mapTileGateway.js'
import type { MapTileResponse, RasterTileSource, VectorTileSource } from './mapTileSource.js'

describe('MapTileGateway', () => {
  it('routes an authorized vector layer to the PostGIS source', async () => {
    const sources = sourceDoubles()
    const gateway = new MapTileGateway(sources.vector, sources.raster)
    const spec = { manifest: manifest('vector_tiles'), artifactRelativePath: null }

    await gateway.fetchTile(spec, 4, 12, 7)

    expect(sources.vector.fetchTile).toHaveBeenCalledWith(spec, 4, 12, 7, undefined)
    expect(sources.raster.renderTile).not.toHaveBeenCalled()
  })

  it('routes a registered GeoTIFF layer to the local TypeScript renderer', async () => {
    const sources = sourceDoubles()
    const gateway = new MapTileGateway(sources.vector, sources.raster)
    const spec = {
      manifest: manifest('raster_tiles'),
      artifactRelativePath: 'artifacts/run_1/rain.tif',
    }

    await gateway.fetchTile(spec, 5, 25, 13)

    expect(sources.raster.renderTile).toHaveBeenCalledWith(spec, 5, 25, 13, undefined)
    expect(sources.vector.fetchTile).not.toHaveBeenCalled()
  })

  it('rejects out-of-range XYZ coordinates before invoking either source', async () => {
    const sources = sourceDoubles()
    const gateway = new MapTileGateway(sources.vector, sources.raster)

    await expect(gateway.fetchTile(
      { manifest: manifest('vector_tiles'), artifactRelativePath: null },
      2,
      4,
      0,
    )).rejects.toThrow('超出当前层级范围')

    expect(sources.vector.fetchTile).not.toHaveBeenCalled()
    expect(sources.raster.renderTile).not.toHaveBeenCalled()
  })

  it('closes the owned raster renderer', async () => {
    const sources = sourceDoubles()
    const gateway = new MapTileGateway(sources.vector, sources.raster)

    await gateway.close()

    expect(sources.raster.close).toHaveBeenCalledOnce()
  })
})

function sourceDoubles(): {
  vector: VectorTileSource
  raster: RasterTileSource
} {
  const response: MapTileResponse = {
    body: new Uint8Array([1, 2, 3]).buffer,
    contentType: 'application/octet-stream',
    cacheControl: 'private, max-age=60',
    etag: null,
  }
  return {
    vector: { fetchTile: vi.fn(async () => response) },
    raster: {
      renderTile: vi.fn(async () => response),
      close: vi.fn(async () => undefined),
    },
  }
}

function manifest(sourceKind: 'vector_tiles' | 'raster_tiles') {
  return mapLayerManifestSchema.parse({
    mapLayerId: 'map_layer_1',
    ownershipScope: 'thread',
    workspaceId: 'workspace_1',
    threadId: 'thread_1',
    artifactId: sourceKind === 'raster_tiles' ? 'artifact_1' : null,
    managedLayerKey: sourceKind === 'vector_tiles' ? 'managed_1' : null,
    title: '测试图层', status: 'ready', errorMessage: null,
    bounds: [119, 29, 121, 31], crs: 'EPSG:4326', minZoom: 0, maxZoom: 22,
    source: sourceKind === 'vector_tiles'
      ? { kind: 'vector_tiles', tileJsonUrl: '/tiles.json', sourceLayer: 'features' }
      : { kind: 'raster_tiles', tileJsonUrl: '/tiles.json', tileSize: 256 },
    style: sourceKind === 'vector_tiles'
      ? { kind: 'polygon', opacity: 0.7, colorField: null, categories: [], color: '#1976d2', outlineColor: '#0d47a1', outlineWidth: 1 }
      : {
          kind: 'continuous_raster', rangeMode: 'data', dataRange: [0, 50], renderRange: [0, 50], opacity: 0.9,
          colorStops: [{ value: 0, color: '#f7fbff00' }, { value: 50, color: '#b71c1c' }],
        },
    legend: null, temporal: null,
    capabilities: { query: true, labels: false, style: true, temporal: false, opacity: true, download: true },
    dataVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  })
}

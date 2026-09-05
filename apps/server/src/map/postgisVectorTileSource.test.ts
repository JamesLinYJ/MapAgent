// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostGIS 矢量瓦片数据源测试
//
//   文件:       postgisVectorTileSource.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'

import { mapLayerManifestSchema } from '../schemas/types.js'
import { PostgisVectorTileSource } from './postgisVectorTileSource.js'

describe('PostgisVectorTileSource', () => {
  it('calls only the fixed MVT function with parameterized layer identity', async () => {
    const bytes = Buffer.from([0x1a, 0x00])
    const database = poolDouble([{ rows: [] }, { rows: [] }, { rows: [{ tile: bytes }] }, { rows: [] }])
    const source = new PostgisVectorTileSource(database.pool, 12_345)

    const response = await source.fetchTile(vectorSpec('map_layer_1'), 4, 12, 7)

    expect(database.query).toHaveBeenNthCalledWith(1, 'BEGIN')
    expect(database.query).toHaveBeenNthCalledWith(
      2,
      `SELECT set_config('statement_timeout', $1, true)`,
      ['12345'],
    )
    const tileCall = database.query.mock.calls[2]
    expect(String(tileCall?.[0])).toContain('geo_agent_platform_layer_tiles')
    expect(tileCall?.[1]).toEqual([4, 12, 7, 'map_layer_1'])
    expect(String(tileCall?.[0])).not.toContain('map_layer_1')
    expect(response.contentType).toBe('application/vnd.mapbox-vector-tile')
    expect([...new Uint8Array(response.body)]).toEqual([...bytes])
    expect(response.etag).toMatch(/^"[A-Za-z0-9_-]+"$/u)
    expect(database.release).toHaveBeenCalledOnce()
  })

  it('rolls back and rejects malformed database output', async () => {
    const database = poolDouble([{ rows: [] }, { rows: [] }, { rows: [{ tile: 'not-bytea' }] }, { rows: [] }])
    const source = new PostgisVectorTileSource(database.pool, 5_000)

    await expect(source.fetchTile(vectorSpec('map_layer_1'), 0, 0, 0))
      .rejects.toThrow('无效结果')

    expect(database.query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(database.release).toHaveBeenCalledOnce()
  })
})

function poolDouble(results: Array<{ rows: unknown[] }>): {
  pool: Pool
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
} {
  const query = vi.fn(async () => results.shift() ?? { rows: [] })
  const release = vi.fn()
  const connect = vi.fn(async () => ({ query, release }))
  return {
    pool: { connect } as unknown as Pool,
    query,
    release,
  }
}

function vectorSpec(mapLayerId: string) {
  return {
    manifest: mapLayerManifestSchema.parse({
      mapLayerId,
      ownershipScope: 'thread',
      workspaceId: 'workspace_1',
      threadId: 'thread_1',
      artifactId: null,
      managedLayerKey: 'managed_1',
      title: '矢量图层',
      status: 'ready',
      errorMessage: null,
      bounds: [119, 29, 121, 31],
      crs: 'EPSG:4326',
      minZoom: 0,
      maxZoom: 22,
      source: { kind: 'vector_tiles', tileJsonUrl: '/tiles.json', sourceLayer: 'features' },
      style: {
        kind: 'polygon',
        opacity: 1,
        colorField: null,
        categories: [],
        color: '#1976d2',
        outlineColor: '#0d47a1',
        outlineWidth: 1,
      },
      legend: null,
      temporal: null,
      capabilities: { query: true, labels: false, style: true, temporal: false, opacity: true, download: true },
      dataVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    artifactRelativePath: null,
  }
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图瓦片描述器测试
//
//   文件:       mapTileDescriptor.test.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { mapLayerManifestSchema } from '../schemas/types.js'
import { AUTHENTICATED_TILE_CACHE_CONTROL, buildTileJson } from './mapTileDescriptor.js'

describe('map tile descriptor', () => {
  it('binds tile URLs to the manifest data version', () => {
    const manifest = mapLayerManifestSchema.parse({
      mapLayerId: 'map_layer_1', ownershipScope: 'system', workspaceId: null, threadId: null,
      artifactId: null, managedLayerKey: 'managed_1', title: '行政区划', status: 'ready', errorMessage: null,
      bounds: [118, 29, 121, 31], crs: 'EPSG:4326', minZoom: 0, maxZoom: 14,
      source: { kind: 'vector_tiles', tileJsonUrl: '/tilejson', sourceLayer: 'features' },
      style: {
        kind: 'polygon', opacity: 0.7, colorField: null, categories: [], color: '#2e9f7d',
        outlineColor: '#176c55', outlineWidth: 1,
      },
      legend: null, temporal: null,
      capabilities: { query: true, labels: true, style: true, temporal: false, opacity: true, download: true },
      dataVersion: 7, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })

    expect(buildTileJson(manifest, '/api/v1/map/layers/map_layer_1/tiles/{z}/{x}/{y}').tiles)
      .toEqual(['/api/v1/map/layers/map_layer_1/tiles/{z}/{x}/{y}?v=7'])
    expect(AUTHENTICATED_TILE_CACHE_CONTROL).toContain('immutable')
  })
})

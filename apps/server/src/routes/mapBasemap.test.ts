// +-------------------------------------------------------------------------
//
//   地理智能平台 - 底图 HTTP 路由测试
//
//   文件:       mapBasemap.test.ts
//
//   日期:       2026年08月12日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { MapTileGateway } from '../map/mapTileGateway.js'
import { TiandituBasemapGateway } from '../map/tiandituBasemapGateway.js'
import type { SecurityServices } from '../security/routes.js'
import type { MapStore } from '../store/postgres/mapStore.js'
import { mapRoutes } from './map.js'

describe('map basemap routes', () => {
  it('parses the complete y coordinate and proxies a server-key tile without exposing the key', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }))
    const app = mapRoutes({
      mapStore: {} as MapStore,
      tileGateway: {} as MapTileGateway,
      tiandituBasemapGateway: new TiandituBasemapGateway('server-key-fixture', fetch),
      security: {} as SecurityServices,
    })

    const response = await app.request(
      '/api/v1/map/basemaps/tianditu-vector/tiles/vector/4/13/6',
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))
    const upstream = new URL(String(fetch.mock.calls[0]?.[0]))
    expect(upstream.hostname).toMatch(/^t[0-7]\.tianditu\.gov\.cn$/u)
    expect(upstream.searchParams.get('T')).toBe('vec_w')
    expect(upstream.searchParams.get('x')).toBe('13')
    expect(upstream.searchParams.get('y')).toBe('6')
    expect(upstream.searchParams.get('l')).toBe('4')
    expect(response.headers.get('location')).toBeNull()
    expect(JSON.stringify([...response.headers])).not.toContain('server-key-fixture')
  })
})

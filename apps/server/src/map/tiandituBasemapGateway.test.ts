// +-------------------------------------------------------------------------
//
//   地理智能平台 - 天地图底图网关测试
//
//   文件:       tiandituBasemapGateway.test.ts
//
//   日期:       2026年08月12日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import { TiandituBasemapGateway } from './tiandituBasemapGateway.js'

describe('TiandituBasemapGateway', () => {
  it('publishes only the proxied Tianditu vector basemap without exposing the API key', () => {
    const gateway = new TiandituBasemapGateway('local-secret-fixture')

    const catalog = gateway.catalog()

    expect(catalog).toEqual([expect.objectContaining({
      basemapKey: 'tianditu-vector',
      name: '天地图',
      available: true,
      isDefault: true,
      tileUrls: ['/api/v1/map/basemaps/tianditu-vector/tiles/vector/{z}/{x}/{y}'],
      labelTileUrls: ['/api/v1/map/basemaps/tianditu-vector/tiles/labels/{z}/{x}/{y}'],
    })])
    expect(JSON.stringify(catalog)).not.toContain('local-secret-fixture')
  })

  it('marks the sole basemap unavailable when the local key has not been configured', () => {
    expect(new TiandituBasemapGateway(undefined).catalog()[0]?.available).toBe(false)
  })

  it('uses the server-scoped key upstream and returns bounded image bytes without exposing it', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { 'content-type': 'image/png', etag: 'tile-v1' },
    }))
    const gateway = new TiandituBasemapGateway('local-secret-fixture', fetch)

    const tile = await gateway.fetchTile('labels', 4, 13, 6)
    const requestedUrl = new URL(String(fetch.mock.calls[0]?.[0]))

    expect(requestedUrl.origin).toMatch(/^https:\/\/t[0-7]\.tianditu\.gov\.cn$/u)
    expect(requestedUrl.searchParams.get('T')).toBe('cva_w')
    expect(requestedUrl.searchParams.get('tk')).toBe('local-secret-fixture')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      headers: expect.objectContaining({ 'user-agent': 'GeoAgentPlatform-Server/1' }),
    })
    expect(tile).toMatchObject({ contentType: 'image/png', etag: 'tile-v1' })
    expect(new Uint8Array(tile.body)).toEqual(new Uint8Array([137, 80, 78, 71]))
    expect(JSON.stringify(tile)).not.toContain('local-secret-fixture')
  })

  it('rejects invalid coordinates before contacting Tianditu', async () => {
    const fetch = vi.fn()
    const gateway = new TiandituBasemapGateway('local-secret-fixture', fetch)

    await expect(gateway.fetchTile('vector', 2, 4, 0)).rejects.toThrow('超出当前层级范围')
    expect(fetch).not.toHaveBeenCalled()
  })
})

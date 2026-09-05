// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron HTTP 认证边界测试
//
//   文件:       apiGateway.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}))

vi.mock('electron', () => ({
  net: {
    fetch: fetchMock,
    request: vi.fn(),
  },
}))

import { DesktopApiGateway } from './apiGateway.js'

describe('DesktopApiGateway authorization', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ updated: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  })

  it('injects Cookie and CSRF from Main for mutations', async () => {
    const auth = fakeAuthorization()
    const gateway = new DesktopApiGateway('http://127.0.0.1:8000', auth)

    await gateway.request({
      method: 'PATCH',
      path: '/api/v1/admin/users/user_1',
      body: '{"status":"disabled"}',
      headers: { 'content-type': 'application/json' },
    })

    const request = fetchMock.mock.calls[0]
    const headers = new Headers(request?.[1]?.headers)
    expect(headers.get('cookie')).toBe('better-auth.session_token=main-only-cookie')
    expect(headers.get('x-geo-agent-platform-csrf')).toBe('main-only-csrf')
    expect(headers.get('origin')).toBe('geo-agent-platform://app')
    expect(auth.requireAuthorizationContext).toHaveBeenCalledOnce()
  })

  it('does not require or project CSRF for read-only requests', async () => {
    const auth = fakeAuthorization()
    const gateway = new DesktopApiGateway('http://127.0.0.1:8000', auth)

    await gateway.request({
      method: 'GET',
      path: '/api/v1/admin/users',
      body: null,
      headers: {},
    })

    const request = fetchMock.mock.calls[0]
    const headers = new Headers(request?.[1]?.headers)
    expect(headers.get('x-geo-agent-platform-csrf')).toBeNull()
    expect(auth.requireAuthorizationContext).not.toHaveBeenCalled()
  })

  it('projects the server-owned Tianditu tile routes into the controlled desktop protocol', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{
      basemapKey: 'tianditu-vector',
      name: '天地图',
      provider: '国家地理信息公共服务平台',
      kind: 'raster',
      attribution: '© 天地图',
      tileUrls: ['/api/v1/map/basemaps/tianditu-vector/tiles/vector/{z}/{x}/{y}'],
      labelTileUrls: ['/api/v1/map/basemaps/tianditu-vector/tiles/labels/{z}/{x}/{y}'],
      available: true,
      isDefault: true,
    }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const gateway = new DesktopApiGateway('http://127.0.0.1:8000', fakeAuthorization())

    const response = await gateway.request({
      method: 'GET',
      path: '/api/v1/map/basemaps',
      body: null,
      headers: {},
    })

    const catalog = JSON.parse(response.body) as Array<{
      tileUrls: string[]
      labelTileUrls: string[]
    }>
    expect(catalog[0]?.tileUrls).toEqual([
      'geo-agent-platform-resource://api/api/v1/map/basemaps/tianditu-vector/tiles/vector/{z}/{x}/{y}',
    ])
    expect(catalog[0]?.labelTileUrls).toEqual([
      'geo-agent-platform-resource://api/api/v1/map/basemaps/tianditu-vector/tiles/labels/{z}/{x}/{y}',
    ])
  })

  it('invalidates Main authorization when the server rejects the session', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
    const auth = fakeAuthorization()
    const gateway = new DesktopApiGateway('http://127.0.0.1:8000', auth)

    await gateway.request({
      method: 'GET',
      path: '/api/v1/admin/users',
      body: null,
      headers: {},
    })

    expect(auth.invalidateAuthorizationContext).toHaveBeenCalledOnce()
  })
})

function fakeAuthorization() {
  return {
    cookieHeader: () => 'better-auth.session_token=main-only-cookie',
    requireAuthorizationContext: vi.fn(() => ({
      userId: 'user_1',
      csrfToken: 'main-only-csrf',
      revision: 1,
    })),
    invalidateAuthorizationContext: vi.fn(),
  }
}

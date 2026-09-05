// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面地图资源协议投影测试
//
//   文件:       mapResourceProtocolProjection.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  projectDesktopApiResourceRequest,
  projectMapTileJsonForDesktop,
} from './mapResourceProtocolProjection.js'

describe('mapResourceProtocolProjection', () => {
  it('将 TileJSON 的相对瓦片地址投影到受控桌面协议', () => {
    const canonical = {
      tilejson: '3.0.0',
      name: '降水短临',
      tiles: ['/api/v1/map/layers/map_layer_1/tiles/{z}/{x}/{y}?v=7'],
      minzoom: 0,
      maxzoom: 12,
      bounds: [118, 29, 121, 31],
    } as const

    const projected = projectMapTileJsonForDesktop(canonical)

    expect(projected?.tiles).toEqual([
      'geo-agent-platform-resource://api/api/v1/map/layers/map_layer_1/tiles/{z}/{x}/{y}?v=7',
    ])
    expect(canonical.tiles).toEqual([
      '/api/v1/map/layers/map_layer_1/tiles/{z}/{x}/{y}?v=7',
    ])
  })

  it('把受控数据面的查询参数原样交给 Server 权威契约', () => {
    const resource = new URL(
      'geo-agent-platform-resource://api/api/v1/map/layers/map_layer_1/tiles/9/426/211?v=7&time=2026-07-29T12%3A00%3A00Z',
    )
    expect(projectDesktopApiResourceRequest(resource)).toEqual({
      targetPath: '/api/v1/map/layers/map_layer_1/tiles/9/426/211?v=7&time=2026-07-29T12%3A00%3A00Z',
    })
  })

  it('拒绝协议范围外路径', () => {
    expect(projectDesktopApiResourceRequest(new URL(
      'geo-agent-platform-resource://api/api/v1/map/layers/map_layer_1/tilejson',
    ))).toEqual({
      targetPath: '/api/v1/map/layers/map_layer_1/tilejson',
    })
    expect(projectDesktopApiResourceRequest(new URL(
      'geo-agent-platform-resource://api/api/v1/admin/users',
    ))).toBeNull()
    expect(projectDesktopApiResourceRequest(new URL(
      'geo-agent-platform-resource://api/api/v1/map/%2e%2e/admin',
    ))).toBeNull()
  })

  it('非 TileJSON 内容不做猜测性改写', () => {
    expect(projectMapTileJsonForDesktop({ type: 'FeatureCollection', features: [] }))
      .toBeNull()
  })
})

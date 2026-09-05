// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图场景契约测试
//
//   文件:       mapSceneContract.test.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { mapLayerDraftSchema, mapSceneLayerSchema } from '../schemas/types.js'

describe('map scene contract', () => {
  it('validates and defaults persisted label presentation', () => {
    const layer = mapSceneLayerSchema.parse({
      mapLayerId: 'map_layer_1',
      order: 0,
      visible: true,
      opacity: 0.8,
      styleOverride: null,
      label: { field: 'name' },
      currentFrameId: null,
    })

    expect(layer.label).toEqual({
      field: 'name',
      placement: 'auto',
      size: 12,
      color: '#1f2937',
      haloColor: '#ffffff',
      haloWidth: 1.5,
    })
  })

  it('keeps layer replacement semantics explicit in the display contract', () => {
    const draft = mapLayerDraftSchema.parse({
      title: '三小时累计降水',
      replacementGroup: 'meteorological-nowcast-precipitation',
      bounds: [118, 29, 121, 31],
      crs: 'EPSG:4326',
      source: { kind: 'raster_tiles', tileJsonUrl: '/api/v1/map/layers/layer_1/tilejson' },
      style: {
        kind: 'continuous_raster',
        dataRange: [0, 50],
        renderRange: [0, 50],
        colorStops: [{ value: 0, color: '#fff' }, { value: 50, color: '#700' }],
      },
      legend: null,
      temporal: null,
      capabilities: {},
    })

    expect(draft.replacementGroup).toBe('meteorological-nowcast-precipitation')
  })
})

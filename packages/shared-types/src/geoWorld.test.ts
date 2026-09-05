// +-------------------------------------------------------------------------
//
//   地理智能平台 - GIS 世界状态契约测试
//
//   文件:       geoWorld.test.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  createGeoWorldDiff,
  geoWorldStateSchema,
  replayGeoWorldDiff,
  type GeoWorldLayerSnapshot,
  type GeoWorldState,
} from './geoWorld.js'

describe('GeoWorld reducer', () => {
  it('replays an explicit diff to the same next world', () => {
    const current = world()
    const added = layer('layer_b', 'layer_b@1')
    const { state, diff } = createGeoWorldDiff({
      diffId: 'world_diff_1',
      runId: 'run_1',
      current,
      patches: [
        { type: 'layer.added', layer: added },
        { type: 'map.selection_changed', selectedLayerIds: ['layer_b'] },
      ],
      createdAt: '2026-08-20T01:00:00.000Z',
    })

    expect(replayGeoWorldDiff(current, diff)).toEqual(state)
    expect(state.revision).toBe(2)
    expect(diff.changedLayerIds).toEqual(['layer_b'])
  })

  it('hard fails when a layer revision is stale', () => {
    const current = world({ layers: [layer('layer_a', 'layer_a@2')] })
    expect(() => createGeoWorldDiff({
      diffId: 'world_diff_conflict',
      runId: 'run_1',
      current,
      patches: [{
        type: 'layer.updated',
        layerId: 'layer_a',
        expectedRevision: 'layer_a@1',
        next: layer('layer_a', 'layer_a@3'),
      }],
      createdAt: '2026-08-20T01:00:00.000Z',
    })).toThrow(/revision 冲突/u)
  })

  it('rejects selection that is not part of the captured world', () => {
    expect(() => createGeoWorldDiff({
      diffId: 'world_diff_selection',
      runId: 'run_1',
      current: world(),
      patches: [{ type: 'map.selection_changed', selectedLayerIds: ['missing'] }],
      createdAt: '2026-08-20T01:00:00.000Z',
    })).toThrow(/不存在的图层/u)
  })

  it('replays an explicit capability change and rejects a stale capability base', () => {
    const current = world()
    const nextCapabilities = {
      ...current.capabilities,
      toolNames: ['list_layers', 'query_layer'],
    }
    const { state, diff } = createGeoWorldDiff({
      diffId: 'world_diff_capabilities',
      runId: 'run_1',
      current,
      patches: [{
        type: 'capabilities.changed',
        expected: current.capabilities,
        next: nextCapabilities,
      }],
      createdAt: '2026-08-20T01:00:00.000Z',
    })

    expect(diff.capabilitiesChanged).toBe(true)
    expect(replayGeoWorldDiff(current, diff)).toEqual(state)
    expect(state.capabilities).toEqual(nextCapabilities)
    expect(() => createGeoWorldDiff({
      diffId: 'world_diff_stale_capabilities',
      runId: 'run_1',
      current: state,
      patches: [{
        type: 'capabilities.changed',
        expected: current.capabilities,
        next: { ...nextCapabilities, toolNames: ['list_layers'] },
      }],
      createdAt: '2026-08-20T01:01:00.000Z',
    })).toThrow(/过期快照/u)
  })
})

function world(overrides: Partial<GeoWorldState> = {}): GeoWorldState {
  return geoWorldStateSchema.parse({
    schemaVersion: 1,
    revision: 1,
    workspaceId: 'workspace_1',
    map: {
      displayCrs: 'EPSG:3857',
      viewport: null,
      selectedLayerIds: [],
      selectedFeatureRefs: [],
      timeRange: null,
    },
    layers: [],
    datasets: [],
    files: [],
    artifacts: [],
    values: [],
    provenance: [],
    capabilities: {
      toolNames: ['list_layers'],
      mcpServerNames: [],
      sandboxBackend: 'disabled',
      writableRoots: [],
      networkPolicy: 'provider_only',
    },
    ...overrides,
  })
}

function layer(layerId: string, revision: string): GeoWorldLayerSnapshot {
  return {
    layerId,
    revision,
    sourceRef: `managed:${layerId}`,
    schemaHash: null,
    contentHash: null,
    crs: 'OGC:CRS84',
    geometryType: 'Polygon',
    featureCount: 1,
    extent: [119, 29, 121, 31],
    styleRevision: 'style@1',
  }
}

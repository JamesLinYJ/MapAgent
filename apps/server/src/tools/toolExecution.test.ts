// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具执行测试
//
//   文件:       toolExecution.test.ts
//
//   日期:       2026年06月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Geometry } from 'geojson'
import type { ValueRef } from '../framework/types.js'
import type { ManagedLayerService } from '../gis/managedLayers/managedLayerService.js'
import type { LayerDescriptor } from '../schemas/types.js'
import { createLayerListTool } from './layerList/layerList.js'
import { createLayerQueryTool } from './layerQuery/layerQuery.js'
import { createLayerCreateTool } from './layerCreate/layerCreate.js'
import { createSpatialAnalysisTool } from './spatialAnalysis/spatialAnalysis.js'
import { createMapExportTool } from './mapExport/mapExport.js'

describe('geo tools', () => {
  it('lists existing platform layers without external fetching', async () => {
    const managedLayers = {
      listLayers: async (workspaceId: string, sessionId: string | null, threadId: string | null) => {
        expect(workspaceId).toBe('workspace_1')
        expect(sessionId).toBe('session_1')
        expect(threadId).toBe('thread_1')
        return [
          layer('hangzhou_admin', '杭州市区县边界', ['杭州', '行政区划']),
          layer('admin_boundaries', '行政区边界', []),
          layer('roads', '道路中心线', ['道路']),
        ]
      },
    } as unknown as ManagedLayerService

    const result = await createLayerListTool(managedLayers).handler({ query: '杭州 行政区划' }, runtime())

    expect(result.source).toBe('postgis')
    expect(result.provenance).toMatchObject({ externalFetch: false })
    expect(result.payload.layers).toEqual([
      expect.objectContaining({ layerKey: 'hangzhou_admin', name: '杭州市区县边界' }),
    ])
  })

  it('does not treat auto-generated analysis rectangles as administrative boundaries', async () => {
    const managedLayers = {
      listLayers: async () => [
        layer('layer_bbox', '杭州市边界', ['auto-generated', 'analysis'], {
          sourceType: 'analysis',
          category: 'analysis',
          description: '杭州市行政边界矩形范围',
        }),
      ],
    } as unknown as ManagedLayerService

    const result = await createLayerListTool(managedLayers).handler({ query: '杭州 行政区划' }, runtime())

    expect(result.payload.count).toBe(0)
    expect(result.payload.layers).toEqual([])
  })

  it('queries real PostGIS rows through query_layer', async () => {
    const managedLayers = {
      getLayer: async () => ({
        layerKey: 'roads',
        name: '道路',
        sourceType: 'postgis',
        geometryType: 'Point',
        srid: 4326,
        description: '',
        featureCount: 2,
        bounds: null,
        propertySchema: [],
        category: 'general',
        status: 'active',
        tags: [],
        analysisCapabilities: [],
        sourceConfigSummary: null,
        sessionId: null,
        threadId: null,
        createdAt: null,
        updatedAt: null,
      }),
      featureCount: async () => 2,
      queryFeatures: async () => [
        { geometry: point(120, 30), properties: { name: 'A', hidden: true } },
        { geometry: point(121, 31), properties: { name: 'B', hidden: false } },
      ],
    } as unknown as ManagedLayerService

    const result = await createLayerQueryTool(managedLayers).handler({ layerKey: 'roads', properties: ['name'] }, runtime())
    const collection = result.payload.featureCollection as { features: Array<{ properties: Record<string, unknown> }> }

    expect(result.source).toBe('postgis')
    expect(result.payload.totalCount).toBe(2)
    expect(result.payload.complete).toBe(true)
    expect(collection.features[0].properties).toEqual({ name: 'A' })
  })

  it('filters named features before limit and checks completeness against matched rows', async () => {
    const observedQueries: unknown[] = []
    const managedLayers = {
      queryFeatures: async (_layerKey: string, query: unknown) => {
        observedQueries.push(query)
        return [
          { geometry: point(120.1, 30.2), properties: { name: '西湖区', adcode: '330106' } },
          { geometry: point(119.9, 30.4), properties: { name: '余杭区', adcode: '330110' } },
        ]
      },
      featureCount: async (_layerKey: string, query?: { propertyFilter?: unknown }) => (
        query?.propertyFilter ? 2 : 13
      ),
    } as unknown as ManagedLayerService

    const result = await createLayerQueryTool(managedLayers).handler({
      layerKey: 'hangzhou_districts',
      propertyFilter: { property: 'name', values: ['西湖区', '余杭区'] },
      properties: ['name'],
      requireComplete: true,
    }, runtime())
    const collection = result.payload.featureCollection as { features: Array<{ properties: Record<string, unknown> }> }

    expect(observedQueries).toEqual([{
      propertyFilter: { property: 'name', values: ['西湖区', '余杭区'] },
      limit: 100,
    }])
    expect(result.message).toBe('读取 2 / 2 个匹配要素（图层共 13 个）')
    expect(result.payload).toMatchObject({
      totalCount: 2,
      sourceTotalCount: 13,
      matchedCount: 2,
      returnedCount: 2,
      complete: true,
    })
    expect(collection.features.map(feature => feature.properties)).toEqual([
      { name: '西湖区' },
      { name: '余杭区' },
    ])
  })

  it('rejects malformed property filters at the tool boundary', async () => {
    const managedLayers = {} as ManagedLayerService
    await expect(createLayerQueryTool(managedLayers).handler({
      layerKey: 'hangzhou_districts',
      propertyFilter: { property: 'name', values: [] },
    }, runtime())).rejects.toThrow('propertyFilter.values 必须包含 1 到 50 个值')
  })

  it('hard-fails when a caller requires a complete layer but the query is truncated', async () => {
    const managedLayers = {
      featureCount: async () => 13,
      queryFeatures: async () => [
        { geometry: point(120, 30), properties: { name: '上城区' } },
      ],
    } as unknown as ManagedLayerService

    await expect(createLayerQueryTool(managedLayers).handler({
      layerKey: 'hangzhou_districts',
      limit: 1,
      requireComplete: true,
    }, runtime())).rejects.toThrow('不能作为完整分析范围')
  })

  it('creates both layer and feature_collection refs for downstream tools', async () => {
    const managedLayers = {
      importGeoJsonLayer: async (input: Record<string, unknown>) => {
        expect(input.sessionId).toBe('session_1')
        expect(input.threadId).toBe('thread_1')
        expect(input.canonicalGeoJson).toMatchObject({
          crs: 'OGC:CRS84',
          entity: { type: 'Feature' },
        })
        return layer('layer_1', String(input.name), ['analysis'])
      },
    } as unknown as ManagedLayerService

    const result = await createLayerCreateTool(managedLayers).handler({
      name: '杭州中心点',
      geojson: {
        type: 'Feature',
        geometry: point(120.2, 30.25),
        properties: { name: '杭州中心点' },
      },
    }, runtime())

    expect(result.valueRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'layer', value: expect.objectContaining({ layerKey: 'layer_1', featureCollection: expect.any(Object) }) }),
      expect.objectContaining({
        kind: 'feature_collection',
        metadata: expect.objectContaining({ sourceLayerKey: 'layer_1', crs: 'OGC:CRS84' }),
      }),
    ]))
  })

  it('runs deterministic Turf operations through spatial_analysis', async () => {
    const managedLayers = {} as ManagedLayerService
    const result = await createSpatialAnalysisTool(managedLayers).handler({
      operation: 'area',
      sourceGeojson: {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
        },
        properties: {},
      },
    }, runtime())

    expect(result.source).toBe('turf')
    expect(result.payload.areaSqm).toBeGreaterThan(0)
  })

  it('returns per-feature areas for a filtered feature collection', async () => {
    const result = await createSpatialAnalysisTool().handler({
      operation: 'area',
      sourceGeojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
            },
            properties: { name: '甲区' },
          },
          {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]],
            },
            properties: { name: '乙区' },
          },
        ],
      },
    }, runtime())

    expect(result.payload.featureAreas).toEqual([
      expect.objectContaining({ index: 0, properties: { name: '甲区' }, areaSqKm: expect.any(Number) }),
      expect.objectContaining({ index: 1, properties: { name: '乙区' }, areaSqKm: expect.any(Number) }),
    ])
    const featureAreas = result.payload.featureAreas as Array<{ areaSqKm: number }>
    expect(featureAreas[1]!.areaSqKm).toBeGreaterThan(featureAreas[0]!.areaSqKm)
  })

  it('passes query_layer GeoJSON valueRefs into analysis, layer creation, and export', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-geojson-value-ref-'))
    try {
      const polygon: Geometry = {
        type: 'Polygon',
        coordinates: [[[120, 30], [120, 31], [121, 31], [121, 30], [120, 30]]],
      }
      let importedCollection: unknown = null
      const managedLayers = {
        queryFeatures: async () => [{ geometry: polygon, properties: { name: '测试区' } }],
        featureCount: async () => 1,
        importGeoJsonLayer: async (input: Record<string, unknown>) => {
          importedCollection = (input.canonicalGeoJson as { entity?: unknown } | undefined)?.entity
          return layer('analysis_layer', String(input.name), ['analysis'])
        },
      } as unknown as ManagedLayerService

      const queried = await createLayerQueryTool(managedLayers).handler({
        layerKey: 'hangzhou_districts',
        requireComplete: true,
      }, runtime())
      const featureRef = queried.valueRefs?.find(ref => ref.kind === 'feature_collection')
      if (!featureRef) throw new Error('query_layer 没有返回 feature_collection valueRef')
      const refs = new Map([[featureRef.refId, featureRef]])

      const analyzed = await createSpatialAnalysisTool().handler({
        operation: 'area',
        sourceGeojson: featureRef.refId,
      }, runtime(refs))
      const created = await createLayerCreateTool(managedLayers).handler({
        name: '测试分析图层',
        geojson: featureRef.refId,
      }, runtime(refs))
      const exported = await createMapExportTool(root).handler({
        filename: '测试行政区划.geojson',
        geojson: featureRef.refId,
      }, runtime(refs))

      expect(analyzed.payload.areaSqm).toBeGreaterThan(0)
      expect(importedCollection).toMatchObject({ type: 'FeatureCollection' })
      expect(created.payload).toMatchObject({ layerKey: 'analysis_layer', featureCount: 1 })
      const artifact = exported.artifacts?.[0]
      expect(artifact).toMatchObject({ artifactType: 'geojson', name: '测试行政区划.geojson' })
      if (!artifact?.relativePath) throw new Error('map_export 没有返回 artifact 相对路径')
      const serialized = await readFile(path.join(root, artifact.relativePath), 'utf8')
      expect(JSON.parse(serialized)).toMatchObject({ type: 'FeatureCollection' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function point(lon: number, lat: number): Geometry {
  return { type: 'Point', coordinates: [lon, lat] }
}

function layer(
  layerKey: string,
  name: string,
  tags: string[],
  overrides: Partial<LayerDescriptor> = {},
): LayerDescriptor {
  return {
    layerKey,
    name,
    sourceType: 'system',
    geometryType: 'Polygon',
    srid: 4326,
    description: '',
    featureCount: 13,
    bounds: [118, 29, 121, 31] as [number, number, number, number],
    propertySchema: [{ name: 'name', dataType: 'string', populatedCount: 13, sampleValues: ['西湖区'] }],
    category: 'boundary',
    status: 'active',
    tags,
    analysisCapabilities: ['query', 'spatial_analysis'],
    sourceConfigSummary: null,
    sessionId: null,
    threadId: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }
}

function runtime(refs: ReadonlyMap<string, ValueRef> = new Map()) {
  return {
    runId: 'run_1',
    threadId: 'thread_1',
    sessionId: 'session_1',
    signal: new AbortController().signal,
    auth: {
      userId: 'user_1', subject: 'user_1', email: 'user@example.com', displayName: '测试用户',
      authSessionId: 'auth_session_1', authSessionExpiresAt: null, csrfToken: 'csrf',
      defaultWorkspaceId: 'workspace_1', roles: [],
    },
    state: new Map(refs),
    resolveValueRef: (refId: string) => {
      const reference = refs.get(refId)
      if (!reference) throw new Error(`未知 valueRef '${refId}'`)
      return reference
    },
    invokeStructuredModel: async () => ({}),
    log: () => undefined,
  }
}

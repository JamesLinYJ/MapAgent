// +-------------------------------------------------------------------------
//
//   地理智能平台 - 短时临近预报（短临）工具契约测试
//
//   文件:       meteorologyTools.test.ts
//
//   日期:       2026年06月15日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext, ValueRef } from '../../framework/types.js'
import type { MeteorologicalDatasetRecord } from '../../schemas/types.js'
import { ToolRegistry } from '../../framework/registry.js'
import { validateToolProvider } from '../../framework/validation.js'
import { parseEnv } from '../../framework/env.js'
import { createMeteorologyProvider } from './index.js'
import { createMeteorologyTools } from './meteorologyTools.js'
import { convertMeteorologicalUnitValue, meteorologicalMembersFingerprint } from './toolRuntime.js'
import {
  clearMeteorologyWorkerCatalogCache,
  REQUIRED_METEOROLOGY_WORKER_TOOLS,
  workerContractHash,
} from './meteorologyWorkerClient.js'
import type { ToolContractManifest, WorkerToolCatalog } from '@geo-agent-platform/shared-types'

const testEnv = parseEnv({
  API_PORT: '8000',
  API_HOST: '127.0.0.1',
  DATABASE_URL: 'postgres://test:test@127.0.0.1/test',
  RUNTIME_ROOT: 'runtime',
  APP_BASE_URL: 'http://127.0.0.1:8000',
  BETTER_AUTH_URL: 'http://127.0.0.1:8000',
  BETTER_AUTH_SECRET: 'test_better_auth_secret_32_bytes__',
  WORKER_URL: 'http://worker.test',
  WORKER_SHARED_SECRET: 'test_worker_shared_secret_32_bytes',
  ENABLED_TOOL_PROVIDERS: 'geo-platform-meteorology',
})
const provider = createMeteorologyProvider(testEnv)
const meteorologyTools = createMeteorologyTools(testEnv)
const workerGeoJsonOutputs: string[] = []

afterEach(async () => {
  clearMeteorologyWorkerCatalogCache()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(workerGeoJsonOutputs.splice(0).map(file => rm(file, { force: true })))
})

describe('nowcast tools', () => {
  it('keeps the meteorology manifest and runtime definitions identical', () => {
    expect(() => validateToolProvider(provider)).not.toThrow()
  })

  it('lists the current session dataset catalog across upload-source threads', async () => {
    const listMeteorologicalDatasets = vi.fn().mockResolvedValue([{
      datasetId: 'dataset_1',
      workspaceId: 'workspace_1',
      createdByUserId: 'user_1',
      visibility: 'workspace',
      sessionId: 'session_1',
      threadId: 'thread_upload',
      filename: '202604091955_202604092000.nc',
      originalFilename: '202604091955_202604092000.nc',
      fileId: 'file_1',
      fileRelativePath: 'objects/sha256/aa/hash.nc',
      sizeBytes: 1024,
      contentHash: 'hash',
      mediaType: 'application/x-netcdf',
      status: 'ready',
      metadata: { source: 'upload', sourceRelativePath: '202604091955/202604091955_202604092000.nc' },
      createdAt: '2026-04-09T19:55:00.000Z',
      updatedAt: '2026-04-09T19:55:00.000Z',
    }])
    const toolContext = context()
    toolContext.listMeteorologicalDatasets = listMeteorologicalDatasets
    const tool = meteorologyTools.find(candidate => candidate.name === 'list_meteorological_files')!

    const result = await tool.handler({}, toolContext)

    expect(listMeteorologicalDatasets).toHaveBeenCalledWith({ scope: 'session', limit: 500 })
    expect(result.payload.counts).toEqual({ dataset: 1, radar: 0, boundary: 0 })
    expect(result.valueRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'meteorological_file',
        value: expect.objectContaining({
          datasetId: 'dataset_1',
          relativePath: 'objects/sha256/aa/hash.nc',
        }),
      }),
      expect.objectContaining({ kind: 'meteorological_file_collection' }),
    ]))
  })

  it('can isolate a just-uploaded batch to the current thread', async () => {
    const listMeteorologicalDatasets = vi.fn().mockResolvedValue([])
    const toolContext = context()
    toolContext.listMeteorologicalDatasets = listMeteorologicalDatasets
    const tool = meteorologyTools.find(candidate => candidate.name === 'list_meteorological_files')!

    const result = await tool.handler({ scope: 'thread' }, toolContext)

    expect(listMeteorologicalDatasets).toHaveBeenCalledWith({ scope: 'thread', limit: 500 })
    expect(result.payload).toMatchObject({ scope: 'thread', counts: { dataset: 0, radar: 0, boundary: 0 } })
    expect(result.message).toContain('当前对话')
  })

  it('does not widen thread scope when the execution has no thread', async () => {
    const listMeteorologicalDatasets = vi.fn().mockResolvedValue([])
    const toolContext = context(new Map(), { threadId: null })
    toolContext.listMeteorologicalDatasets = listMeteorologicalDatasets
    const tool = meteorologyTools.find(candidate => candidate.name === 'list_meteorological_files')!

    await expect(tool.handler({ scope: 'thread' }, toolContext)).rejects.toThrow('没有 threadId')
    expect(listMeteorologicalDatasets).not.toHaveBeenCalled()
  })

  it('does not hide meteorology tools when the worker is temporarily unreachable during provider load', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('worker restarting'))
    vi.stubGlobal('fetch', fetch)
    await expect(provider.onInstall?.({
      config: { WORKER_URL: 'http://worker.test' },
      state: new Map(),
      log: () => undefined,
    }) ?? Promise.resolve()).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('creates a district boundary valueRef from an existing boundary reference', async () => {
    const state = new Map<string, unknown>([[
      'ref_boundary',
      valueRef('ref_boundary', 'feature_collection', {
        type: 'FeatureCollection',
        features: [
          feature('富阳区'),
          feature('淳安县'),
        ],
      }),
    ]])
    const tool = meteorologyTools.find(candidate => candidate.name === 'prepare_nowcast_scope')!
    const result = await tool.handler({ question: '接下来天气怎么样？', scope_ref: 'ref_boundary' }, context(state))

    expect(result.valueRefs?.[0].kind).toBe('nowcast_area')
    expect(result.valueRefs?.[1].kind).toBe('feature_collection')
    expect(result.payload.featureCount).toBe(2)
  })

  it('creates a coordinate valueRef from an existing place reference', async () => {
    const state = new Map<string, unknown>([[
      'ref_place',
      valueRef('ref_place', 'place_candidate', { lat: 30.2462469, lon: 120.2060110, label: '市民中心' }),
    ]])
    const tool = meteorologyTools.find(candidate => candidate.name === 'prepare_nowcast_scope')!
    const result = await tool.handler({ question: '市民中心天气怎么样？', scope_ref: 'ref_place' }, context(state))

    expect(result.valueRefs?.[0].kind).toBe('nowcast_coordinate')
    expect(result.valueRefs?.[0].value).toEqual({ lat: 30.2462469, lng: 120.206011, label: '市民中心' })
  })

  it('normalizes a projected layer scope once before publishing the nowcast area', async () => {
    const [x, y] = [13_358_338.895192828, 3_503_549.843504374]
    const state = new Map<string, unknown>([[
      'ref_layer',
      valueRef('ref_layer', 'layer', {
        featureCollection: {
          type: 'FeatureCollection',
          features: [{
            type: 'Feature', properties: { name: '测试区' },
            geometry: {
              type: 'Polygon',
              coordinates: [[[x, y], [x + 1_000, y], [x + 1_000, y + 1_000], [x, y + 1_000], [x, y]]],
            },
          }],
        },
      }, { metadata: { crs: 'EPSG:3857' } }),
    ]])
    const tool = meteorologyTools.find(candidate => candidate.name === 'prepare_nowcast_scope')!
    const result = await tool.handler({ question: '测试区未来降雨？', scope_ref: 'ref_layer', area_name: '测试区' }, context(state))
    const area = result.valueRefs?.[0].value as {
      features: Array<{ geometry: { coordinates: number[][][] } }>
    }

    expect(result.valueRefs?.[0].metadata).toMatchObject({
      crs: 'OGC:CRS84', sourceCrs: 'EPSG:3857', reprojected: true,
    })
    expect(area.features[0]?.geometry.coordinates[0]?.[0]?.[0]).toBeCloseTo(120, 8)
    expect(area.features[0]?.geometry.coordinates[0]?.[0]?.[1]).toBeCloseTo(30, 8)
  })

  it('rejects projected-looking nowcast boundaries without a declared CRS', async () => {
    const state = new Map<string, unknown>([[
      'ref_boundary',
      valueRef('ref_boundary', 'feature_collection', {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature', properties: { name: '测试区' },
          geometry: {
            type: 'Polygon',
            coordinates: [[
              [13_358_338, 3_503_549], [13_359_338, 3_503_549],
              [13_359_338, 3_504_549], [13_358_338, 3_504_549], [13_358_338, 3_503_549],
            ]],
          },
        }],
      }),
    ]])
    const tool = meteorologyTools.find(candidate => candidate.name === 'prepare_nowcast_scope')!

    await expect(tool.handler({ question: '测试区未来降雨？', scope_ref: 'ref_boundary' }, context(state)))
      .rejects.toThrow('投影坐标必须显式声明 CRS')
  })

  it('accepts and validates bbox scopes through the registered tool contract', async () => {
    const registry = new ToolRegistry()
    registry.register(provider)
    const state = new Map<string, unknown>([[
      'ref_bbox', valueRef('ref_bbox', 'bbox', [119, 29, 121, 31], { metadata: { crs: 'OGC:CRS84' } }),
    ]])

    const result = await registry.execute('prepare_nowcast_scope', {
      question: '这个范围未来降雨？', scope_ref: 'ref_bbox',
    }, context(state))

    expect(result.valueRefs?.[0]).toMatchObject({ kind: 'bbox', value: [119, 29, 121, 31] })
  })

  it('fails instead of fetching or fabricating a boundary when no existing reference is provided', async () => {
    const tool = meteorologyTools.find(candidate => candidate.name === 'prepare_nowcast_scope')!
    await expect(tool.handler({ question: '接下来天气怎么样？' }, context()))
      .rejects.toThrow('短时临近预报范围必须来自平台已有图层')
  })

  it('delivers the standard answer together with a peak-time raster artifact', async () => {
    stubRuntimeEnv()
    const fetchMock = stubWorkerFetch([
      {
        answer: '15分钟后开始出现达到有效阈值的降雨，30分钟后降雨强度达到峰值。',
        basis: [],
      },
      {
        coordinates: [[119, 31], [121, 31], [121, 29], [119, 29]],
        bounds: [119, 29, 121, 31],
        variable: 'QPF',
        width: 640,
        height: 480,
      },
    ])
    const state = new Map<string, unknown>([[
      'ref_analysis',
      {
        refId: 'ref_analysis',
        kind: 'nowcast_analysis',
        label: '短时临近预报（短临）分析',
        value: {
          scope: { renderBbox: [119, 29, 121, 31] },
          mapCandidates: [
            {
              datasetId: 'dataset_latest', contentHash: '1'.repeat(64), filename: 'latest.nc',
              label: '180分钟 QPF',
              reason: '最新时次',
              leadMinutes: 180,
              variable: 'QPF',
              relativePath: 'uploads/latest.nc',
            },
            {
              datasetId: 'dataset_peak', contentHash: '2'.repeat(64), filename: 'peak.nc',
              label: '30分钟 QPF',
              reason: '降雨峰值时次',
              leadMinutes: 30,
              variable: 'QPF',
              relativePath: 'uploads/peak.nc',
            },
          ],
        },
      },
    ]])
    const tool = meteorologyTools.find(candidate => candidate.name === 'answer_nowcast_question')!
    const result = await tool.handler(
      { nowcast_analysis_ref: 'ref_analysis', question: '接下来天气怎么样？' },
      context(state, { datasets: [
        datasetRecord('dataset_latest', 'thread_1', 'latest.nc', 'uploads/latest.nc', '1'.repeat(64)),
        datasetRecord('dataset_peak', 'thread_1', 'peak.nc', 'uploads/peak.nc', '2'.repeat(64)),
      ] }),
    )

    expect(workerToolCalls(fetchMock)).toHaveLength(2)
    expect(workerToolBody(fetchMock, 1)).toMatchObject({
      args: { file_relative_path: 'uploads/peak.nc', variable: 'QPF', bbox: [119, 29, 121, 31] },
    })
    expect(result.payload.answer).toBe('15分钟后开始出现达到有效阈值的降雨，30分钟后降雨强度达到峰值。')
    expect(result.payload.map).toMatchObject({ reason: '降雨峰值时次', leadMinutes: 30 })
    expect(result.artifacts?.[0]).toMatchObject({
      artifactType: 'raster_png',
      metadata: {
        coordinates: [[119, 31], [121, 31], [121, 29], [119, 29]],
        nowcastMapReason: '降雨峰值时次',
        nowcastLeadMinutes: 30,
      },
    })
  })

  it('passes the full radar mosaic contract to the worker and records provenance', async () => {
    stubRuntimeEnv()
    const fetchMock = stubWorkerFetch([{
      targetTime: '202604091955',
      strategy: 'quality',
      product: 'echo_top',
      stationsUsed: ['Z9001'],
      valueRange: { min: 1, max: 9 },
      bounds: [119, 29, 121, 31],
      coordinates: [[119, 31], [121, 31], [121, 29], [119, 29]],
    }])
    const radarFiles = [{ datasetId: 'dataset_radar', contentHash: '3'.repeat(64), name: 'sample.bz2', relativePath: 'uploads/sample.bz2' }]
    const membersFingerprint = meteorologicalMembersFingerprint(radarFiles)
    const state = new Map<string, unknown>([
      ['ref_radar_collection', valueRef('ref_radar_collection', 'radar_station_collection', {
        files: radarFiles,
      })],
      ['ref_time', valueRef('ref_time', 'radar_target_time', '202604091955', { metadata: { membersFingerprint } })],
      ['ref_strategy', valueRef('ref_strategy', 'radar_mosaic_strategy', { strategy: 'quality' })],
    ])
    const tool = meteorologyTools.find(candidate => candidate.name === 'render_radar_mosaic')!
    const result = await tool.handler({
      radar_collection_ref: 'ref_radar_collection',
      target_time_ref: 'ref_time',
      strategy_ref: 'ref_strategy',
      product: 'echo_top',
      level_index: 2,
      tolerance_sec: 600,
      grid_res_km: 0.5,
      min_dbz: 3,
    }, context(state, {
      datasets: [datasetRecord('dataset_radar', 'thread_1', 'sample.bz2', 'uploads/sample.bz2', '3'.repeat(64))],
    }))

    const body = workerToolBody(fetchMock)
    expect(body.args).toMatchObject({
      product: 'echo_top',
      level_index: 2,
      tolerance_sec: 600,
      grid_res_km: 0.5,
      min_dbz: 3,
      output_png_relative_path: expect.stringMatching(/^artifacts\/run_1\/artifact_/u),
      output_map_png_relative_path: expect.stringMatching(/^artifacts\/run_1\/artifact_/u),
      output_npz_relative_path: expect.stringMatching(/^artifacts\/run_1\/artifact_/u),
    })
    expect(result.valueRefs?.[0]).toMatchObject({
      kind: 'radar_mosaic_result',
      value: { mapPngArtifactId: expect.stringMatching(/^artifact_/u) },
    })
    expect(result.artifacts).toHaveLength(3)
    expect(result.artifacts?.[1]).toMatchObject({
      artifactType: 'raster_png',
      display: { surfaces: ['map', 'download'], primarySurface: 'map' },
      metadata: {
        previewRole: 'radar_mosaic_overlay',
        coordinates: [[119, 31], [121, 31], [121, 29], [119, 29]],
      },
    })
    expect(result.artifacts?.[0]).toMatchObject({
      display: { surfaces: ['mini_app', 'download'], primarySurface: 'mini_app' },
      metadata: { previewRole: 'radar_mosaic' },
    })
    expect(result.provenance).toMatchObject({
      thirdPartySource: 'radar_mosaic_agent',
      sourceSnapshot: 'packages/gis-meteorology/src/gis_meteorology/third_party/radar_mosaic_agent/source/original',
      wrapperVersion: 'geo-agent-platform-wrapper-2026-06-23',
      inputRefs: {
        radarCollectionRef: 'ref_radar_collection',
        targetTimeRef: 'ref_time',
        strategyRef: 'ref_strategy',
      },
    })
    expect(result.provenance?.outputArtifacts).toHaveLength(3)
  })

  it('inspects radar station collections and emits target-time refs', async () => {
    stubRuntimeEnv()
    const fetchMock = stubWorkerFetch([{
      stationCount: 1,
      fileCount: 1,
      products: ['reflectivity', 'echo_top'],
      candidateTimes: [{ timestamp: '202604091955', fileCount: 1 }],
    }])
    const state = new Map<string, unknown>([
      ['ref_radar_files', valueRef('ref_radar_files', 'radar_file_collection', {
        files: [{
          datasetId: 'dataset_radar', contentHash: '4'.repeat(64),
          name: 'RADA_CHN_Z9001_VOL_20260409195500_O_DOR_SAD_CAP_FMT.bin.bz2', relativePath: 'objects/sha256/aa/hash.bz2',
        }],
      })],
    ])
    const tool = meteorologyTools.find(candidate => candidate.name === 'inspect_radar_station_collection')!
    const result = await tool.handler({ radar_collection_ref: 'ref_radar_files' }, context(state, {
      datasets: [datasetRecord(
        'dataset_radar', 'thread_1', 'RADA_CHN_Z9001_VOL_20260409195500_O_DOR_SAD_CAP_FMT.bin.bz2',
        'objects/sha256/aa/hash.bz2', '4'.repeat(64),
      )],
    }))

    expect(workerToolBody(fetchMock)).toMatchObject({
      args: {
        files: [{ name: 'RADA_CHN_Z9001_VOL_20260409195500_O_DOR_SAD_CAP_FMT.bin.bz2', relativePath: 'objects/sha256/aa/hash.bz2' }],
      },
    })
    expect(result.valueRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'radar_station_collection' }),
      expect.objectContaining({ kind: 'radar_target_time', value: '202604091955' }),
    ]))
    expect(result.provenance).toMatchObject({
      thirdPartySource: 'radar_mosaic_agent',
      inputRefs: { radarCollectionRef: 'ref_radar_files' },
    })
  })

  it('compares radar mosaic output with a NetCDF reference and records slider artifacts', async () => {
    stubRuntimeEnv()
    const fetchMock = stubWorkerFetch([{
      ncFile: 'reference.nc',
      stats: { rmse: 0.5, mae: 0.25 },
    }])
    const state = new Map<string, unknown>([
      ['ref_mosaic', valueRef('ref_mosaic', 'radar_mosaic_result', {
        npzRelativePath: 'artifacts/run_1/mosaic.npz',
        membersFingerprint: 'radar_members_1',
      })],
      ['ref_dataset', valueRef('ref_dataset', 'meteorological_dataset', {
        datasetId: 'dataset_reference', contentHash: '5'.repeat(64),
        name: 'reference.nc',
        relativePath: 'objects/sha256/bb/reference.nc',
      }, { metadata: lineage('dataset_reference', '5'.repeat(64)) })],
      ['ref_time', valueRef('ref_time', 'radar_target_time', '202604091955', {
        metadata: { membersFingerprint: 'radar_members_1' },
      })],
    ])
    const tool = meteorologyTools.find(candidate => candidate.name === 'compare_radar_mosaic_reference')!
    const result = await tool.handler({
      radar_mosaic_result_ref: 'ref_mosaic',
      dataset_ref: 'ref_dataset',
      target_time_ref: 'ref_time',
      level_index: 1,
      product_label: '回波顶高',
      product_unit: 'km',
      min_display: 2,
    }, context(state, {
      datasets: [datasetRecord('dataset_reference', 'thread_1', 'reference.nc', 'objects/sha256/bb/reference.nc', '5'.repeat(64))],
    }))

    expect(workerToolBody(fetchMock)).toMatchObject({
      args: {
        mosaic_npz_relative_path: 'artifacts/run_1/mosaic.npz',
        reference_files: [{ name: 'reference.nc', relativePath: 'objects/sha256/bb/reference.nc' }],
        target_time: '202604091955',
        level_index: 1,
        product_label: '回波顶高',
        product_unit: 'km',
        min_display: 2,
      },
    })
    expect(result.valueRefs?.[0]).toMatchObject({ kind: 'radar_mosaic_comparison' })
    expect(result.artifacts).toEqual([
      expect.objectContaining({ artifactType: 'raster_png' }),
      expect.objectContaining({ artifactType: 'raster_png' }),
    ])
    expect(result.artifacts?.[0].metadata).toMatchObject({
      previewRole: 'radar_reference_comparison',
      baseImageArtifactId: expect.stringMatching(/^artifact_/u),
      overlayImageArtifactId: expect.stringMatching(/^artifact_/u),
    })
  })

  it('hard-fails third-party tools when the valueRef kind is wrong', async () => {
    const state = new Map<string, unknown>([
      ['ref_file', valueRef('ref_file', 'meteorological_file', { name: 'rain.nc', relativePath: 'uploads/rain.nc' })],
    ])
    const tool = meteorologyTools.find(candidate => candidate.name === 'render_rainfall_risk_map')!

    await expect(tool.handler({
      dataset_ref: 'ref_file',
      variable_ref: 'ref_missing',
      boundary_ref: 'ref_missing',
      thresholds_ref: 'ref_missing',
    }, context(state))).rejects.toThrow('dataset_ref 必须引用 meteorological_dataset')
  })

  it('sends the original filename with dataset object paths', async () => {
    stubRuntimeEnv()
    const fetchMock = stubWorkerFetch([{
      variables: [{ name: 'QPF', unit: 'mm', analysisReady: true, mapReady: true }],
      bounds: [119, 29, 121, 31],
      times: ['2026-08-08T00:00:00Z'],
      levels: [850],
    }])
    const state = new Map<string, unknown>([
      ['ref_file', valueRef('ref_file', 'meteorological_file', {
        datasetId: 'dataset_1',
        contentHash: 'a'.repeat(64),
        name: '202604091955_202604092000.nc',
        relativePath: 'objects/sha256/ab/abcdef',
      }, { metadata: lineage('dataset_1', 'a'.repeat(64)) })],
    ])
    const tool = meteorologyTools.find(candidate => candidate.name === 'meteorological_inspect')!
    const result = await tool.handler({ dataset_ref: 'ref_file' }, context(state, {
      datasets: [datasetRecord('dataset_1', 'thread_1', '202604091955_202604092000.nc', 'objects/sha256/ab/abcdef', 'a'.repeat(64))],
    }))

    expect(workerToolBody(fetchMock)).toMatchObject({
      args: {
        file_relative_path: 'objects/sha256/ab/abcdef',
        file_name: '202604091955_202604092000.nc',
      },
    })
    expect(result.valueRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'meteorological_dataset', metadata: lineage('dataset_1', 'a'.repeat(64)) }),
      expect.objectContaining({
        kind: 'meteorological_variable', unit: 'mm',
        metadata: lineage('dataset_1', 'a'.repeat(64), 'QPF'),
      }),
      expect.objectContaining({ kind: 'bbox', metadata: lineage('dataset_1', 'a'.repeat(64)) }),
      expect.objectContaining({ kind: 'meteorological_time_index', metadata: lineage('dataset_1', 'a'.repeat(64)) }),
      expect.objectContaining({ kind: 'meteorological_level_index', metadata: lineage('dataset_1', 'a'.repeat(64)) }),
    ]))
  })

  it('resolves latest_upload only inside the current thread', async () => {
    stubRuntimeEnv()
    const fetchMock = stubWorkerFetch([{ variables: [], times: [], levels: [] }])
    const datasets = [
      datasetRecord('dataset_other_thread', 'thread_other', 'other.nc', 'objects/other.nc', 'b'.repeat(64), '2026-08-08T02:00:00.000Z'),
      datasetRecord('dataset_current_thread', 'thread_1', 'current.nc', 'objects/current.nc', 'c'.repeat(64), '2026-08-08T01:00:00.000Z'),
    ]
    const tool = meteorologyTools.find(candidate => candidate.name === 'meteorological_inspect')!

    await tool.handler({ dataset_id: 'latest_upload' }, context(new Map(), { datasets }))

    expect(workerToolBody(fetchMock).args).toMatchObject({
      file_name: 'current.nc',
      file_relative_path: 'objects/current.nc',
    })
  })

  it('rejects latest_upload as a magic dataset_ref instead of bypassing valueRef resolution', async () => {
    const registry = new ToolRegistry()
    registry.register(provider)

    await expect(registry.execute('meteorological_inspect', {
      dataset_ref: 'latest_upload',
    }, context())).rejects.toThrow('未知 valueRef')
  })

  it('rejects a schema-declared valueRef kind before the handler executes', async () => {
    const registry = new ToolRegistry()
    registry.register(provider)
    const state = scientificState({ variableKind: 'bbox' })

    await expect(registry.execute('meteorological_stats', {
      dataset_ref: 'ref_dataset_b',
      variable_ref: 'ref_variable',
    }, context(state))).rejects.toThrow('variable_ref 必须引用 meteorological_variable，实际为 bbox')
  })

  it('rejects a variable from dataset A when dataset B is selected', async () => {
    const state = scientificState({ variableDatasetId: 'dataset_a', variableHash: 'a'.repeat(64) })
    const tool = meteorologyTools.find(candidate => candidate.name === 'meteorological_stats')!

    await expect(tool.handler({
      dataset_ref: 'ref_dataset_b',
      variable_ref: 'ref_variable',
    }, context(state, {
      datasets: [datasetRecord('dataset_b', 'thread_1', 'b.nc', 'objects/b.nc', 'b'.repeat(64))],
    }))).rejects.toThrow('与 dataset_ref dataset_b@')
  })

  it('batch-verifies a sequence collection once and rejects an unrelated variable before worker execution', async () => {
    stubRuntimeEnv()
    const fetchMock = stubWorkerFetch([])
    const files = [
      { datasetId: 'dataset_b', contentHash: 'b'.repeat(64), name: 'b.nc', relativePath: 'objects/b.nc' },
      { datasetId: 'dataset_c', contentHash: 'c'.repeat(64), name: 'c.nc', relativePath: 'objects/c.nc' },
    ]
    const state = new Map<string, unknown>([
      ['ref_collection', valueRef('ref_collection', 'meteorological_file_collection', { files })],
      ['ref_variable_a', valueRef('ref_variable_a', 'meteorological_variable', {
        datasetId: 'dataset_a', contentHash: 'a'.repeat(64), name: 'QPF',
      }, { unit: 'mm', metadata: lineage('dataset_a', 'a'.repeat(64), 'QPF') })],
    ])
    const ctx = context(state, { datasets: [
      datasetRecord('dataset_b', 'thread_1', 'b.nc', 'objects/b.nc', 'b'.repeat(64)),
      datasetRecord('dataset_c', 'thread_1', 'c.nc', 'objects/c.nc', 'c'.repeat(64)),
    ] })
    const resolveMany = vi.fn(ctx.resolveMeteorologicalDatasets!)
    ctx.resolveMeteorologicalDatasets = resolveMany
    const tool = meteorologyTools.find(candidate => candidate.name === 'create_nowcast_sequence')!

    await expect(tool.handler({
      file_collection_ref: 'ref_collection',
      variable_ref: 'ref_variable_a',
    }, ctx)).rejects.toThrow('variable_ref 不属于短时临近预报文件集')
    expect(resolveMany).toHaveBeenCalledOnce()
    expect(resolveMany).toHaveBeenCalledWith(['dataset_b', 'dataset_c'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a Kelvin threshold for a millimetre variable before worker execution', async () => {
    const state = scientificState({ thresholdUnit: 'K' })
    const tool = meteorologyTools.find(candidate => candidate.name === 'meteorological_threshold')!

    await expect(tool.handler({
      dataset_ref: 'ref_dataset_b',
      variable_ref: 'ref_variable',
      threshold_ref: 'ref_threshold',
    }, context(state, {
      datasets: [datasetRecord('dataset_b', 'thread_1', 'b.nc', 'objects/b.nc', 'b'.repeat(64))],
    }))).rejects.toThrow('单位 K 与变量单位 mm 不兼容')
  })

  it('supports only explicit compatible unit conversions', () => {
    expect(convertMeteorologicalUnitValue(0, '°C', 'K', 'threshold_ref')).toBeCloseTo(273.15)
    expect(convertMeteorologicalUnitValue(1, 'kg m-2', 'mm', 'threshold_ref')).toBeCloseTo(1)
  })

  it('accepts rainfall threshold objects through the registry validator', async () => {
    const registry = new ToolRegistry()
    registry.register(provider)
    const state = scientificState()
    const result = await registry.execute('define_rainfall_risk_thresholds', {
      dataset_ref: 'ref_dataset_b',
      variable_ref: 'ref_variable',
      thresholds: [
        { label: '小雨', min: 0, max: 1, color: '#f0f0f0' },
        { label: '强降雨', min: 1, max: 999, color: '#d73027' },
      ],
    }, context(state, {
      datasets: [datasetRecord('dataset_b', 'thread_1', 'b.nc', 'objects/b.nc', 'b'.repeat(64))],
    }))

    expect(result.valueRefs?.[0]).toMatchObject({
      kind: 'rainfall_risk_thresholds', unit: 'mm',
      metadata: lineage('dataset_b', 'b'.repeat(64), 'QPF'),
    })
    expect(result.payload.thresholds).toHaveLength(2)
  })

  it('returns a map-native GeoJSON artifact for rainfall risk regions', async () => {
    stubRuntimeEnv()
    const fetchMock = stubWorkerFetch([{
      variable: 'QPF',
      units: 'mm',
      mapMode: 'regional',
      aggregation: 'mean',
      bounds: [119, 29, 121, 31],
      thresholds: [{ label: '强降雨', min: 1, max: 999, color: '#d73027' }],
      regionSummary: { counts: { 强降雨: 1 }, topRegions: [{ name: '测试区', value: 3 }] },
      outputs: { png: 'risk.png', geojson: 'risk.geojson' },
    }])
    const state = new Map<string, unknown>([
      ['ref_dataset', valueRef('ref_dataset', 'meteorological_dataset', {
        datasetId: 'dataset_1',
        contentHash: 'a'.repeat(64),
        name: 'rain.nc',
        relativePath: 'objects/sha256/aa/rain.nc',
      }, { metadata: lineage('dataset_1', 'a'.repeat(64)) })],
      ['ref_variable', valueRef('ref_variable', 'meteorological_variable', {
        datasetId: 'dataset_1', contentHash: 'a'.repeat(64), name: 'QPF',
      }, { unit: 'mm', metadata: lineage('dataset_1', 'a'.repeat(64), 'QPF') })],
      ['ref_boundary', valueRef('ref_boundary', 'meteorological_file', {
        datasetId: 'dataset_boundary',
        contentHash: 'd'.repeat(64),
        name: 'boundary.geojson',
        relativePath: 'objects/sha256/bb/boundary.geojson',
      }, { metadata: lineage('dataset_boundary', 'd'.repeat(64)) })],
      ['ref_thresholds', valueRef('ref_thresholds', 'rainfall_risk_thresholds', {
        unit: 'mm', variable: 'QPF',
        thresholds: [{ label: '强降雨', min: 1, max: 999, color: '#d73027' }],
      }, { unit: 'mm', metadata: lineage('dataset_1', 'a'.repeat(64), 'QPF') })],
    ])
    const tool = meteorologyTools.find(candidate => candidate.name === 'render_rainfall_risk_map')!
    const result = await tool.handler({
      dataset_ref: 'ref_dataset',
      variable_ref: 'ref_variable',
      boundary_ref: 'ref_boundary',
      thresholds_ref: 'ref_thresholds',
    }, context(state, {
      datasets: [
        datasetRecord('dataset_1', 'thread_1', 'rain.nc', 'objects/sha256/aa/rain.nc', 'a'.repeat(64)),
        datasetRecord('dataset_boundary', 'thread_1', 'boundary.geojson', 'objects/sha256/bb/boundary.geojson', 'd'.repeat(64)),
      ],
    }))

    const body = workerToolBody(fetchMock)
    expect(body.args).toMatchObject({
      output_relative_path: expect.stringMatching(/artifact_.*\.png$/u),
      output_geojson_relative_path: expect.stringMatching(/artifact_.*\.geojson$/u),
    })
    expect(result.valueRefs?.[0]).toMatchObject({
      kind: 'rainfall_risk_map_result',
      value: {
        artifactId: expect.stringMatching(/^artifact_/u),
        geojsonArtifactId: expect.stringMatching(/^artifact_/u),
      },
    })
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        artifactType: 'raster_png',
        display: expect.objectContaining({ surfaces: ['mini_app', 'download'] }),
      }),
      expect.objectContaining({
        artifactType: 'geojson',
        display: expect.objectContaining({ surfaces: ['map', 'download'] }),
        metadata: expect.objectContaining({
          mapRole: 'rainfall_risk_regions',
          previewArtifactId: expect.stringMatching(/^artifact_/u),
        }),
      }),
    ])
  })

  it('accepts a layer valueRef with embedded features as rainfall risk boundary input', async () => {
    stubRuntimeEnv()
    const fetchMock = stubWorkerFetch([{
      variable: 'QPF',
      units: 'mm',
      mapMode: 'regional',
      aggregation: 'mean',
      bounds: [119, 29, 121, 31],
      thresholds: [{ label: '强降雨', min: 1, max: 999, color: '#d73027' }],
      regionSummary: { counts: { 强降雨: 1 }, topRegions: [{ name: '测试区', value: 3 }] },
      outputs: { png: 'risk.png', geojson: 'risk.geojson' },
    }])
    const state = new Map<string, unknown>([
      ['ref_dataset', valueRef('ref_dataset', 'meteorological_dataset', {
        datasetId: 'dataset_1',
        contentHash: 'a'.repeat(64),
        name: 'rain.nc',
        relativePath: 'objects/sha256/aa/rain.nc',
      }, { metadata: lineage('dataset_1', 'a'.repeat(64)) })],
      ['ref_variable', valueRef('ref_variable', 'meteorological_variable', {
        datasetId: 'dataset_1', contentHash: 'a'.repeat(64), name: 'QPF',
      }, { unit: 'mm', metadata: lineage('dataset_1', 'a'.repeat(64), 'QPF') })],
      ['ref_layer', valueRef('ref_layer', 'layer', {
        layerKey: 'hangzhou_admin',
        featureCollection: { type: 'FeatureCollection', features: [feature('测试区')] },
      })],
      ['ref_thresholds', valueRef('ref_thresholds', 'rainfall_risk_thresholds', {
        unit: 'mm', variable: 'QPF',
        thresholds: [{ label: '强降雨', min: 1, max: 999, color: '#d73027' }],
      }, { unit: 'mm', metadata: lineage('dataset_1', 'a'.repeat(64), 'QPF') })],
    ])
    const tool = meteorologyTools.find(candidate => candidate.name === 'render_rainfall_risk_map')!
    await tool.handler({
      dataset_ref: 'ref_dataset',
      variable_ref: 'ref_variable',
      boundary_ref: 'ref_layer',
      thresholds_ref: 'ref_thresholds',
    }, context(state, {
      datasets: [datasetRecord('dataset_1', 'thread_1', 'rain.nc', 'objects/sha256/aa/rain.nc', 'a'.repeat(64))],
    }))

    const body = workerToolBody(fetchMock)
    expect(body.args.boundary_relative_path).toMatch(/^artifacts\/run_1\/boundary_.*\.geojson$/u)
  })

  it('creates rainfall thresholds and area rainfall artifacts with third-party provenance', async () => {
    stubRuntimeEnv()
    const thresholdTool = meteorologyTools.find(candidate => candidate.name === 'define_rainfall_risk_thresholds')!
    const thresholdState = scientificState()
    const thresholds = await thresholdTool.handler({
      dataset_ref: 'ref_dataset_b',
      variable_ref: 'ref_variable',
      thresholds: [
        { label: '小雨', min: 0, max: 1, color: '#f0f0f0' },
        { label: '强降雨', min: 1, max: 999, color: '#d73027' },
      ],
    }, context(thresholdState, {
      datasets: [datasetRecord('dataset_b', 'thread_1', 'b.nc', 'objects/b.nc', 'b'.repeat(64))],
    }))
    expect(thresholds.valueRefs?.[0]).toMatchObject({ kind: 'rainfall_risk_thresholds' })
    expect(thresholds.payload.thresholds).toHaveLength(2)
    expect(thresholds.provenance).toMatchObject({
      thirdPartySource: 'rainfall_risk_map',
      sourceSnapshot: 'packages/gis-meteorology/src/gis_meteorology/third_party/rainfall_risk_map/source/original',
    })

    const fetchMock = stubWorkerFetch([{
      regionCount: 1,
      topN: 1,
      topRows: [{ rank: 1, region: '测试区', areaRainfall: 3 }],
    }])
    const state = new Map<string, unknown>([
      ['ref_collection', valueRef('ref_collection', 'meteorological_file_collection', {
        files: [{
          datasetId: 'dataset_table', contentHash: 'e'.repeat(64),
          name: '202604091955_202604092000.nc', relativePath: 'uploads/a.nc',
        }],
      })],
      ['ref_boundary', valueRef('ref_boundary', 'meteorological_file', {
        datasetId: 'dataset_table_boundary', contentHash: 'f'.repeat(64),
        name: 'boundary.geojson',
        relativePath: 'uploads/boundary.geojson',
      }, { metadata: lineage('dataset_table_boundary', 'f'.repeat(64)) })],
    ])
    const tableTool = meteorologyTools.find(candidate => candidate.name === 'generate_area_rainfall_table')!
    const table = await tableTool.handler({
      file_collection_ref: 'ref_collection',
      boundary_ref: 'ref_boundary',
      top_n: 1,
      style: { titleText: '测试表格' },
    }, context(state, {
      datasets: [
        datasetRecord('dataset_table', 'thread_1', '202604091955_202604092000.nc', 'uploads/a.nc', 'e'.repeat(64)),
        datasetRecord('dataset_table_boundary', 'thread_1', 'boundary.geojson', 'uploads/boundary.geojson', 'f'.repeat(64)),
      ],
    }))

    const body = workerToolBody(fetchMock)
    expect(body.args).toMatchObject({
      files: [{ name: '202604091955_202604092000.nc', relativePath: 'uploads/a.nc' }],
      boundary_relative_path: 'uploads/boundary.geojson',
      top_n: 1,
      style: { titleText: '测试表格' },
    })
    expect(table.artifacts).toEqual([
      expect.objectContaining({
        artifactType: 'xlsx',
        display: expect.objectContaining({ surfaces: ['download'] }),
      }),
      expect.objectContaining({
        artifactType: 'raster_png',
        display: expect.objectContaining({ surfaces: ['mini_app', 'download'] }),
      }),
    ])
    expect(table.provenance).toMatchObject({
      thirdPartySource: 'short_term_forecast',
      sourceSnapshot: 'packages/gis-meteorology/src/gis_meteorology/third_party/short_term_forecast/source/original',
    })
  })
})

function feature(name: string) {
  return {
    type: 'Feature',
    properties: { name },
    geometry: {
      type: 'Polygon',
      coordinates: [[[119, 29], [120, 29], [120, 30], [119, 30], [119, 29]]],
    },
  }
}

function response(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response
}

function workerResponse(payload: Record<string, unknown>): Response {
  return response({ message: '执行完成', payload })
}

function stubWorkerFetch(payloads: Record<string, unknown>[]) {
  const queue = [...payloads]
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/tools/catalog')) return response(workerCatalog())
    const payload = queue.shift()
    if (!payload) throw new Error(`测试缺少 Worker 工具响应: ${url}`)
    await simulateWorkerGeoJsonOutput(init, payload)
    return workerResponse(payload)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function simulateWorkerGeoJsonOutput(init: RequestInit | undefined, payload: Record<string, unknown>): Promise<void> {
  if (typeof init?.body !== 'string') return
  const body = JSON.parse(init.body) as { args?: Record<string, unknown> }
  const relativePath = body.args?.output_geojson_relative_path
  if (typeof relativePath !== 'string') return
  const bounds = Array.isArray(payload.bounds) && payload.bounds.length === 4
    ? payload.bounds as [number, number, number, number]
    : [119, 29, 121, 31] as [number, number, number, number]
  const [west, south, east, north] = bounds
  const target = path.resolve(testEnv.RUNTIME_ROOT, relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { risk_level: '强降雨' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
      },
    }],
  }), 'utf8')
  workerGeoJsonOutputs.push(target)
}

function workerToolCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([input]) => {
    const url = String(input)
    return url.includes('/tools/') && !url.endsWith('/tools/catalog')
  })
}

function workerToolBody(fetchMock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const call = workerToolCalls(fetchMock)[index]
  if (!call) throw new Error(`缺少第 ${index + 1} 个 Worker 工具调用`)
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>
}

function workerCatalog(): WorkerToolCatalog {
  const tools = REQUIRED_METEOROLOGY_WORKER_TOOLS.map(toolName => {
    const contract: ToolContractManifest = {
      providerId: 'geo-platform-meteorology-worker',
      toolName,
      version: '0.1.0',
      parametersSchema: { type: 'object', additionalProperties: true },
      resultSchema: { type: 'object', additionalProperties: true },
      valueRefInputs: [],
      valueRefOutputs: [],
      readOnly: toolName !== 'meteorological_report',
      destructive: false,
      timeoutSeconds: 300,
      displaySurfaces: [],
    }
    return {
      toolName,
      route: `/tools/${toolName}`,
      contract,
      schemaHash: workerContractHash(contract),
    }
  })
  return { tools, count: tools.length }
}

function stubRuntimeEnv() {
  vi.stubEnv('API_PORT', '8000')
  vi.stubEnv('API_HOST', '127.0.0.1')
  vi.stubEnv('DATABASE_URL', 'postgres://test:test@127.0.0.1/test')
  vi.stubEnv('RUNTIME_ROOT', 'runtime')
  vi.stubEnv('APP_BASE_URL', 'http://127.0.0.1:8000')
  vi.stubEnv('BETTER_AUTH_URL', 'http://127.0.0.1:8000')
  vi.stubEnv('BETTER_AUTH_SECRET', 'test_better_auth_secret_32_bytes__')
  vi.stubEnv('WORKER_URL', 'http://worker.test')
  vi.stubEnv('WORKER_SHARED_SECRET', 'test_worker_shared_secret_32_bytes')
  vi.stubEnv('ENABLED_TOOL_PROVIDERS', 'geo-platform-meteorology')
}

function valueRef(
  refId: string,
  kind: string,
  value: unknown,
  extras: Partial<Pick<ValueRef, 'unit' | 'metadata'>> = {},
): ValueRef {
  return { refId, kind, label: refId, value, ...extras }
}

function context(
  state = new Map<string, unknown>(),
  options: { datasets?: MeteorologicalDatasetRecord[]; threadId?: string | null } = {},
): ToolContext {
  const threadId = options.threadId === undefined ? 'thread_1' : options.threadId
  const datasets = options.datasets ?? []
  return {
    runId: 'run_1',
    sessionId: 'session_1',
    threadId,
    state,
    resolveValueRef: refId => {
      const value = state.get(refId)
      if (!value) throw new Error(`未知 valueRef：${refId}`)
      return value as ReturnType<ToolContext['resolveValueRef']>
    },
    resolveMeteorologicalDataset: async input => {
      if (input.selector === 'explicit_dataset_id') {
        return datasets.find(dataset => dataset.datasetId === input.datasetId) ?? null
      }
      return datasets
        .filter(dataset => dataset.threadId === threadId)
        .filter(dataset => !input.filename || dataset.filename.toLowerCase() === input.filename.toLowerCase())
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
    },
    resolveMeteorologicalDatasets: async datasetIds => datasets.filter(dataset => datasetIds.includes(dataset.datasetId)),
    invokeStructuredModel: async () => ({}),
    log: () => undefined,
  }
}

function lineage(datasetId: string, contentHash: string, variable?: string): Record<string, string> {
  return { datasetId, contentHash, ...(variable ? { variable } : {}) }
}

function scientificState(options: {
  variableKind?: string
  variableDatasetId?: string
  variableHash?: string
  thresholdUnit?: string
} = {}): Map<string, unknown> {
  const datasetId = 'dataset_b'
  const contentHash = 'b'.repeat(64)
  const variableDatasetId = options.variableDatasetId ?? datasetId
  const variableHash = options.variableHash ?? contentHash
  return new Map<string, unknown>([
    ['ref_dataset_b', valueRef('ref_dataset_b', 'meteorological_dataset', {
      datasetId,
      contentHash,
      name: 'b.nc',
      relativePath: 'objects/b.nc',
    }, { metadata: lineage(datasetId, contentHash) })],
    ['ref_variable', valueRef('ref_variable', options.variableKind ?? 'meteorological_variable', {
      datasetId: variableDatasetId,
      contentHash: variableHash,
      name: 'QPF',
    }, { unit: 'mm', metadata: lineage(variableDatasetId, variableHash, 'QPF') })],
    ['ref_threshold', valueRef('ref_threshold', 'meteorological_threshold', 5, {
      unit: options.thresholdUnit ?? 'mm',
      metadata: lineage(datasetId, contentHash, 'QPF'),
    })],
  ])
}

function datasetRecord(
  datasetId: string,
  threadId: string,
  filename: string,
  fileRelativePath: string,
  contentHash: string,
  updatedAt = '2026-08-08T00:00:00.000Z',
): MeteorologicalDatasetRecord {
  return {
    datasetId,
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'workspace',
    sessionId: 'session_1',
    threadId,
    filename,
    originalFilename: filename,
    fileId: `${datasetId}_file`,
    fileRelativePath,
    sizeBytes: 1024,
    contentHash,
    mediaType: 'application/x-netcdf',
    status: 'ready',
    metadata: { source: 'upload' },
    createdAt: updatedAt,
    updatedAt,
  }
}

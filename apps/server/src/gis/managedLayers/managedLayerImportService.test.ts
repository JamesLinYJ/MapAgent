// +-------------------------------------------------------------------------
//
//   地理智能平台 - 托管图层幂等导入测试
//
//   文件:       managedLayerImportService.test.ts
//
//   日期:       2026年08月30日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { Database, DatabaseTransaction } from '../../db/connection.js'
import type { LayerDescriptor } from '../../schemas/types.js'
import type { GeoJsonFeatureCollection } from '../geojson.js'
import { ManagedFeatureRepository } from './managedFeatureRepository.js'
import { prepareManagedLayerImport } from './managedLayerGeometry.js'
import { ManagedLayerImportService } from './managedLayerImportService.js'
import { ManagedLayerRepository } from './managedLayerRepository.js'
import { ManagedLayerSceneProjection } from './managedLayerSceneProjection.js'

describe('ManagedLayerImportService', () => {
  it('does not rewrite features when the persisted import fingerprint is unchanged', async () => {
    const dependencies = createDependencies(false)
    const service = new ManagedLayerImportService(
      dependencies.db,
      dependencies.layers,
      dependencies.features,
      dependencies.scenes,
    )

    await expect(service.importGeoJsonLayer(importInput())).resolves.toMatchObject({
      layerKey: 'stable_seed',
      name: '稳定 Seed',
    })

    expect(dependencies.layers.upsertImportedLayer).toHaveBeenCalledOnce()
    expect(dependencies.features.replaceFeatures).not.toHaveBeenCalled()
    expect(dependencies.scenes.attach).toHaveBeenCalledOnce()
  })

  it('replaces features atomically when content or persisted metadata changed', async () => {
    const dependencies = createDependencies(true)
    const service = new ManagedLayerImportService(
      dependencies.db,
      dependencies.layers,
      dependencies.features,
      dependencies.scenes,
    )

    await service.importGeoJsonLayer(importInput())

    expect(dependencies.features.replaceFeatures).toHaveBeenCalledOnce()
    expect(dependencies.scenes.attach).toHaveBeenCalledOnce()
  })

  it('backfills an equivalent legacy system Seed without changing its version or features', async () => {
    const dependencies = createDependencies(false, {
      legacyCandidate: { mapLayerId: 'map_layer_stable_seed', metadataEquivalent: true },
      legacyContentHashMatches: true,
      backfilled: true,
    })
    const service = new ManagedLayerImportService(
      dependencies.db,
      dependencies.layers,
      dependencies.features,
      dependencies.scenes,
    )

    await service.importGeoJsonLayer(importInput())

    expect(dependencies.layers.backfillLegacyImportFingerprint).toHaveBeenCalledOnce()
    expect(dependencies.layers.upsertImportedLayer).not.toHaveBeenCalled()
    expect(dependencies.features.replaceFeatures).not.toHaveBeenCalled()
  })
})

function createDependencies(changed: boolean, legacy: {
  legacyCandidate: { mapLayerId: string; metadataEquivalent: boolean }
  legacyContentHashMatches: boolean
  backfilled: boolean
} | null = null) {
  const tx = {} as DatabaseTransaction
  const db = {
    transaction: vi.fn(async (operation: (transaction: DatabaseTransaction) => Promise<void>) => operation(tx)),
  } as unknown as Database
  const layers = {
    lockLegacySystemImportCandidate: vi.fn(async () => legacy?.legacyCandidate ?? null),
    backfillLegacyImportFingerprint: vi.fn(async () => legacy?.backfilled ?? false),
    upsertImportedLayer: vi.fn(async () => changed),
    getLayer: vi.fn(async () => layerDescriptor()),
  } as unknown as ManagedLayerRepository
  const features = {
    contentHashForLegacyImport: vi.fn(async () => {
      const prepared = prepareManagedLayerImport(importInput())
      return legacy?.legacyContentHashMatches ? prepared.contentHash : 'sha256:different'
    }),
    replaceFeatures: vi.fn(async () => undefined),
  } as unknown as ManagedFeatureRepository
  const scenes = {
    attach: vi.fn(async () => undefined),
  } as unknown as ManagedLayerSceneProjection
  return {
    db,
    layers,
    features,
    scenes,
  }
}

function importInput() {
  const collection: GeoJsonFeatureCollection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { name: 'A' },
      geometry: { type: 'Point', coordinates: [120, 30] },
    }],
  }
  return {
    collection,
    layerKey: 'stable_seed',
    name: '稳定 Seed',
    sourceType: 'system',
  }
}

function layerDescriptor(): LayerDescriptor {
  return {
    layerKey: 'stable_seed',
    name: '稳定 Seed',
    sourceType: 'system',
    geometryType: 'Point',
    srid: 4326,
    description: '',
    featureCount: 1,
    bounds: [120, 30, 120.0001, 30.0001],
    propertySchema: [],
    category: 'system',
    status: 'active',
    tags: [],
    analysisCapabilities: ['query'],
    sourceConfigSummary: null,
    sessionId: null,
    threadId: null,
    workspaceId: null,
    createdByUserId: null,
    visibility: 'workspace',
    readonly: true,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  }
}

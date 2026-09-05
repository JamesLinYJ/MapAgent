// +-------------------------------------------------------------------------
//
//   地理智能平台 - 托管图层导入服务
//
//   文件:       managedLayerImportService.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-08-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 仅在图层内容或导入语义真实变化时替换要素，保持重复 Seed 导入幂等。
// --------------------------------------------------------------------------

import type { Database } from '../../db/connection.js'
import type { LayerDescriptor } from '../../schemas/types.js'
import { ManagedFeatureRepository } from './managedFeatureRepository.js'
import { prepareManagedLayerImport } from './managedLayerGeometry.js'
import { ManagedLayerRepository } from './managedLayerRepository.js'
import { ManagedLayerSceneProjection } from './managedLayerSceneProjection.js'
import type { ImportGeoJsonLayerInput } from './managedLayerTypes.js'

/** 图层元数据、空间要素和场景挂载的原子导入用例。 */
export class ManagedLayerImportService {
  constructor(
    private readonly db: Database,
    private readonly layers: ManagedLayerRepository,
    private readonly features: ManagedFeatureRepository,
    private readonly scenes: ManagedLayerSceneProjection,
  ) {}

  async importGeoJsonLayer(input: ImportGeoJsonLayerInput): Promise<LayerDescriptor> {
    const prepared = prepareManagedLayerImport(input)
    const now = new Date()
    await this.db.transaction(async tx => {
      const legacy = await this.layers.lockLegacySystemImportCandidate(tx, prepared)
      const backfilled = legacy?.metadataEquivalent === true
        && await this.features.contentHashForLegacyImport(tx, legacy.mapLayerId) === prepared.contentHash
        && await this.layers.backfillLegacyImportFingerprint(tx, prepared)
      const changed = backfilled
        ? false
        : await this.layers.upsertImportedLayer(tx, prepared, now)
      if (changed) {
        await this.features.replaceFeatures(tx, prepared.mapLayerId, prepared.features, now)
      }
      await this.scenes.attach(tx, prepared, now)
    })
    const layer = await this.layers.getLayer(prepared.layerKey)
    if (!layer) throw new Error(`图层 '${prepared.layerKey}' 导入后无法读取`)
    return layer
  }
}

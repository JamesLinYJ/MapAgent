// +-------------------------------------------------------------------------
//
//   地理智能平台 - 托管图层几何边界测试
//
//   文件:       managedLayerGeometry.test.ts
//
//   日期:       2026年08月09日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { GeoJsonFeatureCollection } from '../geojson.js'
import { prepareManagedLayerImport } from './managedLayerGeometry.js'

describe('managed layer geometry boundary', () => {
  it('revalidates CRS84 before PostGIS can assign SRID 4326', () => {
    const collection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature', properties: {},
        geometry: { type: 'Point', coordinates: [13358338.895192828, 3503549.843504374] },
      }],
    } as unknown as GeoJsonFeatureCollection

    expect(() => prepareManagedLayerImport({
      collection,
      name: '非法投影图层',
      sourceType: 'system',
    })).toThrow('投影坐标必须显式声明 CRS')
  })

  it('derives edge-point bounds without clamping both sides to the same longitude', () => {
    const prepared = prepareManagedLayerImport({
      collection: {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [180, 90] } }],
      },
      name: '边界点',
      sourceType: 'system',
    })

    expect(prepared.bounds).toEqual([179.9999, 89.9999, 180, 90])
  })

  it('keeps identical normalized imports stable and separates content from metadata changes', () => {
    const collection: GeoJsonFeatureCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'A' },
        geometry: { type: 'Point', coordinates: [120, 30] },
      }],
    }
    const first = prepareManagedLayerImport({
      collection,
      layerKey: 'stable_seed',
      name: '稳定 Seed',
      description: '第一版说明',
      sourceType: 'system',
    })
    const repeated = prepareManagedLayerImport({
      collection: structuredClone(collection),
      layerKey: 'stable_seed',
      name: '稳定 Seed',
      description: '第一版说明',
      sourceType: 'system',
    })
    const metadataChanged = prepareManagedLayerImport({
      collection: structuredClone(collection),
      layerKey: 'stable_seed',
      name: '稳定 Seed',
      description: '更新后说明',
      sourceType: 'system',
    })
    const contentChanged = prepareManagedLayerImport({
      collection: {
        ...structuredClone(collection),
        features: [{
          type: 'Feature',
          properties: { name: 'B' },
          geometry: { type: 'Point', coordinates: [120, 30] },
        }],
      },
      layerKey: 'stable_seed',
      name: '稳定 Seed',
      description: '第一版说明',
      sourceType: 'system',
    })

    expect(repeated.contentHash).toBe(first.contentHash)
    expect(repeated.importFingerprint).toBe(first.importFingerprint)
    expect(metadataChanged.contentHash).toBe(first.contentHash)
    expect(metadataChanged.importFingerprint).not.toBe(first.importFingerprint)
    expect(contentChanged.contentHash).not.toBe(first.contentHash)
    expect(contentChanged.importFingerprint).not.toBe(first.importFingerprint)
  })

  it('ignores JSON object key insertion order when deriving the import fingerprint', () => {
    const first = prepareManagedLayerImport({
      collection: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: { district: '上城区', adcode: 330102 },
          geometry: { type: 'Point', coordinates: [120, 30] },
        }],
      },
      layerKey: 'property_order_seed',
      name: '属性顺序 Seed',
      sourceType: 'system',
    })
    const reordered = prepareManagedLayerImport({
      collection: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: { adcode: 330102, district: '上城区' },
          geometry: { type: 'Point', coordinates: [120, 30] },
        }],
      },
      layerKey: 'property_order_seed',
      name: '属性顺序 Seed',
      sourceType: 'system',
    })

    expect(reordered.contentHash).toBe(first.contentHash)
    expect(reordered.importFingerprint).toBe(first.importFingerprint)
  })
})

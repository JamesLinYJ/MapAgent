// +-------------------------------------------------------------------------
//
//   地理智能平台 - 分析图层创建工具
//
//   文件:       layerCreate.ts
//
//   日期:       2026年06月15日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 工具创建的图层属于当前 session/thread，并由 PostGIS 持久化。
// 输入必须先通过共享 GeoJSON 校验，不能用类型断言绕过边界。

import type { ToolDef } from '../../framework/types.js'
import type { ManagedLayerService } from '../../gis/managedLayers/managedLayerService.js'
import { toFeatureCollection } from '../../gis/geojson.js'
import { geoJsonSpatialMetadata } from '../../gis/geojsonCrs.js'
import { makeId } from '../../utils/ids.js'
import { geoJsonInputSchema, resolveCanonicalGeoJsonInput } from '../spatial/geoJsonInput.js'
import { LAYER_CREATE_PROMPT } from '../spatial/prompts.js'

export function createLayerCreateTool(managedLayers: ManagedLayerService): ToolDef {
  return {
    name: 'layer_create',
    label: '创建分析图层',
    description: '从 GeoJSON 创建归属于当前会话和线程的 PostGIS 分析图层。',
    prompt: LAYER_CREATE_PROMPT,
    group: '空间分析',
    tags: ['layer', 'postgis', 'visualization'],
    isReadOnly: false,
    isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: {
        geojson: geoJsonInputSchema('GeoJSON FeatureCollection、Feature 或 Geometry；优先传前序工具返回的 valueRef ID。'),
        name: { type: 'string', description: '图层显示名称' },
        description: { type: 'string', description: '图层描述', default: '' },
      },
      required: ['geojson', 'name'],
    },
    async handler(args, ctx) {
      const workspaceId = ctx.auth?.defaultWorkspaceId
      if (!workspaceId) throw new Error('创建分析图层需要有效的工作区身份。')
      const resolved = resolveCanonicalGeoJsonInput(args.geojson, ctx, 'geojson')
      const collection = toFeatureCollection(resolved.entity)
      if (!collection.features.length) throw new Error('GeoJSON 没有任何要素，无法创建图层')
      const name = requiredText(args.name, 'name')
      const description = typeof args.description === 'string' ? args.description.trim() : ''
      const layer = await managedLayers.importGeoJsonLayer({
        name,
        description,
        sourceType: 'analysis',
        category: 'analysis',
        tags: ['auto-generated', 'analysis'],
        sessionId: ctx.sessionId,
        threadId: ctx.threadId,
        workspaceId,
        createdByUserId: ctx.auth?.userId ?? null,
        canonicalGeoJson: resolved,
      })

      // 图层 key 服务于地图和 PostGIS 查询；FeatureCollection 引用服务于后续工具链。
      // 同一份输入几何不再要求模型复制到下一步，避免 valueRef 断链。
      const layerRefId = makeId('ref')
      const collectionRefId = makeId('ref')
      return {
        message: `图层“${name}”创建成功，包含 ${collection.features.length} 个要素`,
        payload: {
          operation: 'layer_create',
          layerKey: layer.layerKey,
          name: layer.name,
          featureCount: collection.features.length,
          geometryType: layer.geometryType,
          bounds: layer.bounds,
          crs: resolved.crs,
        },
        warnings: [],
        resultId: makeId('result'),
        source: 'postgis',
        provenance: { backend: 'postgis', sessionId: ctx.sessionId, threadId: ctx.threadId },
        valueRefs: [
          {
            refId: layerRefId,
            kind: 'layer',
            label: layer.name,
            value: { layerKey: layer.layerKey, featureCollection: collection },
            metadata: { featureCollectionRefId: collectionRefId, ...geoJsonSpatialMetadata(resolved) },
          },
          {
            refId: collectionRefId,
            kind: 'feature_collection',
            label: `${layer.name} 要素集合`,
            value: collection,
            metadata: { sourceLayerKey: layer.layerKey, ...geoJsonSpatialMetadata(resolved) },
          },
        ],
      }
    },
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空`)
  return value.trim()
}

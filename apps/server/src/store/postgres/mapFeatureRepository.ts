// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图要素仓储
//
//   文件:       mapFeatureRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { count, eq, sql } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { platformLayerFeatures } from '../../db/schema.js'
import type { MapFeaturePage } from '../../schemas/types.js'

interface FeatureProjectionRow extends Record<string, unknown> {
  feature_id: unknown
  geometry: unknown
  properties_json: unknown
}

/** PostGIS 要素分页与 GeoJSON 导出的唯一查询边界。 */
export class MapFeatureRepository {
  constructor(private readonly db: Database) {}

  async listFeatures(mapLayerId: string, offset: number, limit: number): Promise<MapFeaturePage> {
    const safeOffset = Math.max(0, Math.trunc(offset))
    const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)))
    const [totalRows, rows] = await Promise.all([
      this.db.select({ value: count() }).from(platformLayerFeatures)
        .where(eq(platformLayerFeatures.mapLayerId, mapLayerId)),
      // ST_AsGeoJSON 是 PostGIS 专用投影，Drizzle query builder 无对应表达式，因此集中保留在本仓储。
      this.db.execute<FeatureProjectionRow>(sql`
        SELECT feature_id, ST_AsGeoJSON(geometry)::jsonb AS geometry, properties_json
        FROM platform_layer_features
        WHERE map_layer_id = ${mapLayerId}
        ORDER BY feature_id
        OFFSET ${safeOffset}
        LIMIT ${safeLimit}
      `),
    ])
    return {
      mapLayerId,
      items: rows.rows.map(row => ({
        featureId: String(row.feature_id),
        geometry: requireRecord(row.geometry, 'geometry'),
        properties: requireRecord(row.properties_json, 'properties_json'),
      })),
      offset: safeOffset,
      limit: safeLimit,
      total: Number(totalRows[0]?.value ?? 0),
    }
  }

  async exportFeatureCollection(mapLayerId: string): Promise<Record<string, unknown>> {
    const totalRows = await this.db.select({ value: count() }).from(platformLayerFeatures)
      .where(eq(platformLayerFeatures.mapLayerId, mapLayerId))
    const total = Number(totalRows[0]?.value ?? 0)
    if (total > 50_000) throw new Error('图层要素超过 50000 条，请使用瓦片服务或分页查询。')
    // 同上：空间几何序列化由 PostGIS 完成，避免在 Node 端重复解析二进制 geometry。
    const rows = await this.db.execute<FeatureProjectionRow>(sql`
      SELECT feature_id, ST_AsGeoJSON(geometry)::jsonb AS geometry, properties_json
      FROM platform_layer_features
      WHERE map_layer_id = ${mapLayerId}
      ORDER BY feature_id
    `)
    return {
      type: 'FeatureCollection',
      features: rows.rows.map(row => ({
        type: 'Feature',
        id: String(row.feature_id),
        geometry: requireRecord(row.geometry, 'geometry'),
        properties: requireRecord(row.properties_json, 'properties_json'),
      })),
    }
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`地图要素 ${label} 不是对象`)
  }
  return value as Record<string, unknown>
}

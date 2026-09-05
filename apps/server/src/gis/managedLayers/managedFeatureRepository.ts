// +-------------------------------------------------------------------------
//
//   地理智能平台 - 托管图层要素仓储
//
//   文件:       managedFeatureRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-08-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 提供旧 Seed 要素内容摘要读取，用于无版本变化地回填稳定导入指纹。
// --------------------------------------------------------------------------

import { eq,sql,type SQL } from 'drizzle-orm'

import type { Database,DatabaseTransaction } from '../../db/connection.js'
import { decodeRequiredRecord } from '../../db/valueDecoders.js'
import { platformLayerFeatures } from '../../db/schema.js'
import type { GeoJsonFeature } from '../geojson.js'
import { parseGeoJsonEntity,requireSingleFeature } from '../geojson.js'
import { managedLayerContentHash } from './managedLayerGeometry.js'
import type { LayerFeatureQuery,LayerPropertyFilter,StoredFeature } from './managedLayerTypes.js'

interface StoredFeatureRow extends Record<string, unknown> {
  geometry: unknown
  properties: unknown
}

interface FeatureCountRow extends Record<string, unknown> {
  value: unknown
}

/** 托管图层空间要素的替换、查询和计数边界。 */
export class ManagedFeatureRepository {
  constructor(private readonly db: Database) {}

  async queryFeatures(mapLayerId: string, query: LayerFeatureQuery = {}): Promise<StoredFeature[]> {
    const safeLimit = Math.min(1_000, Math.max(1, Math.trunc(query.limit ?? 100)))
    const where = featureWhereClause(mapLayerId, query)
    // ST_AsGeoJSON、bbox 与 JSONB 属性过滤是 PostGIS 专用能力，集中在本仓储的审计过 raw SQL 中。
    const result = await this.db.execute<StoredFeatureRow>(sql`
      SELECT ST_AsGeoJSON(geometry)::jsonb AS geometry, properties_json AS properties
      FROM platform_layer_features
      WHERE ${where}
      ORDER BY feature_id
      LIMIT ${safeLimit}
    `)
    return result.rows.map(mapRowToFeature)
  }

  async featureCount(mapLayerId: string, query: Omit<LayerFeatureQuery, 'limit'> = {}): Promise<number> {
    const where = featureWhereClause(mapLayerId, query)
    // 与要素读取共用同一谓词，确保 requireComplete 比较的是筛选后的真实总数。
    const result = await this.db.execute<FeatureCountRow>(sql`
      SELECT count(*)::integer AS value
      FROM platform_layer_features
      WHERE ${where}
    `)
    return Number(result.rows[0]?.value ?? 0)
  }

  async contentHashForLegacyImport(tx: DatabaseTransaction, mapLayerId: string): Promise<string> {
    const result = await tx.execute<StoredFeatureRow>(sql`
      SELECT ST_AsGeoJSON(geometry, 15, 0)::jsonb AS geometry, properties_json AS properties
      FROM platform_layer_features
      WHERE map_layer_id = ${mapLayerId}
      ORDER BY CASE
        WHEN feature_id ~ '^feature_[0-9]+$'
          THEN substring(feature_id FROM '[0-9]+$')::bigint
        ELSE NULL
      END NULLS LAST, feature_id
    `)
    return managedLayerContentHash(result.rows.map(row => {
      const feature = mapRowToFeature(row)
      return {
        type: 'Feature' as const,
        geometry: feature.geometry,
        properties: feature.properties,
      }
    }))
  }

  async replaceFeatures(
    tx: DatabaseTransaction,
    mapLayerId: string,
    features: GeoJsonFeature[],
    now: Date,
  ): Promise<void> {
    await tx.delete(platformLayerFeatures).where(eq(platformLayerFeatures.mapLayerId, mapLayerId))
    for (let offset = 0; offset < features.length; offset += 250) {
      const batch = features.slice(offset, offset + 250)
      const values = batch.map((feature, index) => sql`(
        ${mapLayerId},
        ${`feature_${offset + index + 1}`},
        ${JSON.stringify(feature.properties ?? {})}::jsonb,
        ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(feature.geometry)}), 4326),
        ${now},
        ${now}
      )`)
      // PostGIS geometry 构造无法用普通 query builder 表达；参数仍由 Drizzle 绑定，禁止拼接 SQL 文本。
      await tx.execute(sql`
        INSERT INTO platform_layer_features (
          map_layer_id, feature_id, properties_json, geometry, created_at, updated_at
        ) VALUES ${sql.join(values, sql`, `)}
      `)
    }
  }
}

function featureWhereClause(
  mapLayerId: string,
  query: Pick<LayerFeatureQuery, 'bbox' | 'propertyFilter'>,
): SQL {
  const predicates: SQL[] = [sql`map_layer_id = ${mapLayerId}`]
  if (query.bbox) {
    predicates.push(sql`geometry && ST_MakeEnvelope(
      ${query.bbox[0]}, ${query.bbox[1]}, ${query.bbox[2]}, ${query.bbox[3]}, 4326
    )`)
  }
  if (query.propertyFilter) predicates.push(propertyFilterPredicate(query.propertyFilter))
  return sql.join(predicates, sql` AND `)
}

function propertyFilterPredicate(filter: LayerPropertyFilter): SQL {
  const alternatives = filter.values.map(value => sql`
    properties_json @> ${JSON.stringify({ [filter.property]: value })}::jsonb
  `)
  return sql`(${sql.join(alternatives, sql` OR `)})`
}

function mapRowToFeature(row: StoredFeatureRow): StoredFeature {
  const geometryEntity = parseGeoJsonEntity(row.geometry, 'PostGIS geometry')
  return {
    geometry: requireSingleFeature(geometryEntity, 'PostGIS geometry').geometry,
    properties: decodeRequiredRecord(row.properties, 'platform_layer_features.properties_json'),
  }
}

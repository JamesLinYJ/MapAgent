// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象数据集仓储
//
//   文件:       meteorologicalDatasetRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { platformMeteorologicalDatasets, platformSessions } from '../../db/schema.js'
import type { MeteorologicalDatasetRecord, SessionRecord } from '../../schemas/types.js'
import { decodeRequiredRecord, decodeRequiredTimestamp } from '../../db/valueDecoders.js'
import { mapSessionRow } from './conversationRowMappers.js'

type DatasetRow = typeof platformMeteorologicalDatasets.$inferSelect

export interface ListMeteorologicalDatasetsFilters {
  sessionId?: string | null
  threadId?: string | null
  filename?: string | null
  status?: string | null
  workspaceId?: string | null
  limit?: number
  datasetIds?: string[]
}

export interface ResolveMeteorologicalDatasetFilters {
  sessionId: string
  threadId?: string | null
  datasetId?: string | null
  filename?: string | null
  workspaceId?: string | null
}

/** 上传气象数据集元数据、作用域与文件引用的唯一写入边界。 */
export class MeteorologicalDatasetRepository {
  constructor(private readonly db: Database) {}

  async list(filters: ListMeteorologicalDatasetsFilters = {}): Promise<MeteorologicalDatasetRecord[]> {
    const limit = Math.max(1, Math.min(filters.limit ?? 100, 500))
    const conditions = buildConditions(filters)
    const query = this.db
      .select()
      .from(platformMeteorologicalDatasets)
      .orderBy(desc(platformMeteorologicalDatasets.updatedAt))
      .limit(limit)
    const rows = conditions.length > 0
      ? await query.where(and(...conditions))
      : await query
    return rows.map(mapDatasetRow)
  }

  async count(filters: ListMeteorologicalDatasetsFilters = {}): Promise<number> {
    const conditions = buildConditions(filters)
    const query = this.db
      .select({ count: count() })
      .from(platformMeteorologicalDatasets)
    const rows = conditions.length > 0
      ? await query.where(and(...conditions))
      : await query
    return rows[0]?.count ?? 0
  }

  async resolve(filters: ResolveMeteorologicalDatasetFilters): Promise<MeteorologicalDatasetRecord | null> {
    const explicitDatasetId = filters.datasetId?.trim()
    if (explicitDatasetId && explicitDatasetId !== 'latest_upload') {
      const conditions: SQL[] = [eq(platformMeteorologicalDatasets.datasetId, explicitDatasetId)]
      if (filters.workspaceId) {
        conditions.push(eq(platformMeteorologicalDatasets.workspaceId, filters.workspaceId))
      } else {
        // 无 workspace 的旧数据只能在原 session 内按 ID 解析，避免
        // 全局唯一 datasetId 成为跨租户的隐式授权凭证。
        conditions.push(eq(platformMeteorologicalDatasets.sessionId, filters.sessionId))
      }
      const rows = await this.db
        .select()
        .from(platformMeteorologicalDatasets)
        .where(and(...conditions))
        .limit(1)
      const row = rows[0]
      return row ? mapDatasetRow(row) : null
    }

    const matches = await this.list({
      sessionId: filters.sessionId,
      threadId: filters.threadId ?? null,
      filename: filters.filename ?? null,
      workspaceId: filters.workspaceId ?? null,
      limit: 1,
    })
    return matches[0] ?? null
  }

  async get(datasetId: string): Promise<MeteorologicalDatasetRecord | null> {
    const rows = await this.db
      .select()
      .from(platformMeteorologicalDatasets)
      .where(eq(platformMeteorologicalDatasets.datasetId, datasetId))
      .limit(1)
    const row = rows[0]
    return row ? mapDatasetRow(row) : null
  }

  async create(dataset: MeteorologicalDatasetRecord): Promise<SessionRecord> {
    return this.db.transaction(async tx => {
      const sessionRows = await tx.select()
        .from(platformSessions)
        .where(eq(platformSessions.sessionId, dataset.sessionId))
        .for('update')
        .limit(1)
      if (!sessionRows[0]) throw new Error(`会话 '${dataset.sessionId}' 不存在`)

      const inserted = await tx.insert(platformMeteorologicalDatasets)
        .values(toDatasetValues(dataset))
        .returning({ datasetId: platformMeteorologicalDatasets.datasetId })
      if (!inserted[0]) throw new Error(`气象数据集 '${dataset.datasetId}' 创建失败`)

      const updatedSessions = await tx.update(platformSessions).set({
        latestMeteorologicalDatasetId: dataset.datasetId,
        updatedAt: new Date(dataset.updatedAt),
      }).where(eq(platformSessions.sessionId, dataset.sessionId)).returning()
      if (!updatedSessions[0]) throw new Error(`会话 '${dataset.sessionId}' 的气象数据指针更新失败`)
      return mapSessionRow(updatedSessions[0])
    })
  }
}

function toDatasetValues(dataset: MeteorologicalDatasetRecord): typeof platformMeteorologicalDatasets.$inferInsert {
  return {
    datasetId: dataset.datasetId,
    workspaceId: dataset.workspaceId,
    createdByUserId: dataset.createdByUserId,
    visibility: dataset.visibility,
    sessionId: dataset.sessionId,
    threadId: dataset.threadId,
    filename: dataset.filename,
    originalFilename: dataset.originalFilename,
    fileId: dataset.fileId,
    fileRelativePath: dataset.fileRelativePath,
    sizeBytes: dataset.sizeBytes,
    contentHash: dataset.contentHash,
    mediaType: dataset.mediaType,
    status: dataset.status,
    metadataJson: dataset.metadata,
    createdAt: new Date(dataset.createdAt),
    updatedAt: new Date(dataset.updatedAt),
  }
}

function buildConditions(filters: ListMeteorologicalDatasetsFilters): SQL[] {
  const conditions: SQL[] = []
  if (filters.datasetIds?.length) conditions.push(inArray(platformMeteorologicalDatasets.datasetId, [...new Set(filters.datasetIds)]))
  if (filters.workspaceId) conditions.push(eq(platformMeteorologicalDatasets.workspaceId, filters.workspaceId))
  if (filters.sessionId) conditions.push(eq(platformMeteorologicalDatasets.sessionId, filters.sessionId))
  if (filters.threadId) conditions.push(eq(platformMeteorologicalDatasets.threadId, filters.threadId))
  if (filters.status) conditions.push(eq(platformMeteorologicalDatasets.status, filters.status))
  if (filters.filename) {
    conditions.push(sql`lower(${platformMeteorologicalDatasets.filename}) = lower(${filters.filename})`)
  }
  return conditions
}

function mapDatasetRow(row: DatasetRow): MeteorologicalDatasetRecord {
  return {
    datasetId: row.datasetId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    visibility: decodeVisibility(row.visibility),
    sessionId: row.sessionId,
    threadId: row.threadId,
    filename: row.filename,
    originalFilename: row.originalFilename,
    fileId: row.fileId,
    fileRelativePath: row.fileRelativePath,
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
    mediaType: row.mediaType,
    status: row.status,
    metadata: decodeRequiredRecord(row.metadataJson, 'platform_meteorological_datasets.metadata_json'),
    createdAt: decodeRequiredTimestamp(row.createdAt, 'platform_meteorological_datasets.created_at'),
    updatedAt: decodeRequiredTimestamp(row.updatedAt, 'platform_meteorological_datasets.updated_at'),
  }
}

function decodeVisibility(value: string): MeteorologicalDatasetRecord['visibility'] {
  if (value === 'private' || value === 'workspace' || value === 'public') return value
  throw new Error(`platform_meteorological_datasets.visibility 值 '${value}' 无效。`)
}

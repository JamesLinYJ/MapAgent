// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 元数据仓储
//
//   文件:       artifactMetadataRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, desc, eq, inArray, isNull, lte } from 'drizzle-orm'

import type { Database, DatabaseTransaction } from '../../db/connection.js'
import { platformArtifacts, platformRuns } from '../../db/schema.js'
import { artifactDisplaySchema, type ArtifactRef } from '../../schemas/types.js'
import type {
  ArtifactOwnerProjection,
  ArtifactRecord,
  ArtifactReader,
  VisibleArtifactQuery,
  VisibleArtifactReader,
} from './artifactRepository.js'

/** Artifact 元数据、内容引用和归属的单资源仓储。 */
export class ArtifactMetadataRepository implements ArtifactReader, VisibleArtifactReader {
  constructor(private readonly db: Database) {}

  async upsert(
    tx: DatabaseTransaction,
    artifact: ArtifactRef,
    owner: ArtifactOwnerProjection,
    relativePath: string,
  ): Promise<void> {
    await tx.insert(platformArtifacts).values({
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      workspaceId: owner.workspaceId,
      createdByUserId: owner.createdByUserId,
      visibility: owner.visibility,
      artifactType: artifact.artifactType,
      name: artifact.name,
      uri: artifact.uri,
      displayJson: artifact.display,
      metadataJson: artifact.metadata,
      contentRelativePath: relativePath,
      createdAt: new Date(),
    }).onConflictDoUpdate({
      target: platformArtifacts.artifactId,
      set: {
        name: artifact.name,
        uri: artifact.uri,
        displayJson: artifact.display,
        metadataJson: artifact.metadata,
        contentRelativePath: relativePath,
        workspaceId: owner.workspaceId,
        createdByUserId: owner.createdByUserId,
        visibility: owner.visibility,
      },
    })
  }

  async deleteRunArtifacts(runId: string): Promise<void> {
    await this.db.delete(platformArtifacts).where(eq(platformArtifacts.runId, runId))
  }

  async getArtifact(artifactId: string): Promise<ArtifactRecord | null> {
    const rows = await this.db
      .select({
        artifact: platformArtifacts,
        threadId: platformRuns.threadId,
        runCreatedAt: platformRuns.createdAt,
        runWorkspaceId: platformRuns.workspaceId,
      })
      .from(platformArtifacts)
      .innerJoin(platformRuns, eq(platformArtifacts.runId, platformRuns.runId))
      .where(eq(platformArtifacts.artifactId, artifactId))
      .limit(1)
    const row = rows[0]
    return row ? mapArtifactRow(row) : null
  }

  async listVisibleArtifacts(query: VisibleArtifactQuery): Promise<ArtifactRecord[]> {
    const artifactIds = [...new Set(query.artifactIds ?? [])]
    if (query.artifactIds && artifactIds.length === 0) return []
    const workspaceCondition = query.workspaceId === null
      ? and(isNull(platformRuns.workspaceId), isNull(platformArtifacts.workspaceId))
      : and(
          eq(platformRuns.workspaceId, query.workspaceId),
          eq(platformArtifacts.workspaceId, query.workspaceId),
        )
    const rows = await this.db
      .select({
        artifact: platformArtifacts,
        threadId: platformRuns.threadId,
        runCreatedAt: platformRuns.createdAt,
        runWorkspaceId: platformRuns.workspaceId,
      })
      .from(platformArtifacts)
      .innerJoin(platformRuns, eq(platformArtifacts.runId, platformRuns.runId))
      .where(and(
        eq(platformRuns.threadId, query.threadId),
        lte(platformRuns.createdAt, parseTimestamp(query.visibleAt, 'visibleAt')),
        workspaceCondition,
        artifactIds.length ? inArray(platformArtifacts.artifactId, artifactIds) : undefined,
      ))
      .orderBy(desc(platformArtifacts.createdAt))
      .limit(normalizeLimit(query.limit, artifactIds.length))
    return rows.map(mapArtifactRow).reverse()
  }
}

interface JoinedArtifactRow {
  artifact: typeof platformArtifacts.$inferSelect
  threadId: string | null
  runCreatedAt: Date
  runWorkspaceId: string | null
}

function mapArtifactRow(row: JoinedArtifactRow): ArtifactRecord {
  if (row.artifact.workspaceId !== row.runWorkspaceId) {
    throw new Error(`Artifact '${row.artifact.artifactId}' 的工作区归属与所属运行不一致。`)
  }
  return {
    artifactId: row.artifact.artifactId,
    runId: row.artifact.runId,
    threadId: row.threadId,
    runCreatedAt: row.runCreatedAt.toISOString(),
    workspaceId: row.artifact.workspaceId,
    createdByUserId: row.artifact.createdByUserId,
    visibility: row.artifact.visibility,
    artifactType: row.artifact.artifactType,
    name: row.artifact.name,
    uri: row.artifact.uri,
    display: artifactDisplaySchema.parse(row.artifact.displayJson),
    metadata: requireRecord(row.artifact.metadataJson, 'metadata_json'),
    relativePath: row.artifact.contentRelativePath,
    createdAt: row.artifact.createdAt.toISOString(),
  }
}

function normalizeLimit(limit: number | undefined, artifactIdCount: number): number {
  if (artifactIdCount > 1_000) throw new Error('单次最多解析 1000 个 Artifact。')
  if (artifactIdCount > 0) return artifactIdCount
  if (limit === undefined) return 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Artifact 查询 limit 必须是 1 到 1000 的整数。')
  }
  return limit
}

function parseTimestamp(value: string, label: string): Date {
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) throw new Error(`Artifact 查询 ${label} 不是合法时间。`)
  return timestamp
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Artifact ${label} 必须是对象。`)
  }
  return value as Record<string, unknown>
}

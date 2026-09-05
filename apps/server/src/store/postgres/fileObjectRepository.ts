// +-------------------------------------------------------------------------
//
//   地理智能平台 - 文件对象生命周期仓储
//
//   文件:       fileObjectRepository.ts
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { and, desc, eq, ne, or } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { platformFileObjects, platformThreads } from '../../db/schema.js'
import { decodeRequiredTimestamp } from '../../db/valueDecoders.js'
import { StoreConflictError, StoreNotFoundError } from '../storeErrors.js'

type FileObjectStatus = 'pending' | 'ready' | 'deleted'

export interface FileObjectOwner {
  workspaceId: string | null
  sessionId: string
  threadId: string
  createdByUserId: string | null
}

export interface PendingFileObjectInput extends FileObjectOwner {
  fileId: string
  name: string
  sourceKey: string
  sourceRelativePath: string | null
  relativePath: string
  contentHash: string
  sizeBytes: number
  mediaType: string
  requestId: string | null
}

export interface FileObjectRecord extends PendingFileObjectInput {
  status: FileObjectStatus
  errorMessage: string | null
  createdAt: string
  readyAt: string | null
  deletedAt: string | null
  updatedAt: string
}

export interface FileObjectPromotionResult {
  ready: FileObjectRecord
  retired: FileObjectRecord[]
}

type FileObjectRow = typeof platformFileObjects.$inferSelect

/**
 * PostgreSQL 是文件资源的生命周期账本。仓储不触碰文件系统，只负责幂等
 * 预留、状态推进和按线程读取，避免 HTTP 路由自己拼接 SQL 或状态规则。
 */
export class FileObjectRepository {
  constructor(private readonly db: Database) {}

  async reservePending(input: PendingFileObjectInput): Promise<FileObjectRecord> {
    const inserted = await this.db.insert(platformFileObjects).values({
      fileId: input.fileId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      threadId: input.threadId,
      createdByUserId: input.createdByUserId,
      name: input.name,
      sourceKey: input.sourceKey,
      sourceRelativePath: input.sourceRelativePath,
      relativePath: input.relativePath,
      contentHash: input.contentHash,
      sizeBytes: input.sizeBytes,
      mediaType: input.mediaType,
      requestId: input.requestId,
      status: 'pending',
      errorMessage: null,
      createdAt: new Date(),
      readyAt: null,
      deletedAt: null,
      updatedAt: new Date(),
    }).onConflictDoNothing().returning()

    const row = inserted[0] ?? (input.requestId
      ? (await this.db.select()
        .from(platformFileObjects)
        .where(and(
          eq(platformFileObjects.threadId, input.threadId),
          eq(platformFileObjects.requestId, input.requestId),
        ))
        .limit(1))[0]
      : undefined)
    if (!row) {
      throw new StoreConflictError(`文件 '${input.fileId}' 的上传预留发生并发冲突。`)
    }

    const existing = mapFileObject(row)
    assertSameRequest(existing, input)
    if (existing.status === 'deleted') {
      throw new StoreConflictError(`requestId '${input.requestId ?? input.fileId}' 对应的文件已删除，不能恢复。`)
    }
    return existing
  }

  /**
   * 在一个事务中提交当前版本并退役同一来源的旧版本。线程行是稳定锁，
   * 因而同一线程内两个并发上传不会互相把对方都标记为 deleted。
   */
  async promoteReadyAndRetire(fileId: string): Promise<FileObjectPromotionResult> {
    return this.db.transaction(async tx => {
      const initialRows = await tx.select()
        .from(platformFileObjects)
        .where(eq(platformFileObjects.fileId, fileId))
        .limit(1)
      const initial = initialRows[0]
      if (!initial) throw new StoreNotFoundError(`文件 '${fileId}' 不存在。`)

      const threadRows = await tx.select({ threadId: platformThreads.threadId })
        .from(platformThreads)
        .where(eq(platformThreads.threadId, initial.threadId))
        .for('update')
        .limit(1)
      if (!threadRows[0]) throw new StoreNotFoundError(`线程 '${initial.threadId}' 不存在。`)

      const currentRows = await tx.select()
        .from(platformFileObjects)
        .where(eq(platformFileObjects.fileId, fileId))
        .for('update')
        .limit(1)
      const currentRow = currentRows[0]
      if (!currentRow) throw new StoreNotFoundError(`文件 '${fileId}' 不存在。`)
      const current = mapFileObject(currentRow)
      if (current.status === 'deleted') {
        throw new StoreConflictError(`文件 '${fileId}' 已删除，不能标记为 ready。`)
      }

      const previousRows = await tx.select()
        .from(platformFileObjects)
        .where(and(
          eq(platformFileObjects.threadId, current.threadId),
          eq(platformFileObjects.sourceKey, current.sourceKey),
          or(
            eq(platformFileObjects.status, 'ready'),
            eq(platformFileObjects.status, 'deleted'),
          ),
          ne(platformFileObjects.fileId, current.fileId),
        ))

      if (current.status === 'ready') {
        return {
          ready: current,
          retired: previousRows.map(mapFileObject),
        }
      }

      const now = new Date()
      await tx.update(platformFileObjects)
        .set({
          status: 'deleted',
          deletedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(platformFileObjects.threadId, current.threadId),
          eq(platformFileObjects.sourceKey, current.sourceKey),
          eq(platformFileObjects.status, 'ready'),
          ne(platformFileObjects.fileId, current.fileId),
        ))

      const updated = await tx.update(platformFileObjects)
        .set({
          status: 'ready',
          errorMessage: null,
          readyAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(platformFileObjects.fileId, current.fileId),
          eq(platformFileObjects.status, 'pending'),
        ))
        .returning()
      if (!updated[0]) throw new StoreConflictError(`文件 '${fileId}' 未能完成 ready 状态提交。`)
      return {
        ready: mapFileObject(updated[0]),
        retired: previousRows.map(mapFileObject),
      }
    })
  }

  async markFailed(fileId: string, message: string): Promise<FileObjectRecord> {
    const updated = await this.db.update(platformFileObjects)
      .set({
        status: 'deleted',
        errorMessage: message.slice(0, 2000),
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(platformFileObjects.fileId, fileId),
        eq(platformFileObjects.status, 'pending'),
      ))
      .returning()
    if (updated[0]) return mapFileObject(updated[0])
    return this.get(fileId)
  }

  async markPendingError(fileId: string, message: string): Promise<FileObjectRecord> {
    const updated = await this.db.update(platformFileObjects)
      .set({
        errorMessage: message.slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(and(
        eq(platformFileObjects.fileId, fileId),
        eq(platformFileObjects.status, 'pending'),
      ))
      .returning()
    if (updated[0]) return mapFileObject(updated[0])
    return this.get(fileId)
  }

  async markDeleted(fileId: string): Promise<FileObjectRecord> {
    const updated = await this.db.update(platformFileObjects)
      .set({
        status: 'deleted',
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(platformFileObjects.fileId, fileId),
        eq(platformFileObjects.status, 'ready'),
      ))
      .returning()
    if (updated[0]) return mapFileObject(updated[0])
    const current = await this.get(fileId)
    if (current.status === 'deleted') return current
    throw new StoreConflictError(`文件 '${fileId}' 当前状态为 '${current.status}'，不能删除。`)
  }

  async get(fileId: string): Promise<FileObjectRecord> {
    const row = (await this.db.select()
      .from(platformFileObjects)
      .where(eq(platformFileObjects.fileId, fileId))
      .limit(1))[0]
    if (!row) throw new StoreNotFoundError(`文件 '${fileId}' 不存在。`)
    return mapFileObject(row)
  }

  async listReady(threadId: string): Promise<FileObjectRecord[]> {
    const rows = await this.db.select()
      .from(platformFileObjects)
      .where(and(
        eq(platformFileObjects.threadId, threadId),
        eq(platformFileObjects.status, 'ready'),
      ))
      .orderBy(desc(platformFileObjects.updatedAt))
    return rows.map(mapFileObject)
  }

  async listAll(threadId: string): Promise<FileObjectRecord[]> {
    const rows = await this.db.select()
      .from(platformFileObjects)
      .where(eq(platformFileObjects.threadId, threadId))
      .orderBy(desc(platformFileObjects.updatedAt))
    return rows.map(mapFileObject)
  }

  async listReferencedContentHashes(): Promise<string[]> {
    const rows = await this.db.select({ contentHash: platformFileObjects.contentHash })
      .from(platformFileObjects)
      .where(eq(platformFileObjects.status, 'ready'))
    return [...new Set(rows.map(row => row.contentHash))]
  }
}

function mapFileObject(row: FileObjectRow): FileObjectRecord {
  return {
    fileId: row.fileId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    threadId: row.threadId,
    createdByUserId: row.createdByUserId,
    name: row.name,
    sourceKey: row.sourceKey,
    sourceRelativePath: row.sourceRelativePath,
    relativePath: row.relativePath,
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    mediaType: row.mediaType,
    requestId: row.requestId,
    status: decodeStatus(row.status),
    errorMessage: row.errorMessage,
    createdAt: decodeRequiredTimestamp(row.createdAt, 'platform_file_objects.created_at'),
    readyAt: row.readyAt ? decodeRequiredTimestamp(row.readyAt, 'platform_file_objects.ready_at') : null,
    deletedAt: row.deletedAt ? decodeRequiredTimestamp(row.deletedAt, 'platform_file_objects.deleted_at') : null,
    updatedAt: decodeRequiredTimestamp(row.updatedAt, 'platform_file_objects.updated_at'),
  }
}

function decodeStatus(value: string): FileObjectStatus {
  if (value === 'pending' || value === 'ready' || value === 'deleted') return value
  throw new Error(`platform_file_objects.status 值 '${value}' 无效。`)
}

function assertSameRequest(existing: FileObjectRecord, input: PendingFileObjectInput): void {
  const same = existing.name === input.name
    && existing.sourceKey === input.sourceKey
    && existing.sourceRelativePath === input.sourceRelativePath
    && existing.contentHash === input.contentHash
    && existing.sizeBytes === input.sizeBytes
    && existing.mediaType === input.mediaType
    && existing.sessionId === input.sessionId
    && existing.workspaceId === input.workspaceId
    && existing.createdByUserId === input.createdByUserId
  if (!same) {
    throw new StoreConflictError(
      `requestId '${input.requestId ?? input.fileId}' 已用于不同的上传内容或资源归属。`,
    )
  }
}

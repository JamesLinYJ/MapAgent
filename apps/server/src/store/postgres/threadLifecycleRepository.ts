// +-------------------------------------------------------------------------
//
//   地理智能平台 - 线程生命周期仓储
//
//   文件:       threadLifecycleRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, desc, eq, ne } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import {
  platformRuns,
  platformSessions,
  platformThreads,
} from '../../db/schema.js'
import type {
  AgentThreadRecord,
  SessionRecord,
  ThreadManifest,
} from '../../schemas/types.js'
import type {
  DeletedThreadRecord,
  ThreadLifecycleResult,
  TrashThreadLifecycleResult,
} from './conversationPersistencePorts.js'
import {
  assertThreadOwnerMatchesSession,
  mapDeletedThreadRow,
  mapSessionRow,
  mapThreadManifestRow,
  mapThreadRow,
  toThreadInsertValues,
} from './conversationRowMappers.js'

/** 线程元数据、回收站状态及其会话指针的唯一写入边界。 */
export class PostgresThreadLifecycleRepository {
  constructor(private readonly db: Database) {}

  async createThreadLifecycle(thread: AgentThreadRecord): Promise<ThreadLifecycleResult> {
    if (thread.status !== 'active') throw new Error('新线程状态必须是 active')
    return this.db.transaction(async tx => {
      const sessionRows = await tx.select().from(platformSessions)
        .where(eq(platformSessions.sessionId, thread.sessionId)).for('update').limit(1)
      const session = sessionRows[0]
      if (!session || session.status !== 'active') throw new Error(`会话 '${thread.sessionId}' 不存在或不可用`)
      assertThreadOwnerMatchesSession(thread, session)

      const insertedRows = await tx.insert(platformThreads)
        .values(toThreadInsertValues(thread))
        .returning()
      const inserted = insertedRows[0]
      if (!inserted) throw new Error(`线程 '${thread.id}' 创建失败`)
      const updatedSessionRows = await tx.update(platformSessions).set({
        latestThreadId: thread.id,
        updatedAt: new Date(thread.updatedAt),
      }).where(eq(platformSessions.sessionId, thread.sessionId)).returning()
      const updatedSession = updatedSessionRows[0]
      if (!updatedSession) throw new Error(`会话 '${thread.sessionId}' 更新失败`)
      return {
        session: mapSessionRow(updatedSession),
        thread: mapThreadRow(inserted),
        manifest: mapThreadManifestRow(inserted),
      }
    })
  }

  async saveThread(thread: AgentThreadRecord): Promise<void> {
    if (thread.status === 'deleted') {
      throw new Error('删除线程必须使用 trashThread，以保证回收站时间元数据完整')
    }
    const values = toThreadInsertValues(thread)
    const rows = await this.db.update(platformThreads).set({
      workspaceId: values.workspaceId,
      createdByUserId: values.createdByUserId,
      visibility: values.visibility,
      title: values.title,
      status: values.status,
      latestRunId: values.latestRunId,
      latestUserQuery: values.latestUserQuery,
      latestAssistantSummary: values.latestAssistantSummary,
      latestRunStatus: values.latestRunStatus,
      latestArtifactId: values.latestArtifactId,
      latestArtifactName: values.latestArtifactName,
      historyPreview: values.historyPreview,
      runCount: values.runCount,
      updatedAt: values.updatedAt,
    }).where(and(
      eq(platformThreads.threadId, thread.id),
      eq(platformThreads.sessionId, thread.sessionId),
      ne(platformThreads.status, 'deleted'),
    )).returning({ threadId: platformThreads.threadId })
    if (!rows[0]) throw new Error(`线程 '${thread.id}' 不存在`)
  }

  async trashThread(
    thread: AgentThreadRecord,
    purgeAfter: string,
    replacementThreadId: string | null,
  ): Promise<TrashThreadLifecycleResult> {
    return this.db.transaction(async tx => {
      const sessionRows = await tx.select().from(platformSessions)
        .where(eq(platformSessions.sessionId, thread.sessionId)).for('update').limit(1)
      const session = sessionRows[0]
      if (!session) throw new Error(`会话 '${thread.sessionId}' 不存在`)
      const threadRows = await tx.select().from(platformThreads).where(and(
        eq(platformThreads.threadId, thread.id),
        eq(platformThreads.sessionId, thread.sessionId),
      )).for('update').limit(1)
      const current = threadRows[0]
      if (!current || current.status === 'deleted') throw new Error(`线程 '${thread.id}' 不存在`)

      let replacement: typeof platformThreads.$inferSelect | null = null
      if (replacementThreadId) {
        const replacementRows = await tx.select().from(platformThreads).where(and(
          eq(platformThreads.threadId, replacementThreadId),
          eq(platformThreads.sessionId, thread.sessionId),
          ne(platformThreads.status, 'deleted'),
        )).for('update').limit(1)
        replacement = replacementRows[0] ?? null
        if (!replacement) throw new Error(`替代线程 '${replacementThreadId}' 不存在或不属于当前会话`)
      }

      const deletedAt = new Date(thread.updatedAt)
      const deletedRows = await tx.update(platformThreads).set({
        status: 'deleted',
        deletedAt,
        purgeAfter: new Date(purgeAfter),
        updatedAt: deletedAt,
      }).where(eq(platformThreads.threadId, thread.id)).returning()
      const deleted = deletedRows[0]
      if (!deleted) throw new Error(`线程 '${thread.id}' 删除失败`)

      let latestRunBelongsToDeletedThread = false
      if (session.latestRunId) {
        const latestRunRows = await tx.select({ threadId: platformRuns.threadId }).from(platformRuns)
          .where(eq(platformRuns.runId, session.latestRunId)).limit(1)
        latestRunBelongsToDeletedThread = latestRunRows[0]?.threadId === thread.id
      }
      const updatedSessionRows = await tx.update(platformSessions).set({
        latestThreadId: session.latestThreadId === thread.id
          ? replacement?.threadId ?? null
          : session.latestThreadId,
        latestRunId: latestRunBelongsToDeletedThread
          ? replacement?.latestRunId ?? null
          : session.latestRunId,
        updatedAt: deletedAt,
      }).where(eq(platformSessions.sessionId, thread.sessionId)).returning()
      const updatedSession = updatedSessionRows[0]
      if (!updatedSession) throw new Error(`会话 '${thread.sessionId}' 更新失败`)
      return {
        session: mapSessionRow(updatedSession),
        deleted: mapDeletedThreadRow(deleted),
      }
    })
  }

  async listTrash(sessionId: string): Promise<DeletedThreadRecord[]> {
    const rows = await this.db.select().from(platformThreads).where(and(
      eq(platformThreads.sessionId, sessionId),
      eq(platformThreads.status, 'deleted'),
    )).orderBy(desc(platformThreads.deletedAt))
    return rows.map(mapDeletedThreadRow)
  }

  async getTrashedThread(threadId: string): Promise<DeletedThreadRecord> {
    const rows = await this.db.select().from(platformThreads).where(and(
      eq(platformThreads.threadId, threadId),
      eq(platformThreads.status, 'deleted'),
    )).limit(1)
    const row = rows[0]
    if (!row) throw new Error(`回收站线程 '${threadId}' 不存在`)
    return mapDeletedThreadRow(row)
  }

  async restoreThread(threadId: string, sessionId: string): Promise<ThreadLifecycleResult> {
    return this.db.transaction(async tx => {
      const sessionRows = await tx.select().from(platformSessions)
        .where(eq(platformSessions.sessionId, sessionId)).for('update').limit(1)
      const session = sessionRows[0]
      if (!session) throw new Error(`会话 '${sessionId}' 不存在`)
      const rows = await tx.update(platformThreads).set({
        status: 'active',
        deletedAt: null,
        purgeAfter: null,
        updatedAt: new Date(),
      }).where(and(
        eq(platformThreads.threadId, threadId),
        eq(platformThreads.sessionId, sessionId),
        eq(platformThreads.status, 'deleted'),
      )).returning()
      const row = rows[0]
      if (!row) throw new Error(`回收站线程 '${threadId}' 不存在`)
      const updatedSessionRows = await tx.update(platformSessions).set({
        latestThreadId: session.latestThreadId ?? threadId,
        latestRunId: session.latestRunId ?? row.latestRunId,
        updatedAt: new Date(),
      }).where(eq(platformSessions.sessionId, sessionId)).returning()
      const updatedSession = updatedSessionRows[0]
      if (!updatedSession) throw new Error(`会话 '${sessionId}' 更新失败`)
      return {
        session: mapSessionRow(updatedSession),
        thread: mapThreadRow(row),
        manifest: mapThreadManifestRow(row),
      }
    })
  }

  async purgeThread(threadId: string, sessionId: string): Promise<SessionRecord> {
    return this.db.transaction(async tx => {
      const sessionRows = await tx.select().from(platformSessions)
        .where(eq(platformSessions.sessionId, sessionId)).for('update').limit(1)
      const session = sessionRows[0]
      if (!session) throw new Error(`会话 '${sessionId}' 不存在`)
      const threadRows = await tx.select().from(platformThreads).where(and(
        eq(platformThreads.threadId, threadId),
        eq(platformThreads.sessionId, sessionId),
        eq(platformThreads.status, 'deleted'),
      )).for('update').limit(1)
      if (!threadRows[0]) throw new Error(`回收站线程 '${threadId}' 不存在`)
      let latestRunBelongsToThread = false
      if (session.latestRunId) {
        const latestRunRows = await tx.select({ threadId: platformRuns.threadId })
          .from(platformRuns)
          .where(and(
            eq(platformRuns.runId, session.latestRunId),
            eq(platformRuns.sessionId, sessionId),
          ))
          .limit(1)
        latestRunBelongsToThread = latestRunRows[0]?.threadId === threadId
      }
      const rows = await tx.delete(platformThreads)
        .where(eq(platformThreads.threadId, threadId))
        .returning({ threadId: platformThreads.threadId })
      if (!rows[0]) throw new Error(`回收站线程 '${threadId}' 清理失败`)
      const updatedSessionRows = await tx.update(platformSessions).set({
        latestThreadId: session.latestThreadId === threadId ? null : session.latestThreadId,
        latestRunId: latestRunBelongsToThread ? null : session.latestRunId,
        updatedAt: new Date(),
      }).where(eq(platformSessions.sessionId, sessionId)).returning()
      const updatedSession = updatedSessionRows[0]
      if (!updatedSession) throw new Error(`会话 '${sessionId}' 更新失败`)
      return mapSessionRow(updatedSession)
    })
  }

  async getThreadManifest(threadId: string): Promise<ThreadManifest> {
    const rows = await this.db.select().from(platformThreads)
      .where(eq(platformThreads.threadId, threadId)).limit(1)
    const row = rows[0]
    if (!row) throw new Error(`线程 '${threadId}' 不存在`)
    return mapThreadManifestRow(row)
  }
}

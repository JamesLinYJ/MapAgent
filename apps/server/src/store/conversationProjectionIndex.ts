// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话投影索引
//
//   文件:       conversationProjectionIndex.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AgentThreadRecord, AnalysisRun, SessionRecord } from '../schemas/types.js'
import { compareRuns } from './runProjection.js'
import { StoreNotFoundError } from './storeErrors.js'

// PostgreSQL 会话仓储是事实源；本模块只维护启动后可重建的内存查询投影。
// PlatformPersistenceFacade 通过这里访问 session/thread/run，避免自身继续拥有 Map 细节。
export class ConversationProjectionIndex {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly threads = new Map<string, AgentThreadRecord>()
  private readonly runs = new Map<string, AnalysisRun>()
  private readonly threadIdsBySessionId = new Map<string, Set<string>>()
  private readonly runIdsBySessionId = new Map<string, Set<string>>()
  private readonly runIdsByThreadId = new Map<string, Set<string>>()

  load(snapshot: {
    sessions: SessionRecord[]
    threads: AgentThreadRecord[]
    runs: AnalysisRun[]
  }): void {
    this.sessions.clear()
    this.threads.clear()
    this.runs.clear()
    for (const session of snapshot.sessions) this.sessions.set(session.id, session)
    for (const thread of snapshot.threads) this.threads.set(thread.id, thread)
    for (const run of snapshot.runs) this.runs.set(run.id, run)
    this.rebuildDerivedIndexes()
  }

  sessionValues(): IterableIterator<SessionRecord> {
    return this.sessions.values()
  }

  runValues(): IterableIterator<AnalysisRun> {
    return this.runs.values()
  }

  runEntries(): IterableIterator<[string, AnalysisRun]> {
    return this.runs.entries()
  }

  hasThread(threadId: string): boolean {
    return this.threads.has(threadId)
  }

  getSession(sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId)
    if (!session) throw new StoreNotFoundError(`会话 '${sessionId}' 不存在`)
    return session
  }

  getThread(threadId: string): AgentThreadRecord {
    const thread = this.threads.get(threadId)
    if (!thread) throw new StoreNotFoundError(`线程 '${threadId}' 不存在`)
    return thread
  }

  getThreadOrNull(threadId: string | null | undefined): AgentThreadRecord | null {
    return threadId ? this.threads.get(threadId) ?? null : null
  }

  getRun(runId: string): AnalysisRun {
    const run = this.runs.get(runId)
    if (!run) throw new StoreNotFoundError(`运行 '${runId}' 不存在`)
    return run
  }

  getRunOrNull(runId: string): AnalysisRun | null {
    return this.runs.get(runId) ?? null
  }

  setSession(session: SessionRecord): void {
    this.sessions.set(session.id, session)
  }

  setThread(thread: AgentThreadRecord): void {
    const previous = this.threads.get(thread.id)
    this.threads.set(thread.id, thread)
    if (previous && previous.sessionId !== thread.sessionId) {
      this.removeFromIndex(this.threadIdsBySessionId, previous.sessionId, thread.id)
    }
    if (thread.status !== 'deleted') this.addToIndex(this.threadIdsBySessionId, thread.sessionId, thread.id)
  }

  setRun(run: AnalysisRun): void {
    this.runs.set(run.id, run)
    this.indexRun(run)
  }

  deleteThread(threadId: string): void {
    const thread = this.threads.get(threadId)
    this.threads.delete(threadId)
    if (thread) this.removeFromIndex(this.threadIdsBySessionId, thread.sessionId, threadId)
    const threadRunIds = this.runIdsByThreadId.get(threadId)
    if (threadRunIds && thread) {
      for (const runId of threadRunIds) this.removeFromIndex(this.runIdsBySessionId, thread.sessionId, runId)
    }
    this.runIdsByThreadId.delete(threadId)
  }

  deleteRunsForThread(threadId: string): void {
    for (const [runId, run] of this.runs.entries()) {
      if (run.threadId !== threadId) continue
      this.runs.delete(runId)
      this.removeFromIndex(this.runIdsBySessionId, run.sessionId, runId)
    }
    this.runIdsByThreadId.delete(threadId)
  }

  listThreadsForSession(sessionId: string): AgentThreadRecord[] {
    return this.readIndex(this.threadIdsBySessionId, sessionId, this.threads)
      .filter(thread => thread.status !== 'deleted')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  listRunsForSession(sessionId: string): AnalysisRun[] {
    return this.readIndex(this.runIdsBySessionId, sessionId, this.runs).sort(compareRuns)
  }

  listRunsForThread(threadId: string): AnalysisRun[] {
    return this.readIndex(this.runIdsByThreadId, threadId, this.runs).sort(compareRuns)
  }

  rebuildDerivedIndexes(): void {
    this.threadIdsBySessionId.clear()
    this.runIdsBySessionId.clear()
    this.runIdsByThreadId.clear()
    for (const thread of this.threads.values()) {
      if (thread.status !== 'deleted') this.addToIndex(this.threadIdsBySessionId, thread.sessionId, thread.id)
    }
    for (const run of this.runs.values()) this.indexRun(run)
  }

  indexRun(run: AnalysisRun): void {
    if (run.threadId && !this.threads.has(run.threadId)) return
    this.addToIndex(this.runIdsBySessionId, run.sessionId, run.id)
    if (run.threadId) this.addToIndex(this.runIdsByThreadId, run.threadId, run.id)
  }

  private addToIndex(index: Map<string, Set<string>>, key: string, id: string): void {
    const ids = index.get(key) ?? new Set<string>()
    ids.add(id)
    index.set(key, ids)
  }

  private removeFromIndex(index: Map<string, Set<string>>, key: string, id: string): void {
    const ids = index.get(key)
    if (!ids) return
    ids.delete(id)
    if (!ids.size) index.delete(key)
  }

  private readIndex<T>(index: Map<string, Set<string>>, key: string, records: Map<string, T>): T[] {
    const ids = index.get(key)
    if (!ids) return []
    const values: T[] = []
    for (const id of ids) {
      const value = records.get(id)
      if (value) values.push(value)
    }
    return values
  }
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 线程持久化端口适配器
//
//   文件:       threadRepository.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Database } from '../../db/connection.js'
import type {
  AgentThreadRecord,
  CompactionRecord,
  SessionRecord,
  ThreadManifest,
  ThreadMemoryDocument,
  TranscriptEntry,
} from '../../schemas/types.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import type {
  AppendConversationEntryInput,
  DeletedThreadRecord,
  ThreadHistoryPage,
  ThreadLifecycleResult,
  ThreadMemoryVersionReference,
  ThreadRepository,
  TrashThreadLifecycleResult,
} from './conversationPersistencePorts.js'
import { PostgresConversationTranscriptRepository } from './conversationTranscriptRepository.js'
import { PostgresThreadCompactionRepository } from './threadCompactionRepository.js'
import { PostgresThreadLifecycleRepository } from './threadLifecycleRepository.js'
import { PostgresThreadMemoryRepository } from './threadMemoryRepository.js'

/**
 * 将稳定的 ThreadRepository 端口组合到四个独立事实边界。
 * 本适配器不持有 SQL，调用方也不能穿透到子仓储实现。
 */
export class PostgresThreadRepository implements ThreadRepository {
  private readonly lifecycle: PostgresThreadLifecycleRepository
  private readonly memory: PostgresThreadMemoryRepository
  private readonly compactions: PostgresThreadCompactionRepository
  private readonly transcript: PostgresConversationTranscriptRepository

  constructor(db: Database, runMutations: RunMutationQueue) {
    this.lifecycle = new PostgresThreadLifecycleRepository(db)
    this.memory = new PostgresThreadMemoryRepository(db)
    this.compactions = new PostgresThreadCompactionRepository(db)
    this.transcript = new PostgresConversationTranscriptRepository(db, runMutations)
  }

  createThreadLifecycle(thread: AgentThreadRecord): Promise<ThreadLifecycleResult> {
    return this.lifecycle.createThreadLifecycle(thread)
  }

  saveThread(thread: AgentThreadRecord): Promise<void> {
    return this.lifecycle.saveThread(thread)
  }

  trashThread(
    thread: AgentThreadRecord,
    purgeAfter: string,
    replacementThreadId: string | null,
  ): Promise<TrashThreadLifecycleResult> {
    return this.lifecycle.trashThread(thread, purgeAfter, replacementThreadId)
  }

  listTrash(sessionId: string): Promise<DeletedThreadRecord[]> {
    return this.lifecycle.listTrash(sessionId)
  }

  getTrashedThread(threadId: string): Promise<DeletedThreadRecord> {
    return this.lifecycle.getTrashedThread(threadId)
  }

  restoreThread(threadId: string, sessionId: string): Promise<ThreadLifecycleResult> {
    return this.lifecycle.restoreThread(threadId, sessionId)
  }

  purgeThread(threadId: string, sessionId: string): Promise<SessionRecord> {
    return this.lifecycle.purgeThread(threadId, sessionId)
  }

  getThreadManifest(threadId: string): Promise<ThreadManifest> {
    return this.lifecycle.getThreadManifest(threadId)
  }

  saveThreadMemoryVersion(input: {
    threadId: string
    expectedVersion: number
    version: number
    contentHash: string
    source: ThreadMemoryDocument['source']
    basedOnEntryId: string | null
    estimatedTokens: number
    createdAt: string
  }): Promise<ThreadMemoryVersionReference> {
    return this.memory.saveThreadMemoryVersion(input)
  }

  getLatestThreadMemoryVersion(threadId: string): Promise<ThreadMemoryVersionReference | null> {
    return this.memory.getLatestThreadMemoryVersion(threadId)
  }

  appendCompaction(record: CompactionRecord): Promise<void> {
    return this.compactions.appendCompaction(record)
  }

  listCompactions(threadId: string): Promise<CompactionRecord[]> {
    return this.compactions.listCompactions(threadId)
  }

  appendConversationEntry(input: AppendConversationEntryInput): Promise<TranscriptEntry> {
    return this.transcript.appendConversationEntry(input)
  }

  readThreadHistory(threadId: string, cursor?: string | null, limit = 100): Promise<ThreadHistoryPage> {
    return this.transcript.readThreadHistory(threadId, cursor, limit)
  }

  readActiveConversation(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]> {
    return this.transcript.readActiveConversation(threadId, leafEntryId)
  }

  forkConversation(
    sourceThreadId: string,
    targetThreadId: string,
    sourceEntryId: string,
    lastNTurns?: number | null,
  ): Promise<Map<string, string>> {
    return this.transcript.forkConversation(sourceThreadId, targetThreadId, sourceEntryId, lastNTurns)
  }
}

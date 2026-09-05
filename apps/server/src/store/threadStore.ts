// +-------------------------------------------------------------------------
//
//   地理智能平台 - 线程资源存储
//
//   文件:       threadStore.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type {
  AgentThreadRecord,
  CompactionRecord,
  ThreadManifest,
  ThreadMemoryDocument,
  TranscriptEntry,
  TranscriptEntryKind,
} from '../schemas/types.js'
import { threadMemoryDocumentSchema } from '../schemas/types.js'
import { makeId, nowUtc } from '../utils/ids.js'
import type { ConversationProjectionIndex } from './conversationProjectionIndex.js'
import type { InMemoryEventBus } from './eventBus.js'
import type { ConversationPayloadStore } from './conversationPayloadStore.js'
import { estimateTokens } from './conversationEncoding.js'
import type { FileLifecyclePort } from './fileLifecycleService.js'
import { splitThreadMemoryDocument } from './threadMemoryDocument.js'
import type { SessionStore } from './sessionStore.js'
import type {
  ConversationTranscriptRepository,
  DeletedThreadRecord,
  ObjectReferenceRepository,
  RunRepository,
  ThreadCompactionRepository,
  ThreadLifecycleRepository,
  ThreadMemoryRepository,
} from './postgres/conversationPersistencePorts.js'
import { MemoryVersionConflictError } from './storeErrors.js'
import type { ObjectPublicationCoordinator } from './objectPublicationCoordinator.js'

export interface ThreadStoreEvents {
  threadUpdateBus: InMemoryEventBus<{ thread: AgentThreadRecord; manifest: ThreadManifest }>
  threadEntryBus: InMemoryEventBus<TranscriptEntry>
  threadCompactionBus: InMemoryEventBus<CompactionRecord>
  threadMemoryBus: InMemoryEventBus<ThreadMemoryDocument>
}

export interface ThreadPersistencePorts {
  lifecycle: ThreadLifecycleRepository
  transcript: ConversationTranscriptRepository
  memory: ThreadMemoryRepository
  compactions: ThreadCompactionRepository
}

// ThreadStore 是线程 manifest、transcript、线程记忆和垃圾箱动作的唯一拥有者。
// Run 状态只通过 index 读取；不会在这里创建或完成 run。
export class ThreadStore {
  constructor(
    private readonly index: ConversationProjectionIndex,
    private readonly payloadStore: ConversationPayloadStore,
    private readonly sessionStore: SessionStore,
    private readonly repositories: ThreadPersistencePorts,
    private readonly runReader: Pick<RunRepository, 'listRunsForThread'>,
    private readonly objectReferences: ObjectReferenceRepository,
    private readonly files: Pick<FileLifecyclePort, 'cloneThreadFiles' | 'purgeThreadFiles'>,
    private readonly events: ThreadStoreEvents,
    private readonly objectPublication: ObjectPublicationCoordinator,
  ) {}

  listForSession(sessionId: string): AgentThreadRecord[] {
    return this.index.listThreadsForSession(sessionId)
  }

  async create(sessionId: string, title?: string | null): Promise<AgentThreadRecord> {
    const session = this.sessionStore.get(sessionId)
    const now = nowUtc()
    const thread: AgentThreadRecord = {
      id: makeId('thread'),
      sessionId,
      title: title || '新对话',
      workspaceId: session.workspaceId,
      createdByUserId: session.createdByUserId,
      visibility: session.visibility,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      latestRunId: null,
      latestUserQuery: null,
      latestAssistantSummary: null,
      latestRunStatus: null,
      latestArtifactId: null,
      latestArtifactName: null,
      historyPreview: null,
      conversationPath: null,
    }
    const persisted = await this.repositories.lifecycle.createThreadLifecycle(thread)
    this.payloadStore.registerThread(persisted.thread)
    this.sessionStore.acceptPersisted(persisted.session)
    this.index.setThread(persisted.thread)
    this.events.threadUpdateBus.publish(thread.id, {
      thread: structuredClone(persisted.thread),
      manifest: persisted.manifest,
    })
    return persisted.thread
  }

  get(threadId: string): AgentThreadRecord {
    return this.index.getThread(threadId)
  }

  async update(threadId: string, fields: Partial<AgentThreadRecord>): Promise<AgentThreadRecord> {
    const current = this.get(threadId)
    if (fields.status !== undefined && fields.status !== current.status) {
      throw new Error('线程状态只能通过删除或恢复操作修改')
    }
    const next = { ...current, ...fields, updatedAt: nowUtc() }
    await this.repositories.lifecycle.saveThread(next)
    const manifest = await this.repositories.lifecycle.getThreadManifest(threadId)
    this.index.setThread(next)
    this.events.threadUpdateBus.publish(threadId, { thread: structuredClone(next), manifest })
    return next
  }

  async delete(threadId: string): Promise<void> {
    const thread = this.get(threadId)
    const next = { ...thread, status: 'deleted' as const, updatedAt: nowUtc() }
    const purgeAfter = new Date(Date.now() + 30 * 86_400_000).toISOString()
    const replacement = this.listForSession(next.sessionId).find(candidate => candidate.id !== threadId) ?? null
    const persisted = await this.repositories.lifecycle.trashThread(next, purgeAfter, replacement?.id ?? null)
    this.payloadStore.setThreadTrashed(threadId, true)
    this.index.deleteThread(threadId)
    this.sessionStore.acceptPersisted(persisted.session)
  }

  async getManifest(threadId: string): Promise<ThreadManifest> {
    this.get(threadId)
    return this.repositories.lifecycle.getThreadManifest(threadId)
  }

  async listHistory(threadId: string, cursor?: string | null, limit?: number) {
    this.get(threadId)
    return this.repositories.transcript.readThreadHistory(threadId, cursor, limit)
  }

  async activeTranscript(threadId: string, leafEntryId?: string | null): Promise<TranscriptEntry[]> {
    this.get(threadId)
    return this.repositories.transcript.readActiveConversation(threadId, leafEntryId)
  }

  async appendTranscript(input: {
    threadId: string
    runId?: string | null
    turnId?: string | null
    kind: TranscriptEntryKind
    payload?: Record<string, unknown>
    parentEntryId?: string | null
    logicalParentEntryId?: string | null
    entryId?: string
  }): Promise<TranscriptEntry> {
    this.get(input.threadId)
    const entry = await this.repositories.transcript.appendConversationEntry(input)
    this.events.threadEntryBus.publish(input.threadId, entry)
    return entry
  }

  async fork(
    sourceThreadId: string,
    sourceEntryId: string,
    title?: string | null,
    lastNTurns?: number | null,
  ): Promise<AgentThreadRecord> {
    const source = this.get(sourceThreadId)
    const target = await this.create(source.sessionId, title ?? `${source.title} · 分支`)
    const mapping = await this.repositories.transcript.forkConversation(
      sourceThreadId,
      target.id,
      sourceEntryId,
      lastNTurns,
    )
    await this.files.cloneThreadFiles(sourceThreadId, target.id)
    const sourceMemory = await this.getMemory(sourceThreadId)
    if (sourceMemory.version > 0 || sourceMemory.content.trim()) {
      await this.updateMemory(
        target.id,
        sourceMemory.content,
        0,
        'fork',
        sourceMemory.basedOnEntryId ? mapping.get(sourceMemory.basedOnEntryId) ?? null : null,
      )
    }
    const targetManifest = await this.repositories.lifecycle.getThreadManifest(target.id)
    this.events.threadUpdateBus.publish(target.id, { thread: structuredClone(target), manifest: targetManifest })
    return target
  }

  async getMemory(threadId: string): Promise<ThreadMemoryDocument> {
    this.get(threadId)
    const reference = await this.repositories.memory.getLatestThreadMemoryVersion(threadId)
    if (!reference) {
      const manifest = await this.repositories.lifecycle.getThreadManifest(threadId)
      return threadMemoryDocumentSchema.parse({
        threadId,
        version: 0,
        content: '',
        generatedContent: '',
        pinnedContent: '',
        source: 'system',
        basedOnEntryId: null,
        estimatedTokens: 0,
        updatedAt: manifest.updatedAt,
      })
    }
    const bytes = await this.payloadStore.readObjectByHash(reference.contentHash)
    const document = threadMemoryDocumentSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
    if (document.threadId !== threadId || document.version !== reference.version) {
      throw new Error(`线程 '${threadId}' 的记忆对象与数据库版本不一致`)
    }
    return document
  }

  async updateMemory(
    threadId: string,
    content: string,
    expectedVersion?: number,
    source: ThreadMemoryDocument['source'] = 'user',
    basedOnEntryId: string | null = null,
  ): Promise<ThreadMemoryDocument> {
    this.get(threadId)
    const manifest = await this.repositories.lifecycle.getThreadManifest(threadId)
    if (expectedVersion !== undefined && expectedVersion !== manifest.memoryVersion) {
      throw new MemoryVersionConflictError(expectedVersion, manifest.memoryVersion)
    }
    const { generatedContent, pinnedContent } = splitThreadMemoryDocument(content)
    const document = threadMemoryDocumentSchema.parse({
      threadId,
      version: manifest.memoryVersion + 1,
      content,
      generatedContent,
      pinnedContent,
      source,
      basedOnEntryId,
      estimatedTokens: estimateTokens(content),
      updatedAt: nowUtc(),
    })
    await this.objectPublication.publish(async () => {
      const reference = await this.payloadStore.putObject(
        JSON.stringify(document),
        'application/vnd.geo-agent-platform.thread-memory+json',
      )
      await this.repositories.memory.saveThreadMemoryVersion({
        threadId,
        expectedVersion: manifest.memoryVersion,
        version: document.version,
        contentHash: reference.hash,
        source: document.source,
        basedOnEntryId: document.basedOnEntryId,
        estimatedTokens: document.estimatedTokens,
        createdAt: document.updatedAt,
      })
    })
    this.events.threadMemoryBus.publish(threadId, document)
    return document
  }

  async appendCompaction(record: CompactionRecord): Promise<void> {
    this.get(record.threadId)
    await this.repositories.compactions.appendCompaction(record)
    this.events.threadCompactionBus.publish(record.threadId, record)
  }

  async listCompactions(threadId: string): Promise<CompactionRecord[]> {
    this.get(threadId)
    return this.repositories.compactions.listCompactions(threadId)
  }

  async listTrash(sessionId: string): Promise<DeletedThreadRecord[]> {
    this.sessionStore.get(sessionId)
    return this.repositories.lifecycle.listTrash(sessionId)
  }

  async getTrashed(threadId: string): Promise<AgentThreadRecord> {
    const trashed = await this.repositories.lifecycle.getTrashedThread(threadId)
    return trashed.thread
  }

  async restore(threadId: string): Promise<AgentThreadRecord> {
    const trashed = await this.repositories.lifecycle.getTrashedThread(threadId)
    const restored = await this.repositories.lifecycle.restoreThread(threadId, trashed.thread.sessionId)
    const nextThread = restored.thread
    this.payloadStore.setThreadTrashed(threadId, false)
    this.sessionStore.acceptPersisted(restored.session)
    this.index.setThread(nextThread)
    for (const run of await this.runReader.listRunsForThread(threadId)) {
      this.index.setRun(run)
      this.payloadStore.registerRun(run)
    }
    this.index.rebuildDerivedIndexes()
    this.events.threadUpdateBus.publish(threadId, { thread: structuredClone(nextThread), manifest: restored.manifest })
    return nextThread
  }

  async purge(threadId: string): Promise<void> {
    const trashed = await this.repositories.lifecycle.getTrashedThread(threadId)
    const session = await this.repositories.lifecycle.purgeThread(threadId, trashed.thread.sessionId)
    this.sessionStore.acceptPersisted(session)
    this.index.deleteRunsForThread(threadId)
    await this.objectPublication.collect(async () => {
      // PostgreSQL 已经提交资源删除。物理 thread 投影清理、引用快照和
      // CAS GC 必须同处一个独占区间，防止 publisher 在 purge 后又写回 metadata。
      await Promise.all([
        this.payloadStore.purgeThreadPayload(threadId),
        this.files.purgeThreadFiles(threadId),
      ])
      const references = await this.objectReferences.listReferencedObjectHashes()
      await this.payloadStore.garbageCollectObjects(references)
    })
  }

  async recordAttachment(threadId: string, input: {
    id: string
    name: string
    contentHash: string
    mediaType: string
    sizeBytes: number
    relativePath: string
  }, action: 'attached' | 'deleted' = 'attached'): Promise<void> {
    this.get(threadId)
    await this.payloadStore.appendAttachment(threadId, {
      attachmentId: input.id,
      action,
      name: input.name,
      threadId,
      contentRef: action === 'attached' ? {
        algorithm: 'sha256',
        hash: input.contentHash,
        mediaType: input.mediaType,
        sizeBytes: input.sizeBytes,
        relativePath: input.relativePath,
      } : null,
      createdAt: nowUtc(),
    })
  }
}

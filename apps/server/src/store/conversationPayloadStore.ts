// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话载荷文件存储
//
//   文件:       conversationPayloadStore.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentThreadRecord,
  AnalysisRun,
  ContentRef,
} from '../schemas/types.js'
import { nowUtc } from '../utils/ids.js'
import { atomicWriteJson, readRawJson, safeId } from './durableFileIo.js'
import type {
  ConversationAttachmentRecord,
  ConversationPayloadStorage,
  ConversationPayloadIndex,
} from './conversationPayloadStorage.js'
import { ContentAddressedObjectStore } from './contentAddressedObjectStore.js'
import { ConversationObjectGarbageCollector } from './conversationObjectGarbageCollector.js'
import { DurableJsonlStore } from './durableJsonlStore.js'
import { ThreadMutationQueue } from './threadMutationQueue.js'

const STORE_SCHEMA_VERSION = 3

interface ThreadLocation {
  sessionId: string
  directory: string
  trashed: boolean
}

interface RunLocation {
  sessionId: string
  threadId: string
  directory: string
}

// PostgreSQL 是结构化会话事实源。ConversationPayloadStore 只保存内容寻址对象、
// 附件审计和 Agent 诊断载荷，不保存 thread/run/transcript 的第二份投影。
export class ConversationPayloadStore implements ConversationPayloadStorage {
  readonly root: string
  readonly sessionsRoot: string
  readonly objectsRoot: string

  private readonly threadLocations = new Map<string, ThreadLocation>()
  private readonly runLocations = new Map<string, RunLocation>()
  private readonly threadMutationQueue = new ThreadMutationQueue()
  private readonly jsonlStore = new DurableJsonlStore()
  private readonly objectStore: ContentAddressedObjectStore
  private readonly objectGarbageCollector: ConversationObjectGarbageCollector

  constructor(root: string) {
    this.root = path.resolve(root)
    this.sessionsRoot = path.join(this.root, 'sessions')
    const runtimeRoot = ['sessions', 'conversations'].includes(path.basename(this.root))
      ? path.dirname(this.root)
      : this.root
    this.objectsRoot = path.join(runtimeRoot, 'objects', 'sha256')
    this.objectStore = new ContentAddressedObjectStore(this.objectsRoot)
    this.objectGarbageCollector = new ConversationObjectGarbageCollector(this.sessionsRoot, this.objectsRoot)
  }

  async initialize(snapshot: ConversationPayloadIndex): Promise<void> {
    await mkdir(this.sessionsRoot, { recursive: true })
    await mkdir(this.objectsRoot, { recursive: true })
    await this.ensureStoreManifest()

    this.threadLocations.clear()
    this.runLocations.clear()
    for (const thread of snapshot.threads) this.registerThread(thread)
    for (const deleted of snapshot.deletedThreads) this.registerThread(deleted.thread, true)
    for (const run of snapshot.runs) {
      if (run.threadId && this.threadLocations.has(run.threadId)) this.registerRun(run)
    }
  }

  registerThread(thread: AgentThreadRecord, trashed = false): void {
    const sessionId = safeId(thread.sessionId, 'sessionId')
    const threadId = safeId(thread.id, 'threadId')
    this.threadLocations.set(threadId, {
      sessionId,
      directory: this.threadDirectory(sessionId, threadId),
      trashed,
    })
  }

  setThreadTrashed(threadId: string, trashed: boolean): void {
    const location = this.requireThreadLocation(threadId)
    this.threadLocations.set(threadId, { ...location, trashed })
  }

  async purgeThreadPayload(threadId: string): Promise<void> {
    const location = this.requireThreadLocation(threadId)
    if (!location.trashed) throw new Error('只能物理清理回收站中的线程文件')
    await rm(location.directory, { recursive: true, force: true })
    this.threadLocations.delete(threadId)
    for (const [runId, run] of this.runLocations) {
      if (run.threadId === threadId) this.runLocations.delete(runId)
    }
  }

  registerRun(run: AnalysisRun): void {
    if (!run.threadId) throw new Error('运行时文件中的 run 必须属于 thread')
    const thread = this.requireThreadLocation(run.threadId)
    if (thread.trashed) throw new Error(`线程 '${run.threadId}' 已在回收站`)
    this.runLocations.set(run.id, {
      sessionId: run.sessionId,
      threadId: run.threadId,
      directory: path.join(thread.directory, 'runs', safeId(run.id, 'runId')),
    })
  }

  async appendAgentTranscript(runId: string, agentId: string, record: Record<string, unknown>): Promise<void> {
    const run = this.requireRunLocation(runId)
    const safeAgentId = safeId(agentId, 'agentId')
    await this.withThreadLock(run.threadId, async () => {
      const directory = path.join(run.directory, 'agents', safeAgentId)
      await mkdir(directory, { recursive: true })
      const agentPath = path.join(directory, 'agent.json')
      if (!await readRawJson(agentPath)) {
        const timestamp = nowUtc()
        await atomicWriteJson(agentPath, {
          schemaVersion: STORE_SCHEMA_VERSION,
          agentId: safeAgentId,
          role: safeAgentId,
          runId,
          status: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      }
      await this.jsonlStore.append(path.join(directory, 'transcript.jsonl'), {
        schemaVersion: STORE_SCHEMA_VERSION,
        timestamp: nowUtc(),
        ...record,
      })
    })
  }

  async appendAttachment(threadId: string, record: ConversationAttachmentRecord): Promise<void> {
    await this.withThreadLock(threadId, async () => {
      const location = this.requireThreadLocation(threadId)
      if (location.trashed) throw new Error(`线程 '${threadId}' 已在回收站`)
      await this.jsonlStore.append(path.join(location.directory, 'attachments.jsonl'), record)
    })
  }

  putObject(content: string | Uint8Array, mediaType = 'application/octet-stream'): Promise<ContentRef> {
    return this.objectStore.put(content, mediaType)
  }

  readObject(reference: ContentRef): Promise<Uint8Array> {
    return this.objectStore.read(reference)
  }

  readObjectByHash(hash: string): Promise<Uint8Array> {
    return this.objectStore.readByHash(hash)
  }

  garbageCollectObjects(databaseReferences: Iterable<string> = []): Promise<{ removed: number; retained: number }> {
    return this.objectGarbageCollector.collect(databaseReferences)
  }

  async flush(): Promise<void> {
    await this.threadMutationQueue.flush()
    await this.jsonlStore.flush()
  }

  async close(): Promise<void> {
    await this.flush()
  }

  private async ensureStoreManifest(): Promise<void> {
    const manifestPath = path.join(this.root, 'store.json')
    const current = await readRawJson(manifestPath)
    if (current && current.schemaVersion !== STORE_SCHEMA_VERSION) {
      throw new Error(
        `不支持的 runtime object store 版本：${String(current.schemaVersion)}。请显式重置旧 runtime 数据。`,
      )
    }
    if (!current) {
      await atomicWriteJson(manifestPath, {
        schemaVersion: STORE_SCHEMA_VERSION,
        kind: 'geo-agent-platform-runtime-object-store',
        createdAt: nowUtc(),
      })
    }
  }

  private requireThreadLocation(threadId: string): ThreadLocation {
    const safeThreadId = safeId(threadId, 'threadId')
    const location = this.threadLocations.get(safeThreadId)
    if (!location) throw new Error(`线程 '${safeThreadId}' 不存在`)
    return location
  }

  private requireRunLocation(runId: string): RunLocation {
    const safeRunId = safeId(runId, 'runId')
    const location = this.runLocations.get(safeRunId)
    if (!location) throw new Error(`运行 '${safeRunId}' 不存在`)
    return location
  }

  private threadDirectory(sessionId: string, threadId: string): string {
    return path.join(this.sessionsRoot, safeId(sessionId, 'sessionId'), 'threads', safeId(threadId, 'threadId'))
  }

  private withThreadLock<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    return this.threadMutationQueue.run(threadId, async () => {
      this.requireThreadLocation(threadId)
      return work()
    })
  }
}

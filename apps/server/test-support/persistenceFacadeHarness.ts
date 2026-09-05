// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久化门面测试夹具
//
//   文件:       persistenceFacadeHarness.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import path from 'node:path'

import type { Database } from '../src/db/connection.js'
import type { ArtifactRef } from '../src/schemas/types.js'
import { FileLifecycleService } from '../src/store/fileLifecycleService.js'
import { RuntimeFileStore } from '../src/store/fileStore.js'
import { ObjectPublicationCoordinator } from '../src/store/objectPublicationCoordinator.js'
import { PlatformPersistenceFacade } from '../src/store/platformPersistenceFacade.js'
import { PlatformEventHub } from '../src/store/platformEventHub.js'
import type {
  ArtifactRecord,
  ArtifactOwnerProjection,
  ArtifactRepository,
  VisibleArtifactQuery,
} from '../src/store/postgres/artifactRepository.js'
import type {
  FileObjectPromotionResult,
  FileObjectRecord,
  PendingFileObjectInput,
} from '../src/store/postgres/fileObjectRepository.js'
import { InMemoryConversationPersistence } from './inMemoryConversationPersistence.js'

const eventHubs = new WeakMap<PlatformPersistenceFacade, PlatformEventHub>()

class InMemoryArtifactRepository implements ArtifactRepository {
  private readonly records = new Map<string, ArtifactRecord>()

  async persistArtifact(artifact: ArtifactRef, owner: ArtifactOwnerProjection): Promise<void> {
    const relativePath = typeof artifact.metadata.relativePath === 'string' ? artifact.metadata.relativePath : ''
    if (!relativePath) throw new Error(`Artifact "${artifact.artifactId}" 缺少 relativePath`)
    this.records.set(artifact.artifactId, {
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      threadId: owner.threadId,
      runCreatedAt: owner.runCreatedAt,
      workspaceId: owner.workspaceId,
      createdByUserId: owner.createdByUserId,
      visibility: owner.visibility,
      artifactType: artifact.artifactType,
      name: artifact.name,
      uri: artifact.uri,
      display: structuredClone(artifact.display),
      metadata: structuredClone(artifact.metadata),
      relativePath,
      createdAt: new Date().toISOString(),
    })
  }

  async deleteRunArtifacts(runId: string): Promise<void> {
    for (const [artifactId, record] of this.records) {
      if (record.runId === runId) this.records.delete(artifactId)
    }
  }

  async getArtifact(artifactId: string): Promise<ArtifactRecord | null> {
    const record = this.records.get(artifactId)
    return record ? structuredClone(record) : null
  }

  async listVisibleArtifacts(query: VisibleArtifactQuery): Promise<ArtifactRecord[]> {
    const artifactIds = query.artifactIds ? new Set(query.artifactIds) : null
    return [...this.records.values()]
      .filter(record => (
        record.threadId === query.threadId
        && record.workspaceId === query.workspaceId
        && Date.parse(record.runCreatedAt) <= Date.parse(query.visibleAt)
        && (!artifactIds || artifactIds.has(record.artifactId))
      ))
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .slice(query.limit ? -query.limit : undefined)
      .map(record => structuredClone(record))
  }
}

export class PersistenceFacadeTestHarness {
  readonly conversationPersistence = new InMemoryConversationPersistence()
  readonly artifactRepository = new InMemoryArtifactRepository()
  readonly fileRepository = new InMemoryFileObjectRepository()

  create(storageRoot: string, db: Database = noOpDatabase()): PlatformPersistenceFacade {
    const events = new PlatformEventHub()
    const runtimeRoot = ['sessions', 'conversations'].includes(path.basename(storageRoot))
      ? path.dirname(storageRoot)
      : storageRoot
    const runtimeFiles = new RuntimeFileStore(runtimeRoot)
    const objectPublication = new ObjectPublicationCoordinator()
    const store = new PlatformPersistenceFacade(db, storageRoot, {
      conversationPersistence: this.conversationPersistence,
      artifactRepository: this.artifactRepository,
      events,
      runtimeFiles,
      fileLifecycle: new FileLifecycleService(this.fileRepository, runtimeFiles, objectPublication),
      objectPublication,
    })
    eventHubs.set(store, events)
    return store
  }
}

class InMemoryFileObjectRepository {
  private readonly records = new Map<string, FileObjectRecord>()

  async reservePending(input: PendingFileObjectInput): Promise<FileObjectRecord> {
    const replay = input.requestId
      ? [...this.records.values()].find(record => (
          record.threadId === input.threadId && record.requestId === input.requestId
        ))
      : null
    if (replay) return structuredClone(replay)
    const now = new Date().toISOString()
    const record: FileObjectRecord = {
      ...input,
      status: 'pending',
      errorMessage: null,
      createdAt: now,
      readyAt: null,
      deletedAt: null,
      updatedAt: now,
    }
    this.records.set(record.fileId, record)
    return structuredClone(record)
  }

  async promoteReadyAndRetire(fileId: string): Promise<FileObjectPromotionResult> {
    const current = this.require(fileId)
    if (current.status === 'deleted') throw new Error(`文件 '${fileId}' 已删除`)
    const retired = [...this.records.values()].filter(record => (
      record.fileId !== current.fileId
      && record.threadId === current.threadId
      && record.sourceKey === current.sourceKey
      && (record.status === 'ready' || record.status === 'deleted')
    ))
    const now = new Date().toISOString()
    for (const previous of retired) {
      previous.status = 'deleted'
      previous.deletedAt = now
      previous.updatedAt = now
    }
    current.status = 'ready'
    current.errorMessage = null
    current.readyAt ??= now
    current.updatedAt = now
    return {
      ready: structuredClone(current),
      retired: retired.map(record => structuredClone(record)),
    }
  }

  async markPendingError(fileId: string, message: string): Promise<FileObjectRecord> {
    const record = this.require(fileId)
    if (record.status === 'pending') record.errorMessage = message
    return structuredClone(record)
  }

  async markDeleted(fileId: string): Promise<FileObjectRecord> {
    const record = this.require(fileId)
    if (record.status === 'ready') {
      record.status = 'deleted'
      record.deletedAt = new Date().toISOString()
      record.updatedAt = record.deletedAt
    }
    return structuredClone(record)
  }

  async get(fileId: string): Promise<FileObjectRecord> {
    return structuredClone(this.require(fileId))
  }

  async listReady(threadId: string): Promise<FileObjectRecord[]> {
    return [...this.records.values()]
      .filter(record => record.threadId === threadId && record.status === 'ready')
      .map(record => structuredClone(record))
  }

  private require(fileId: string): FileObjectRecord {
    const record = this.records.get(fileId)
    if (!record) throw new Error(`文件 '${fileId}' 不存在`)
    return record
  }
}

export function createTestPersistenceFacade(storageRoot: string, db?: Database): PlatformPersistenceFacade {
  return new PersistenceFacadeTestHarness().create(storageRoot, db)
}

export function testPlatformEventHub(store: PlatformPersistenceFacade): PlatformEventHub {
  const events = eventHubs.get(store)
  if (!events) throw new Error('测试持久化门面未注册 PlatformEventHub。')
  return events
}

function noOpDatabase(): Database {
  return { execute: async () => ({ rows: [] }) } as unknown as Database
}

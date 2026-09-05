// +-------------------------------------------------------------------------
//
//   地理智能平台 - 文件上传生命周期服务测试
//
//   文件:       fileLifecycleService.test.ts
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { StagedFileInput } from './fileStore.js'
import { FileLifecycleService } from './fileLifecycleService.js'
import type {
  FileObjectRecord,
  PendingFileObjectInput,
} from './postgres/fileObjectRepository.js'

describe('FileLifecycleService', () => {
  it('keeps a failed publication pending and retries the same request id', async () => {
    const repository = new FakeFileRepository()
    const publish = vi.fn()
      .mockRejectedValueOnce(new Error('对象存储暂时不可用'))
      .mockResolvedValue(undefined)
    const service = new FileLifecycleService(repository, {
      publish,
      delete: vi.fn().mockResolvedValue(true),
      cloneFile: vi.fn(),
      purgeThreadFiles: vi.fn(),
    })
    const input = uploadInput()

    await expect(service.upload(input)).rejects.toThrow('对象存储暂时不可用')
    expect(repository.records[0]?.status).toBe('pending')
    expect(repository.records[0]?.errorMessage).toContain('对象存储暂时不可用')

    const retried = await service.upload(input)
    expect(retried.id).toBe(repository.records[0]?.fileId)
    expect(repository.records[0]?.status).toBe('ready')
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('replays a ready request without publishing bytes again', async () => {
    const repository = new FakeFileRepository()
    const ready = repository.seed(uploadInput())
    ready.status = 'ready'
    ready.readyAt = ready.updatedAt
    const publish = vi.fn()
    const service = new FileLifecycleService(repository, {
      publish,
      delete: vi.fn().mockResolvedValue(true),
      cloneFile: vi.fn(),
      purgeThreadFiles: vi.fn(),
    })

    const result = await service.upload(uploadInput())
    expect(result.id).toBe(ready.fileId)
    expect(publish).not.toHaveBeenCalled()
  })

  it('marks the database deleted before removing the physical metadata', async () => {
    const repository = new FakeFileRepository()
    const record = repository.seed(uploadInput())
    record.status = 'ready'
    const remove = vi.fn().mockResolvedValue(true)
    const service = new FileLifecycleService(repository, {
      publish: vi.fn(),
      delete: remove,
      cloneFile: vi.fn(),
      purgeThreadFiles: vi.fn(),
    })

    await expect(service.delete(record.fileId, record.threadId)).resolves.toBe(true)
    expect(repository.records[0]?.status).toBe('deleted')
    expect(remove).toHaveBeenCalledWith(record.fileId, record.threadId)
  })

  it('retries physical cleanup for an already deleted record', async () => {
    const repository = new FakeFileRepository()
    const record = repository.seed(uploadInput())
    record.status = 'deleted'
    const remove = vi.fn().mockResolvedValue(true)
    const service = new FileLifecycleService(repository, {
      publish: vi.fn(),
      delete: remove,
      cloneFile: vi.fn(),
      purgeThreadFiles: vi.fn(),
    })

    await expect(service.delete(record.fileId, record.threadId)).resolves.toBe(true)
    expect(remove).toHaveBeenCalledWith(record.fileId, record.threadId)
  })

  it('clones only ready source records through the lifecycle boundary', async () => {
    const repository = new FakeFileRepository()
    const source = repository.seed(uploadInput())
    source.status = 'ready'
    source.readyAt = source.updatedAt
    const cloneFile = vi.fn().mockResolvedValue(undefined)
    const service = new FileLifecycleService(repository, {
      publish: vi.fn(),
      delete: vi.fn().mockResolvedValue(true),
      cloneFile,
      purgeThreadFiles: vi.fn(),
    })

    const copied = await service.cloneThreadFiles('thread_1', 'thread_2')

    expect(copied).toHaveLength(1)
    expect(copied[0]?.threadId).toBe('thread_2')
    expect(copied[0]?.status).toBe('ready')
    expect(cloneFile).toHaveBeenCalledWith(source.fileId, 'thread_1', 'thread_2', copied[0]?.id)
    expect(repository.records.filter(record => record.threadId === 'thread_2')[0]?.status).toBe('ready')
  })

  it('purges only the physical thread projection after the database lifecycle owns deletion', async () => {
    const repository = new FakeFileRepository()
    const ready = repository.seed(uploadInput())
    ready.status = 'ready'
    const pending = repository.seed({ ...uploadInput(), requestId: 'request_2' })
    const purgeThreadFiles = vi.fn().mockResolvedValue(undefined)
    const service = new FileLifecycleService(repository, {
      publish: vi.fn(),
      delete: vi.fn(),
      cloneFile: vi.fn(),
      purgeThreadFiles,
    })

    await service.purgeThreadFiles('thread_1')

    expect(ready.status).toBe('ready')
    expect(pending.status).toBe('pending')
    expect(purgeThreadFiles).toHaveBeenCalledWith('thread_1')
  })

  it('uses one promotion boundary so concurrent source versions leave exactly one ready record', async () => {
    const repository = new FakeFileRepository()
    const service = new FileLifecycleService(repository, {
      publish: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(true),
      cloneFile: vi.fn(),
      purgeThreadFiles: vi.fn(),
    })
    const first = uploadInput()
    const secondContent = Buffer.from('new-file-content')
    const second = {
      ...uploadInput(),
      requestId: 'request_2',
      file: {
        ...uploadInput().file,
        contentHash: createHash('sha256').update(secondContent).digest('hex'),
        sizeBytes: secondContent.byteLength,
      },
    }

    await Promise.all([service.upload(first), service.upload(second)])

    const sameSource = repository.records.filter(record => record.sourceKey === 'sample.nc')
    expect(sameSource.filter(record => record.status === 'ready')).toHaveLength(1)
    expect(sameSource.filter(record => record.status === 'deleted')).toHaveLength(1)
  })
})

class FakeFileRepository {
  readonly records: FileObjectRecord[] = []

  async reservePending(input: PendingFileObjectInput): Promise<FileObjectRecord> {
    const existing = input.requestId
      ? this.records.find(record => record.threadId === input.threadId && record.requestId === input.requestId)
      : undefined
    if (existing) return existing
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
    this.records.push(record)
    return record
  }

  async promoteReadyAndRetire(fileId: string): Promise<{ ready: FileObjectRecord; retired: FileObjectRecord[] }> {
    const record = this.require(fileId)
    const retired = this.records.filter(candidate => (
      candidate.fileId !== record.fileId
      && candidate.threadId === record.threadId
      && candidate.sourceKey === record.sourceKey
      && (candidate.status === 'ready' || candidate.status === 'deleted')
    ))
    for (const previous of retired) {
      previous.status = 'deleted'
      previous.deletedAt = new Date().toISOString()
      previous.updatedAt = previous.deletedAt
    }
    record.status = 'ready'
    record.errorMessage = null
    record.readyAt = new Date().toISOString()
    record.updatedAt = record.readyAt
    return { ready: record, retired }
  }

  async markPendingError(fileId: string, message: string): Promise<FileObjectRecord> {
    const record = this.require(fileId)
    record.errorMessage = message
    return record
  }

  async markDeleted(fileId: string): Promise<FileObjectRecord> {
    const record = this.require(fileId)
    record.status = 'deleted'
    record.deletedAt = new Date().toISOString()
    record.updatedAt = record.deletedAt
    return record
  }

  async get(fileId: string): Promise<FileObjectRecord> {
    return this.require(fileId)
  }

  async listReady(threadId: string): Promise<FileObjectRecord[]> {
    return this.records.filter(record => record.threadId === threadId && record.status === 'ready')
  }

  async listAll(threadId: string): Promise<FileObjectRecord[]> {
    return this.records.filter(record => record.threadId === threadId)
  }

  seed(input: FileUploadInput): FileObjectRecord {
    const file = input.file
    const now = new Date().toISOString()
    const record: FileObjectRecord = {
      fileId: `file_existing_${this.records.length + 1}`,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      threadId: input.threadId,
      createdByUserId: input.createdByUserId,
      name: file.name,
      sourceKey: file.name,
      sourceRelativePath: null,
      relativePath: `objects/sha256/${file.contentHash.slice(0, 2)}/${file.contentHash}.nc`,
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes,
      mediaType: file.mediaType,
      requestId: input.requestId ?? null,
      status: 'pending',
      errorMessage: null,
      createdAt: now,
      readyAt: null,
      deletedAt: null,
      updatedAt: now,
    }
    this.records.push(record)
    return record
  }

  private require(fileId: string): FileObjectRecord {
    const record = this.records.find(item => item.fileId === fileId)
    if (!record) throw new Error(`file ${fileId} missing`)
    return record
  }
}

interface FileUploadInput {
  workspaceId: string
  sessionId: string
  threadId: string
  createdByUserId: string
  requestId: string
  file: StagedFileInput
}

function uploadInput(): FileUploadInput {
  const content = Buffer.from('file-content')
  const file: StagedFileInput = {
    name: 'sample.nc',
    tempPath: path.resolve('runtime', 'staging', 'sample.upload'),
    sizeBytes: content.byteLength,
    contentHash: createHash('sha256').update(content).digest('hex'),
    mediaType: 'application/x-netcdf',
  }
  return {
    workspaceId: 'workspace_1',
    sessionId: 'session_1',
    threadId: 'thread_1',
    createdByUserId: 'user_1',
    requestId: 'request_1',
    file,
  }
}

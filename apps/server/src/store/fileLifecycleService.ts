// +-------------------------------------------------------------------------
//
//   地理智能平台 - 文件上传生命周期服务
//
//   文件:       fileLifecycleService.ts
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import { makeId } from '../utils/ids.js'
import type { StagedFileInput, StoredFileEntry, RuntimeFileStore } from './fileStore.js'
import { describeStagedFile } from './fileStore.js'
import { ObjectPublicationCoordinator } from './objectPublicationCoordinator.js'
import type {
  FileObjectOwner,
  FileObjectPromotionResult,
  FileObjectRecord,
  FileObjectRepository,
} from './postgres/fileObjectRepository.js'

export interface FileUploadInput extends FileObjectOwner {
  file: StagedFileInput
  requestId?: string | null
  sourceRelativePath?: string | null
}

export interface FileLifecyclePort {
  upload(input: FileUploadInput): Promise<StoredFileEntry>
  list(threadId: string): Promise<StoredFileEntry[]>
  delete(fileId: string, threadId: string): Promise<boolean>
  cloneThreadFiles(sourceThreadId: string, targetThreadId: string): Promise<StoredFileEntry[]>
  purgeThreadFiles(threadId: string): Promise<void>
  readAuthorized(fileId: string, threadId: string, maxBytes: number): Promise<{
    entry: StoredFileEntry
    bytes: Uint8Array
  }>
}

/**
 * 文件生命周期的应用边界。数据库先预留 pending，物理对象发布成功后才
 * 提交 ready；任一阶段失败都保留可重试的 pending 记录，不把失败伪装为成功。
 */
export class FileLifecycleService implements FileLifecyclePort {
  constructor(
    private readonly repository: Pick<
      FileObjectRepository,
      'reservePending' | 'promoteReadyAndRetire' | 'markPendingError' | 'markDeleted' | 'get' | 'listReady'
    >,
    private readonly files: Pick<RuntimeFileStore, 'publish' | 'delete' | 'cloneFile' | 'purgeThreadFiles'>
      & Partial<Pick<RuntimeFileStore, 'readObject'>>,
    private readonly objectPublication = new ObjectPublicationCoordinator(),
  ) {}

  async upload(input: FileUploadInput): Promise<StoredFileEntry> {
    const normalized = describeStagedFile(input.file, input.sourceRelativePath)
    const requestId = normalizeRequestId(input.requestId)
    const pending = await this.repository.reservePending({
      fileId: makeId('file'),
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      threadId: input.threadId,
      createdByUserId: input.createdByUserId,
      name: normalized.name,
      sourceKey: normalized.sourceKey,
      sourceRelativePath: normalized.sourceRelativePath,
      relativePath: normalized.relativePath,
      contentHash: input.file.contentHash,
      sizeBytes: input.file.sizeBytes,
      mediaType: normalized.mediaType,
      requestId,
    })

    if (pending.status === 'ready') {
      const promotion = await this.repository.promoteReadyAndRetire(pending.fileId)
      await this.removeRetiredFiles(promotion.retired)
      return toStoredFileEntry(promotion.ready)
    }

    let promotion: FileObjectPromotionResult
    try {
      promotion = await this.objectPublication.publish(async () => {
        // CAS 对象、metadata 与 ready 数据库引用必须对 GC 表现为一个发布区间。
        await this.files.publish(
          input.file,
          input.threadId,
          { fileId: pending.fileId },
          normalized.sourceRelativePath,
        )
        return this.repository.promoteReadyAndRetire(pending.fileId)
      })
    } catch (error) {
      try {
        await this.repository.markPendingError(pending.fileId, errorMessage(error))
      } catch (stateError) {
        throw new AggregateError(
          [error, stateError],
          `文件 '${pending.fileId}' 提交失败，且无法记录 pending 失败状态。`,
        )
      }
      throw error
    }
    await this.removeRetiredFiles(promotion.retired)
    return toStoredFileEntry(promotion.ready)
  }

  async list(threadId: string): Promise<StoredFileEntry[]> {
    const entries = (await this.repository.listReady(threadId)).map(toStoredFileEntry)
    const seen = new Set<string>()
    return entries.filter(entry => {
      const key = entry.sourceRelativePath ?? entry.name
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  async delete(fileId: string, threadId: string): Promise<boolean> {
    const record = await this.repository.get(fileId)
    if (record.threadId !== threadId) return false
    if (record.status === 'deleted') {
      // 删除账本已经生效，但上一次物理清理可能在这里失败。重复删除
      // 仍重试物理层，避免一个 deleted 记录永久留下可被 GC 扫描到的 metadata。
      await this.files.delete(fileId, threadId)
      return true
    }
    await this.repository.markDeleted(fileId)
    // DB 已经先成为 deleted；物理 metadata 缺失时仍保持不可见，CAS 对象由
    // 后续引用回收处理，避免把删除失败重新暴露为可读资源。
    await this.files.delete(fileId, threadId)
    return true
  }

  async cloneThreadFiles(sourceThreadId: string, targetThreadId: string): Promise<StoredFileEntry[]> {
    const sourceRecords = await this.repository.listReady(sourceThreadId)
    const copied: StoredFileEntry[] = []
    for (const source of sourceRecords) {
      const pending = await this.repository.reservePending({
        fileId: makeId('file'),
        workspaceId: source.workspaceId,
        sessionId: source.sessionId,
        threadId: targetThreadId,
        createdByUserId: source.createdByUserId,
        name: source.name,
        sourceKey: source.sourceKey,
        sourceRelativePath: source.sourceRelativePath,
        relativePath: source.relativePath,
        contentHash: source.contentHash,
        sizeBytes: source.sizeBytes,
        mediaType: source.mediaType,
        requestId: null,
      })
      try {
        const promotion = await this.objectPublication.publish(async () => {
          await this.files.cloneFile(source.fileId, sourceThreadId, targetThreadId, pending.fileId)
          return this.repository.promoteReadyAndRetire(pending.fileId)
        })
        await this.removeRetiredFiles(promotion.retired)
        copied.push(toStoredFileEntry(promotion.ready))
      } catch (error) {
        await this.repository.markPendingError(pending.fileId, errorMessage(error))
        throw error
      }
    }
    return copied
  }

  async purgeThreadFiles(threadId: string): Promise<void> {
    // 调用方必须先提交线程的数据库 purge；这里仅幂等清理物理投影。
    await this.files.purgeThreadFiles(threadId)
  }

  async readAuthorized(fileId: string, threadId: string, maxBytes: number): Promise<{
    entry: StoredFileEntry
    bytes: Uint8Array
  }> {
    const record = await this.repository.get(fileId)
    if (record.threadId !== threadId || record.status !== 'ready') {
      throw new Error(`文件 '${fileId}' 不属于当前线程或不是 ready 状态。`)
    }
    if (!this.files.readObject) throw new Error('运行时文件读取边界未配置。')
    const entry = toStoredFileEntry(record)
    const bytes = await this.files.readObject(entry, maxBytes)
    return { entry, bytes }
  }

  private async removeRetiredFiles(retired: readonly FileObjectRecord[]): Promise<void> {
    for (const previous of retired) {
      await this.files.delete(previous.fileId, previous.threadId)
    }
  }
}

function toStoredFileEntry(record: FileObjectRecord): StoredFileEntry {
  return {
    id: record.fileId,
    name: record.name,
    sourceRelativePath: record.sourceRelativePath,
    size: formatBytes(record.sizeBytes),
    sizeBytes: record.sizeBytes,
    uploadedAt: record.readyAt ?? record.updatedAt,
    status: record.status,
    threadId: record.threadId,
    relativePath: record.relativePath,
    contentHash: record.contentHash,
    mediaType: record.mediaType,
  }
}

function normalizeRequestId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? ''
  if (!normalized) return null
  if (normalized.length > 200 || !/^[A-Za-z0-9_-]+$/u.test(normalized)) {
    throw new Error('requestId 不是合法标识符。')
  }
  return normalized
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

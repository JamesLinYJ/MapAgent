// +-------------------------------------------------------------------------
//
//   地理智能平台 - 通用线程文件存储
//
//   文件:       fileStore.ts
//
//   日期:       2026年06月15日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------
//
//   维护记录 (2026-07-31):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 上传改为线程作用域、流式暂存文件、独立幂等索引和原子元数据提交。

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import PQueue from 'p-queue'
import { z } from 'zod'
import { makeId, nowUtc } from '../utils/ids.js'
import { atomicWriteJson, readJson } from './durableFileIo.js'
import { StoreConflictError } from './storeErrors.js'

export interface StoredFileEntry {
  id: string
  name: string
  sourceRelativePath: string | null
  size: string
  sizeBytes: number
  uploadedAt: string
  status: string
  threadId: string | null
  relativePath: string
  contentHash: string
  mediaType: string
}

interface StoredFileMetadata {
  id: string
  name: string
  sourceRelativePath: string | null
  sizeBytes: number
  uploadedAt: string
  status: string
  threadId: string
  relativePath: string
  contentHash: string
  mediaType: string
}

export interface StagedFileInput {
  name: string
  tempPath: string
  sizeBytes: number
  contentHash: string
  mediaType: string
}

export interface FilePublicationOptions {
  /** PostgreSQL pending 记录预先分配的资源标识。 */
  fileId?: string
}

export interface NormalizedStagedFile {
  name: string
  sourceRelativePath: string | null
  sourceKey: string
  relativePath: string
  mediaType: string
}

export interface RuntimeFileProjection {
  fileId: string
  threadId: string
}

interface FileIdempotencyRecord {
  requestId: string
  fileId: string
  name: string
  sourceKey: string
  sizeBytes: number
  contentHash: string
}

const storedFileMetadataSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sourceRelativePath: z.string().min(1).nullable(),
  sizeBytes: z.number().int().nonnegative(),
  uploadedAt: z.string().min(1),
  status: z.string().min(1),
  threadId: z.string().min(1),
  relativePath: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  mediaType: z.string().min(1),
})

const fileIdempotencyRecordSchema = z.object({
  requestId: z.string().min(1),
  fileId: z.string().min(1),
  name: z.string().min(1),
  sourceKey: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
})

export class RuntimeFileStore {
  private readonly root: string
  private readonly objectRoot: string
  private readonly scopeQueues = new Map<string, PQueue>()
  private readonly objectPublications = new Map<string, Promise<void>>()

  constructor(runtimeRoot: string) {
    this.root = path.resolve(runtimeRoot, 'uploads', 'files')
    this.objectRoot = path.resolve(runtimeRoot, 'objects', 'sha256')
  }

  async list(threadId: string): Promise<StoredFileEntry[]> {
    const scope = scopeName(threadId)
    const scopeDir = path.join(this.root, scope)
    const entries: StoredFileEntry[] = []
    for (const metaName of await listMetadataFiles(scopeDir)) {
      const metadata = await readMetadata(metaName)
      if (!metadata) continue
      if (metadata.threadId !== threadId) {
        throw new Error(`文件元数据 '${metadata.id}' 的线程作用域不一致。`)
      }
      entries.push(toEntry(metadata))
    }
    const sorted = entries.sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt))
    const seen = new Set<string>()
    return sorted.filter(entry => {
      const key = entry.sourceRelativePath ?? entry.name
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  async save(
    file: StagedFileInput,
    threadId: string,
    requestId?: string | null,
    sourceRelativePath?: string | null,
  ): Promise<StoredFileEntry> {
    const cleanName = sanitizeFilename(file.name || 'upload.bin')
    const cleanSourceRelativePath = sanitizeSourceRelativePath(sourceRelativePath, cleanName)
    const scope = scopeName(threadId)
    const sourceKey = cleanSourceRelativePath ?? cleanName
    const normalizedRequestId = requestId?.trim()
      ? safePathSegment(requestId, 'requestId')
      : null
    validateStagedFile(file)
    return this.scopeQueue(scope).add(async () => {
      const scopeDir = path.join(this.root, scope)
      if (normalizedRequestId) {
        const replay = await this.resolveIdempotentReplay(scope, normalizedRequestId, {
          name: cleanName,
          sourceKey,
          sizeBytes: file.sizeBytes,
          contentHash: file.contentHash,
        })
        if (replay) return replay
      }

      const existing = await findMetadataBySourceKey(scopeDir, sourceKey)
      const id = existing?.id ?? makeId('file')
      const uploadedAt = nowUtc()
      // 内容哈希是对象身份；保留安全扩展名，供依赖后缀判断格式的科学 reader 使用。
      const objectName = `${file.contentHash}${safeObjectExtension(cleanName)}`
      const relativePath = path.posix.join('objects', 'sha256', file.contentHash.slice(0, 2), objectName)
      const objectPath = path.join(this.objectRoot, file.contentHash.slice(0, 2), objectName)
      await this.publishContentObject(file, objectPath)
      const metadata: StoredFileMetadata = {
        id,
        name: cleanName,
        sourceRelativePath: cleanSourceRelativePath,
        sizeBytes: file.sizeBytes,
        uploadedAt,
        status: 'ready',
        threadId,
        relativePath,
        contentHash: file.contentHash,
        mediaType: file.mediaType || inferMediaType(cleanName),
      }
      const metadataPath = path.join(scopeDir, id, 'metadata.json')
      await atomicWriteJson(metadataPath, metadata)
      if (normalizedRequestId) {
        await atomicWriteJson(idempotencyPath(scopeDir, normalizedRequestId), {
          requestId: normalizedRequestId,
          fileId: id,
          name: cleanName,
          sourceKey,
          sizeBytes: file.sizeBytes,
          contentHash: file.contentHash,
        } satisfies FileIdempotencyRecord)
      }
      return toEntry(metadata)
    })
  }

  /**
   * 将已暂存文件发布为内容寻址对象，并以原子 metadata 文件作为物理投影。
   * 生命周期状态由 FileObjectRepository 持有；这里不写 requestId，也不决定
   * pending/ready/deleted 的业务语义。
   */
  async publish(
    file: StagedFileInput,
    threadId: string,
    options: FilePublicationOptions = {},
    sourceRelativePath?: string | null,
  ): Promise<StoredFileEntry> {
    const cleanName = sanitizeFilename(file.name || 'upload.bin')
    const cleanSourceRelativePath = sanitizeSourceRelativePath(sourceRelativePath, cleanName)
    const scope = scopeName(threadId)
    validateStagedFile(file)
    const fileId = options.fileId ? safePathSegment(options.fileId, 'fileId') : makeId('file')
    return this.scopeQueue(scope).add(async () => {
      const uploadedAt = nowUtc()
      const objectName = `${file.contentHash}${safeObjectExtension(cleanName)}`
      const relativePath = path.posix.join('objects', 'sha256', file.contentHash.slice(0, 2), objectName)
      const objectPath = path.join(this.objectRoot, file.contentHash.slice(0, 2), objectName)
      await this.publishContentObject(file, objectPath)
      const metadata: StoredFileMetadata = {
        id: fileId,
        name: cleanName,
        sourceRelativePath: cleanSourceRelativePath,
        sizeBytes: file.sizeBytes,
        uploadedAt,
        status: 'ready',
        threadId,
        relativePath,
        contentHash: file.contentHash,
        mediaType: file.mediaType || inferMediaType(cleanName),
      }
      await atomicWriteJson(path.join(this.root, scope, fileId, 'metadata.json'), metadata)
      return toEntry(metadata)
    })
  }

  async delete(fileId: string, threadId: string): Promise<boolean> {
    const safeFileId = safePathSegment(fileId, 'fileId')
    const scope = scopeName(threadId)
    return this.scopeQueue(scope).add(async () => {
      const dir = path.join(this.root, scope, safeFileId)
      try {
        await stat(dir)
        await rm(dir, { recursive: true, force: true })
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return false
    })
  }

  // 分支复用同一内容寻址对象，只复制线程级 metadata，不复制大文件。
  async cloneThreadFiles(sourceThreadId: string, targetThreadId: string): Promise<StoredFileEntry[]> {
    const sourceEntries = await this.list(sourceThreadId)
    const copied: StoredFileEntry[] = []
    for (const entry of sourceEntries) {
      const metadata: StoredFileMetadata = {
        id: entry.id,
        name: entry.name,
        sourceRelativePath: entry.sourceRelativePath,
        sizeBytes: entry.sizeBytes,
        uploadedAt: entry.uploadedAt,
        status: entry.status,
        threadId: targetThreadId,
        relativePath: entry.relativePath,
        contentHash: entry.contentHash,
        mediaType: entry.mediaType,
      }
      const directory = path.join(this.root, scopeName(targetThreadId), entry.id)
      await atomicWriteJson(path.join(directory, 'metadata.json'), metadata)
      copied.push(toEntry(metadata))
    }
    return copied
  }

  /** 只复制线程级 metadata，CAS 内容仍由不可变对象共享。 */
  async cloneFile(
    sourceFileId: string,
    sourceThreadId: string,
    targetThreadId: string,
    targetFileId: string,
  ): Promise<StoredFileEntry> {
    const source = (await this.list(sourceThreadId)).find(entry => entry.id === sourceFileId)
    if (!source) throw new Error(`源文件 '${sourceFileId}' 不存在或不是 ready 状态。`)
    const metadata: StoredFileMetadata = {
      id: safePathSegment(targetFileId, 'fileId'),
      name: source.name,
      sourceRelativePath: source.sourceRelativePath,
      sizeBytes: source.sizeBytes,
      uploadedAt: nowUtc(),
      status: 'ready',
      threadId: targetThreadId,
      relativePath: source.relativePath,
      contentHash: source.contentHash,
      mediaType: source.mediaType,
    }
    await atomicWriteJson(
      path.join(this.root, scopeName(targetThreadId), metadata.id, 'metadata.json'),
      metadata,
    )
    return toEntry(metadata)
  }

  async purgeThreadFiles(threadId: string): Promise<void> {
    const scope = scopeName(threadId)
    await this.scopeQueue(scope).add(() => rm(path.join(this.root, scope), {
      recursive: true,
      force: true,
    }))
  }

  /** Read an immutable CAS object only after rechecking its size and digest. */
  async readObject(entry: StoredFileEntry, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('文件读取上限无效。')
    if (entry.sizeBytes > maxBytes) throw new Error(`文件 '${entry.name}' 超过 ${maxBytes} 字节读取上限。`)
    const objectPath = resolveRuntimeRelativePath(this.objectRoot, entry.relativePath)
    const bytes = await readFile(objectPath)
    if (bytes.byteLength !== entry.sizeBytes || bytes.byteLength > maxBytes) {
      throw new Error(`文件 '${entry.name}' 的内容大小与授权记录不一致。`)
    }
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== entry.contentHash) {
      throw new Error(`文件 '${entry.name}' 的内容哈希与授权记录不一致。`)
    }
    return new Uint8Array(bytes)
  }

  async verifyIntegrity(): Promise<{ files: number; projections: RuntimeFileProjection[] }> {
    let files = 0
    const projections: RuntimeFileProjection[] = []
    for (const scope of await listDirectories(this.root)) {
      for (const metadataPath of await listMetadataFiles(path.join(this.root, scope))) {
        const metadata = await readMetadata(metadataPath)
        if (!metadata) throw new Error(`上传元数据 '${metadataPath}' 不是合法对象。`)
        if (scopeName(metadata.threadId) !== scope) {
          throw new Error(`文件元数据 '${metadata.id}' 的目录与线程作用域不一致。`)
        }
        const expectedDirectory = path.join(this.root, scope, safePathSegment(metadata.id, 'fileId'))
        if (path.dirname(metadataPath) !== expectedDirectory) {
          throw new Error(`文件元数据 '${metadata.id}' 的目录与文件标识不一致。`)
        }
        const objectPath = resolveRuntimeRelativePath(this.objectRoot, metadata.relativePath)
        const info = await stat(objectPath)
        if (!info.isFile() || info.size !== metadata.sizeBytes) {
          throw new Error(`文件元数据 '${metadata.id}' 的内容大小不一致。`)
        }
        if (await hashFile(objectPath) !== metadata.contentHash) {
          throw new Error(`文件元数据 '${metadata.id}' 的内容哈希不一致。`)
        }
        projections.push({ fileId: metadata.id, threadId: metadata.threadId })
        files += 1
      }
      await verifyIdempotencyRecords(path.join(this.root, scope))
    }
    return { files, projections }
  }

  private scopeQueue(scope: string): PQueue {
    const existing = this.scopeQueues.get(scope)
    if (existing) return existing
    const queue = new PQueue({ concurrency: 1 })
    this.scopeQueues.set(scope, queue)
    return queue
  }

  private async publishContentObject(file: StagedFileInput, objectPath: string): Promise<void> {
    const active = this.objectPublications.get(objectPath)
    if (active) return active
    const publication = publishStagedContentObject(file, objectPath)
    this.objectPublications.set(objectPath, publication)
    try {
      await publication
    } finally {
      if (this.objectPublications.get(objectPath) === publication) {
        this.objectPublications.delete(objectPath)
      }
    }
  }

  private async resolveIdempotentReplay(
    scope: string,
    requestId: string,
    expected: Omit<FileIdempotencyRecord, 'requestId' | 'fileId'>,
  ): Promise<StoredFileEntry | null> {
    const scopeDir = path.join(this.root, scope)
    const record = await readJson(idempotencyPath(scopeDir, requestId), fileIdempotencyRecordSchema)
    if (!record) return null
    if (
      record.name !== expected.name
      || record.sourceKey !== expected.sourceKey
      || record.sizeBytes !== expected.sizeBytes
      || record.contentHash !== expected.contentHash
    ) {
      throw new StoreConflictError(`requestId '${requestId}' 已用于不同的上传内容。`)
    }
    const metadata = await readMetadata(path.join(scopeDir, record.fileId, 'metadata.json'))
    if (
      !metadata
      || metadata.name !== record.name
      || (metadata.sourceRelativePath ?? metadata.name) !== record.sourceKey
      || metadata.sizeBytes !== record.sizeBytes
      || metadata.contentHash !== record.contentHash
    ) {
      throw new StoreConflictError(`requestId '${requestId}' 对应的文件状态已变化，不能重复提交。`)
    }
    return toEntry(metadata)
  }
}

/** 将 multipart 解析后的输入规范化为数据库和对象存储共用的文件事实。 */
export function describeStagedFile(file: StagedFileInput, sourceRelativePath?: string | null): NormalizedStagedFile {
  const name = sanitizeFilename(file.name || 'upload.bin')
  const normalizedSource = sanitizeSourceRelativePath(sourceRelativePath, name)
  validateStagedFile(file)
  const objectName = `${file.contentHash}${safeObjectExtension(name)}`
  return {
    name,
    sourceRelativePath: normalizedSource,
    sourceKey: normalizedSource ?? name,
    relativePath: path.posix.join('objects', 'sha256', file.contentHash.slice(0, 2), objectName),
    mediaType: file.mediaType || inferMediaType(name),
  }
}

function toEntry(metadata: StoredFileMetadata): StoredFileEntry {
  return {
    id: metadata.id,
    name: metadata.name,
    sourceRelativePath: metadata.sourceRelativePath,
    size: formatBytes(metadata.sizeBytes),
    sizeBytes: metadata.sizeBytes,
    uploadedAt: metadata.uploadedAt,
    status: metadata.status,
    threadId: metadata.threadId,
    relativePath: metadata.relativePath,
    contentHash: metadata.contentHash,
    mediaType: metadata.mediaType,
  }
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function listMetadataFiles(scopeDir: string): Promise<string[]> {
  const dirs = (await listDirectories(scopeDir)).filter(dir => dir !== '_idempotency')
  return dirs.map(dir => path.join(scopeDir, dir, 'metadata.json'))
}

async function readMetadata(filePath: string): Promise<StoredFileMetadata | null> {
  return readJson(filePath, storedFileMetadataSchema)
}

function scopeName(threadId: string): string {
  return safePathSegment(threadId, 'threadId')
}

async function findMetadataBySourceKey(scopeDir: string, sourceKey: string): Promise<StoredFileMetadata | null> {
  for (const metadataPath of await listMetadataFiles(scopeDir)) {
    const metadata = await readMetadata(metadataPath)
    if (metadata && (metadata.sourceRelativePath ?? metadata.name) === sourceKey) return metadata
  }
  return null
}

function safePathSegment(value: string, field: string): string {
  const segment = value.trim()
  if (!segment || !/^[A-Za-z0-9_-]+$/u.test(segment)) throw new Error(`${field} 不是合法标识符`)
  return segment
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-\u4e00-\u9fff]+/gu, '_')
  return base || 'upload.bin'
}

function sanitizeSourceRelativePath(value: string | null | undefined, fallbackName: string): string | null {
  const raw = value?.trim().replaceAll('\\', '/') ?? ''
  if (!raw || raw === fallbackName) return null
  if (raw.includes('\0')) throw new Error('sourceRelativePath 包含非法空字节')
  if (raw.length > 1024) throw new Error('sourceRelativePath 过长')
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:/u.test(raw)) {
    throw new Error('sourceRelativePath 必须是相对路径')
  }
  const normalized = path.posix.normalize(raw)
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('sourceRelativePath 不能跳出上传目录')
  }
  const segments = normalized.split('/').filter(Boolean)
  if (!segments.length || segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error('sourceRelativePath 包含非法路径段')
  }
  const cleaned = segments.map(segment => sanitizeFilename(segment)).join('/')
  return cleaned && cleaned !== fallbackName ? cleaned : null
}

function safeObjectExtension(name: string): string {
  const ext = path.extname(name).toLowerCase()
  return /^[.][a-z0-9]{1,12}$/u.test(ext) ? ext : ''
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function inferMediaType(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.json') || lower.endsWith('.geojson')) return 'application/json'
  if (lower.endsWith('.nc') || lower.endsWith('.nc4')) return 'application/x-netcdf'
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'image/tiff'
  if (lower.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}

function validateStagedFile(file: StagedFileInput): void {
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) {
    throw new Error('暂存文件大小无效。')
  }
  if (!/^[a-f0-9]{64}$/u.test(file.contentHash)) {
    throw new Error('暂存文件内容哈希无效。')
  }
  if (!path.isAbsolute(file.tempPath)) {
    throw new Error('暂存文件路径必须是绝对路径。')
  }
}

async function publishStagedContentObject(file: StagedFileInput, objectPath: string): Promise<void> {
  const directory = path.dirname(objectPath)
  await mkdir(directory, { recursive: true })
  if (await validateAndSyncFile(objectPath, directory, file.contentHash, file.sizeBytes)) return

  // multipart staged inode 先校验并 fsync，再 hardlink 到目标目录的唯一
  // temp 名。大文件全程流式 hash，不读入内存；同目录 rename 只发布
  // 已同步 inode，随后再 fsync 目录项。
  if (!await validateAndSyncFile(file.tempPath, path.dirname(file.tempPath), file.contentHash, file.sizeBytes, false)) {
    throw new Error(`暂存文件 '${file.tempPath}' 的大小或内容哈希不匹配。`)
  }
  const temporary = path.join(
    directory,
    `.${path.basename(objectPath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let published = false
  try {
    await link(file.tempPath, temporary)
    if (process.platform === 'win32') {
      try {
        await rename(temporary, objectPath)
      } catch (error) {
        if (!['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        if (await validateAndSyncFile(objectPath, directory, file.contentHash, file.sizeBytes)) {
          await rm(temporary, { force: true })
          published = true
          return
        }
        const corrupt = path.join(directory, `.${path.basename(objectPath)}.${randomUUID()}.corrupt`)
        await rename(objectPath, corrupt)
        try {
          await rename(temporary, objectPath)
          await rm(corrupt, { force: true })
        } catch (publishError) {
          await rename(corrupt, objectPath).catch(() => undefined)
          throw publishError
        }
      }
    } else {
      // POSIX rename 原子替换既有的损坏 target；并发发布的内容
      // 由同一 hash+size 验证，因此替换仍是同一不变对象。
      await rename(temporary, objectPath)
    }
    published = true
    if (!await validateAndSyncFile(objectPath, directory, file.contentHash, file.sizeBytes)) {
      throw new Error(`内容对象 '${file.contentHash}' 发布后校验失败。`)
    }
  } finally {
    if (!published) await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function validateAndSyncFile(
  filePath: string,
  directory: string,
  expectedHash: string,
  expectedSize: number,
  syncDirectory = true,
): Promise<boolean> {
  let info
  try {
    info = await stat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (!info.isFile() || info.size !== expectedSize) return false
  if (await hashFile(filePath) !== expectedHash) return false
  const handle = await open(filePath, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (syncDirectory && process.platform !== 'win32') await syncDirectoryEntry(directory)
  return true
}

async function syncDirectoryEntry(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function resolveRuntimeRelativePath(objectRoot: string, relativePath: string): string {
  const runtimeRoot = path.dirname(path.dirname(objectRoot))
  if (path.isAbsolute(relativePath)) throw new Error('上传对象路径必须是相对路径。')
  const candidate = path.resolve(runtimeRoot, relativePath)
  if (candidate !== objectRoot && !candidate.startsWith(`${objectRoot}${path.sep}`)) {
    throw new Error('上传对象路径越出内容对象目录。')
  }
  return candidate
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function verifyIdempotencyRecords(scopeDir: string): Promise<void> {
  const directory = path.join(scopeDir, '_idempotency')
  for (const entry of await listJsonFiles(directory)) {
    const record = await readJson(path.join(directory, entry), fileIdempotencyRecordSchema)
    if (!record) throw new Error(`上传幂等记录 '${entry}' 不是合法对象。`)
    const metadata = await readMetadata(path.join(scopeDir, record.fileId, 'metadata.json'))
    if (
      !metadata
      || metadata.contentHash !== record.contentHash
      || metadata.sizeBytes !== record.sizeBytes
      || (metadata.sourceRelativePath ?? metadata.name) !== record.sourceKey
    ) {
      throw new Error(`上传幂等记录 '${record.requestId}' 指向无效文件元数据。`)
    }
  }
}

async function listJsonFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function idempotencyPath(scopeDir: string, requestId: string): string {
  return path.join(scopeDir, '_idempotency', `${requestId}.json`)
}

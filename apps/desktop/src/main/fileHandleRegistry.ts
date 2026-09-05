// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面文件句柄注册表
//
//   文件:       fileHandleRegistry.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-07-29):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: Main 独占文件与目录选择、枚举、指纹校验和一次性读取生命周期。
// --------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import type { ReadStream, Stats } from 'node:fs'
import { lstat, mkdtemp, open, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { dialog, type BrowserWindow } from 'electron'

import {
  DESKTOP_TEXT_FILE_MAX_BYTES,
  desktopImageBlobStageRequestSchema,
  desktopFileSelectionHandleSchema,
  desktopFileSelectionHandlesSchema,
  desktopFileSelectionRequestSchema,
  desktopTextFileReadRequestSchema,
  desktopTextFileReadResultSchema,
  type DesktopFileSelectionHandle,
  type DesktopFileSelectionRequest,
  type DesktopImageBlobStageRequest,
  type DesktopTextFileReadRequest,
  type DesktopTextFileReadResult,
} from '../contracts/desktopIpc.js'

interface RegisteredFile {
  ownerWebContentsId: number
  absolutePath: string
  descriptor: DesktopFileSelectionHandle
  expiresAt: number
  fingerprint: FileFingerprint
  ownedTempDirectory: string | null
}

interface FileFingerprint {
  birthtimeMs: number
  ctimeMs: number
  dev: number
  ino: number
  mtimeMs: number
  size: number
}

interface PreparedFile {
  absolutePath: string
  descriptor: Omit<DesktopFileSelectionHandle, 'handleId'>
  fingerprint: FileFingerprint
  ownedTempDirectory?: string | null
}

export interface OpenedDesktopFile {
  sizeBytes: number
  stream: ReadStream
}

const MAX_HANDLES_PER_WINDOW = 200
const MAX_FOLDER_ENTRIES = 5_000
const MAX_FOLDER_DEPTH = 64
const HANDLE_TTL_MS = 30 * 60 * 1_000

export class FileHandleRegistry {
  private readonly handles = new Map<string, RegisteredFile>()

  constructor(private readonly now: () => number = Date.now) {}

  async select(
    window: BrowserWindow,
    input: DesktopFileSelectionRequest,
  ): Promise<DesktopFileSelectionHandle[]> {
    const request = desktopFileSelectionRequestSchema.parse(input)
    const result = await dialog.showOpenDialog(window, {
      properties: request.kind === 'folder'
        ? ['openDirectory', ...(request.multiple ? ['multiSelections' as const] : [])]
        : ['openFile', ...(request.multiple ? ['multiSelections' as const] : [])],
      filters: request.filters.map(filter => ({
        name: filter.name,
        extensions: filter.extensions,
      })),
    })
    if (result.canceled) return []
    const selectedPaths = request.multiple ? result.filePaths : result.filePaths.slice(0, 1)
    const prepared: PreparedFile[] = []
    if (request.kind === 'folder') {
      for (const selectedPath of selectedPaths) {
        prepared.push(...await prepareFolderFiles(selectedPath, request))
      }
    } else {
      for (const absolutePath of selectedPaths) {
        if (!matchesSelectionFilters(absolutePath, request)) {
          throw new Error(`文件 '${path.basename(absolutePath)}' 不符合当前选择器允许的扩展名。`)
        }
        prepared.push(await prepareFile(
          absolutePath,
          path.basename(absolutePath),
          null,
          inferMediaType(absolutePath),
          path.basename(absolutePath),
        ))
      }
    }
    return this.registerPrepared(window.webContents.id, prepared)
  }

  /**
   * 把 Renderer 生成的图片二进制收敛为 Main 持有的一次性文件句柄。
   * 临时文件在上传流关闭、句柄过期或窗口销毁后回收；绝对路径永不返回。
   */
  async stageImage(
    ownerWebContentsId: number,
    input: DesktopImageBlobStageRequest,
  ): Promise<DesktopFileSelectionHandle> {
    const request = desktopImageBlobStageRequestSchema.parse(input)
    const bytes = new Uint8Array(request.bytes)
    assertImageSignature(bytes, request.mediaType)
    const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-image-'))
    const cleanName = normalizeGeneratedImageName(request.name, request.mediaType)
    const target = path.join(directory, cleanName)
    try {
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
      const prepared = await prepareFile(
        target,
        cleanName,
        bytes.byteLength,
        request.mediaType,
        cleanName,
      )
      prepared.ownedTempDirectory = directory
      const [handle] = this.registerPrepared(ownerWebContentsId, [prepared])
      if (!handle) throw new Error('图片句柄注册失败。')
      return handle
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async readText(
    ownerWebContentsId: number,
    input: DesktopTextFileReadRequest,
  ): Promise<DesktopTextFileReadResult> {
    const request = desktopTextFileReadRequestSchema.parse(input)
    const file = this.consume(ownerWebContentsId, request.handleId, request.expectedName)
    if (request.purpose === 'automation-draft-import' && !file.descriptor.name.toLowerCase().endsWith('.json')) {
      await cleanupRegisteredFile(file)
      throw new Error('自动化流程只允许导入 JSON 文件。')
    }
    if (file.descriptor.sizeBytes > DESKTOP_TEXT_FILE_MAX_BYTES) {
      await cleanupRegisteredFile(file)
      throw new Error(`自动化流程 JSON 不得超过 ${DESKTOP_TEXT_FILE_MAX_BYTES} 字节。`)
    }

    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(file.absolutePath, 'r')
      const details = await handle.stat()
      if (!details.isFile() || !sameFingerprint(file.fingerprint, details)) {
        throw new Error(`文件 '${file.descriptor.name}' 在读取前已发生变化。`)
      }
      const bytes = await handle.readFile()
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new Error(`文件 '${file.descriptor.name}' 不是有效的 UTF-8 文本。`)
      }
      return desktopTextFileReadResultSchema.parse({
        name: file.descriptor.name,
        text,
      })
    } finally {
      await handle?.close()
      await cleanupRegisteredFile(file)
    }
  }

  async openForUpload(
    ownerWebContentsId: number,
    handleId: string,
    expectedName: string,
  ): Promise<OpenedDesktopFile> {
    const file = this.consume(ownerWebContentsId, handleId, expectedName)

    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(file.absolutePath, 'r')
      const details = await handle.stat()
      if (!details.isFile() || !sameFingerprint(file.fingerprint, details)) {
        throw new Error(`文件 '${file.descriptor.name}' 在上传前已发生变化。`)
      }
      const stream = handle.createReadStream({ autoClose: true })
      if (file.ownedTempDirectory) {
        stream.once('close', () => { void cleanupRegisteredFile(file) })
      }
      return {
        sizeBytes: details.size,
        stream,
      }
    } catch (error) {
      await handle?.close()
      await cleanupRegisteredFile(file)
      throw error
    }
  }

  /** 主动放弃未消费的一次性句柄；重复释放按幂等成功处理。 */
  async release(ownerWebContentsId: number, handleId: string): Promise<void> {
    const file = this.handles.get(handleId)
    if (!file || file.ownerWebContentsId !== ownerWebContentsId) return
    this.handles.delete(handleId)
    await cleanupRegisteredFile(file)
  }

  releaseForWebContents(ownerWebContentsId: number): void {
    for (const [handleId, file] of this.handles) {
      if (file.ownerWebContentsId === ownerWebContentsId) {
        this.handles.delete(handleId)
        void cleanupRegisteredFile(file)
      }
    }
  }

  private register(
    ownerWebContentsId: number,
    input: PreparedFile,
  ): DesktopFileSelectionHandle {
    const handleId = randomUUID()
    const descriptor = desktopFileSelectionHandleSchema.parse({
      handleId,
      ...input.descriptor,
    })
    this.handles.set(handleId, {
      ownerWebContentsId,
      absolutePath: input.absolutePath,
      descriptor,
      expiresAt: this.now() + HANDLE_TTL_MS,
      fingerprint: input.fingerprint,
      ownedTempDirectory: input.ownedTempDirectory ?? null,
    })
    return descriptor
  }

  private registerPrepared(
    ownerWebContentsId: number,
    prepared: readonly PreparedFile[],
  ): DesktopFileSelectionHandle[] {
    this.purgeExpired(ownerWebContentsId)
    const existingCount = Array.from(this.handles.values()).filter(
      file => file.ownerWebContentsId === ownerWebContentsId,
    ).length
    if (existingCount + prepared.length > MAX_HANDLES_PER_WINDOW) {
      throw new Error(`每个工作区窗口最多保留 ${MAX_HANDLES_PER_WINDOW} 个文件句柄。`)
    }
    desktopFileSelectionHandlesSchema.parse(prepared.map(file => ({
      handleId: '00000000-0000-4000-8000-000000000000',
      ...file.descriptor,
    })))
    return prepared.map(file => this.register(ownerWebContentsId, file))
  }

  private purgeExpired(ownerWebContentsId: number): void {
    const now = this.now()
    for (const [handleId, file] of this.handles) {
      if (file.ownerWebContentsId === ownerWebContentsId && file.expiresAt <= now) {
        this.handles.delete(handleId)
        void cleanupRegisteredFile(file)
      }
    }
  }

  private consume(
    ownerWebContentsId: number,
    handleId: string,
    expectedName: string,
  ): RegisteredFile {
    const file = this.handles.get(handleId)
    if (!file || file.ownerWebContentsId !== ownerWebContentsId) {
      throw new Error('文件句柄不存在、已失效或不属于当前工作区窗口。')
    }
    this.handles.delete(handleId)
    if (file.expiresAt <= this.now()) {
      void cleanupRegisteredFile(file)
      throw new Error('文件句柄已过期，请重新选择文件。')
    }
    if (file.descriptor.name.normalize('NFC') !== expectedName.normalize('NFC')) {
      void cleanupRegisteredFile(file)
      throw new Error('文件名与不透明句柄登记的信息不一致。')
    }
    return file
  }
}

async function prepareFile(
  requestedPath: string,
  expectedName: string,
  expectedSize: number | null,
  mediaType: string,
  relativePath: string,
): Promise<PreparedFile> {
  const linkDetails = await lstat(requestedPath)
  if (linkDetails.isSymbolicLink()) {
    throw new Error(`文件选择拒绝符号链接：${expectedName}`)
  }
  const canonicalPath = await realpath(requestedPath)
  const details = await stat(canonicalPath)
  if (!details.isFile()) throw new Error(`选择结果不是普通文件：${expectedName}`)
  if (
    path.basename(canonicalPath).normalize('NFC') !== expectedName.normalize('NFC')
    || (expectedSize !== null && details.size !== expectedSize)
  ) {
    throw new Error(`拖放文件 '${expectedName}' 在注册时已发生变化。`)
  }
  return {
    absolutePath: canonicalPath,
    descriptor: {
      name: path.basename(canonicalPath),
      sizeBytes: details.size,
      mediaType,
      relativePath,
      modifiedAtMs: details.mtimeMs,
    },
    fingerprint: fingerprint(details),
  }
}

async function prepareFolderFiles(
  requestedRoot: string,
  request: DesktopFileSelectionRequest,
): Promise<PreparedFile[]> {
  const rootLink = await lstat(requestedRoot)
  if (rootLink.isSymbolicLink()) {
    throw new Error(`文件夹选择拒绝符号链接：${path.basename(requestedRoot)}`)
  }
  const canonicalRoot = await realpath(requestedRoot)
  const rootDetails = await stat(canonicalRoot)
  if (!rootDetails.isDirectory()) {
    throw new Error(`选择结果不是文件夹：${path.basename(requestedRoot)}`)
  }
  const rootName = path.basename(canonicalRoot) || '所选文件夹'
  const prepared: PreparedFile[] = []
  let visitedEntries = 0

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > MAX_FOLDER_DEPTH) {
      throw new Error(`所选文件夹的目录深度不得超过 ${MAX_FOLDER_DEPTH} 层。`)
    }
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    for (const entry of entries) {
      visitedEntries += 1
      if (visitedEntries > MAX_FOLDER_ENTRIES) {
        throw new Error(`单次文件夹选择最多检查 ${MAX_FOLDER_ENTRIES} 个目录项。`)
      }
      const entryPath = path.join(directory, entry.name)
      const linkDetails = await lstat(entryPath)
      if (linkDetails.isSymbolicLink()) {
        throw new Error(`文件夹中包含不允许的符号链接：${entry.name}`)
      }
      if (linkDetails.isDirectory()) {
        await visit(entryPath, depth + 1)
        continue
      }
      if (!linkDetails.isFile() || !matchesSelectionFilters(entryPath, request)) continue
      const nestedPath = path.relative(canonicalRoot, entryPath).split(path.sep).join('/')
      prepared.push(await prepareFile(
        entryPath,
        entry.name,
        linkDetails.size,
        inferMediaType(entryPath),
        `${rootName}/${nestedPath}`,
      ))
      if (prepared.length > MAX_HANDLES_PER_WINDOW) {
        throw new Error(`单次文件夹选择最多包含 ${MAX_HANDLES_PER_WINDOW} 个普通文件。`)
      }
    }
  }

  await visit(canonicalRoot, 0)
  return prepared
}

function matchesSelectionFilters(
  filePath: string,
  request: DesktopFileSelectionRequest,
): boolean {
  const allowed = new Set(
    request.filters.flatMap(filter => filter.extensions.map(extension => extension.toLowerCase())),
  )
  if (allowed.size === 0) return true
  const extension = path.extname(filePath).slice(1).toLowerCase()
  return allowed.has(extension)
}

function inferMediaType(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase()
  if (extension === 'json' || extension === 'geojson') return 'application/json'
  if (extension === 'csv') return 'text/csv'
  if (extension === 'txt' || extension === 'md') return 'text/plain'
  if (extension === 'zip') return 'application/zip'
  if (extension === 'tif' || extension === 'tiff') return 'image/tiff'
  if (extension === 'nc' || extension === 'nc4') return 'application/x-netcdf'
  return 'application/octet-stream'
}

function fingerprint(details: Stats): FileFingerprint {
  return {
    birthtimeMs: details.birthtimeMs,
    ctimeMs: details.ctimeMs,
    dev: details.dev,
    ino: details.ino,
    mtimeMs: details.mtimeMs,
    size: details.size,
  }
}

function sameFingerprint(expected: FileFingerprint, actual: Stats): boolean {
  const current = fingerprint(actual)
  return Object.entries(expected).every(([key, value]) => (
    current[key as keyof FileFingerprint] === value
  ))
}

async function cleanupRegisteredFile(file: RegisteredFile): Promise<void> {
  if (!file.ownedTempDirectory) return
  const directory = file.ownedTempDirectory
  file.ownedTempDirectory = null
  await rm(directory, { recursive: true, force: true }).catch(() => undefined)
}

function normalizeGeneratedImageName(name: string, mediaType: DesktopImageBlobStageRequest['mediaType']): string {
  const extension = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  }[mediaType]
  const requested = path.basename(name).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/u, '')
  const stem = path.basename(requested || 'pasted-image', path.extname(requested || '')) || 'pasted-image'
  return `${stem.slice(0, 220)}${extension}`
}

function assertImageSignature(
  bytes: Uint8Array,
  mediaType: DesktopImageBlobStageRequest['mediaType'],
): void {
  const matches = mediaType === 'image/png'
    ? startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    : mediaType === 'image/jpeg'
      ? startsWith(bytes, [0xff, 0xd8, 0xff])
      : mediaType === 'image/gif'
        ? startsWith(bytes, [0x47, 0x49, 0x46, 0x38])
        : startsWith(bytes, [0x52, 0x49, 0x46, 0x46])
          && bytes.length >= 12
          && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  if (!matches) throw new Error(`图片内容与声明的媒体类型 '${mediaType}' 不一致。`)
}

function startsWith(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value)
}

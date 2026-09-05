// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面不透明文件句柄测试
//
//   文件:       fileHandleRegistry.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
  },
}))

import { dialog, type BrowserWindow } from 'electron'
import { DESKTOP_TEXT_FILE_MAX_BYTES } from '../contracts/desktopIpc.js'
import { FileHandleRegistry } from './fileHandleRegistry.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.mocked(dialog.showOpenDialog).mockReset()
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('FileHandleRegistry', () => {
  it('creates an opaque owner-bound handle directly from the native picker', async () => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, '杭州雷达.txt')
    const content = Buffer.from('radar')
    await writeFile(filePath, content)
    mockNativeSelection([filePath])
    const registry = new FileHandleRegistry()

    const handles = await registry.select(windowFor(41), {
      kind: 'files',
      multiple: false,
      filters: [],
    })

    expect(handles).toHaveLength(1)
    expect(handles[0]).toMatchObject({
      name: '杭州雷达.txt',
      relativePath: '杭州雷达.txt',
      sizeBytes: content.byteLength,
    })
    expect(JSON.stringify(handles)).not.toContain(filePath)
    const handleId = handles[0]?.handleId ?? ''
    await expect(registry.openForUpload(42, handleId, '杭州雷达.txt')).rejects.toThrow(
      '不属于当前工作区窗口',
    )
    const opened = await registry.openForUpload(41, handleId, '杭州雷达.txt')
    const chunks: Buffer[] = []
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(content)
    await expect(registry.openForUpload(41, handleId, '杭州雷达.txt')).rejects.toThrow(
      '文件句柄不存在',
    )
  })

  it('revalidates native picker results against the fixed extension filter', async () => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, 'secret.txt')
    await writeFile(filePath, 'not-json')
    mockNativeSelection([filePath])
    const registry = new FileHandleRegistry()

    await expect(registry.select(windowFor(1), {
      kind: 'files',
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })).rejects.toThrow('不符合当前选择器允许的扩展名')
    expect(internalHandleCount(registry)).toBe(0)
  })

  it('expires handles and detects replacement before upload', async () => {
    let now = 100
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, 'source.txt')
    await writeFile(filePath, 'first')
    const registry = new FileHandleRegistry(() => now)

    mockNativeSelection([filePath])
    const [expiring] = await registry.select(windowFor(1), {
      kind: 'files',
      multiple: false,
      filters: [],
    })
    now += 31 * 60 * 1_000
    await expect(registry.openForUpload(
      1,
      expiring?.handleId ?? '',
      'source.txt',
    )).rejects.toThrow('已过期')

    now = 100
    mockNativeSelection([filePath])
    const [changed] = await registry.select(windowFor(1), {
      kind: 'files',
      multiple: false,
      filters: [],
    })
    await writeFile(filePath, 'changed-content')
    await expect(registry.openForUpload(
      1,
      changed?.handleId ?? '',
      'source.txt',
    )).rejects.toThrow('上传前已发生变化')
  })

  it('does not publish partial handles when a later native result is invalid', async () => {
    const directory = await createTemporaryDirectory()
    const validPath = path.join(directory, 'valid.txt')
    await writeFile(validPath, 'valid')
    mockNativeSelection([validPath, directory])
    const registry = new FileHandleRegistry()

    await expect(registry.select(windowFor(1), {
      kind: 'files',
      multiple: true,
      filters: [],
    })).rejects.toThrow('不是普通文件')
    expect(internalHandleCount(registry)).toBe(0)
  })

  it('enumerates a selected folder in Main and exposes only normalized relative paths', async () => {
    const directory = await createTemporaryDirectory()
    const folder = path.join(directory, '演示数据')
    const nested = path.join(folder, '雷达')
    await writeFileTree(nested, {
      'scan.bz2': 'radar',
      'notes.txt': 'notes',
    })
    mockNativeSelection([folder])
    const registry = new FileHandleRegistry()

    const handles = await registry.select(windowFor(7), {
      kind: 'folder',
      multiple: false,
      filters: [],
    })

    expect(handles.map(handle => handle.relativePath)).toEqual([
      '演示数据/雷达/notes.txt',
      '演示数据/雷达/scan.bz2',
    ])
    expect(JSON.stringify(handles)).not.toContain(directory)
  })

  it('reads a small UTF-8 automation draft once and rejects oversized text', async () => {
    const directory = await createTemporaryDirectory()
    const validPath = path.join(directory, 'rainfall.json')
    await writeFile(validPath, '{"name":"rainfall"}')
    mockNativeSelection([validPath])
    const registry = new FileHandleRegistry()
    const [valid] = await registry.select(windowFor(9), {
      kind: 'files',
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })

    await expect(registry.readText(9, {
      handleId: valid?.handleId ?? '',
      expectedName: 'rainfall.json',
      purpose: 'automation-draft-import',
    })).resolves.toEqual({
      name: 'rainfall.json',
      text: '{"name":"rainfall"}',
    })
    await expect(registry.readText(9, {
      handleId: valid?.handleId ?? '',
      expectedName: 'rainfall.json',
      purpose: 'automation-draft-import',
    })).rejects.toThrow('文件句柄不存在')

    const oversizedPath = path.join(directory, 'oversized.json')
    await writeFile(oversizedPath, 'x'.repeat(DESKTOP_TEXT_FILE_MAX_BYTES + 1))
    mockNativeSelection([oversizedPath])
    const [oversized] = await registry.select(windowFor(9), {
      kind: 'files',
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    await expect(registry.readText(9, {
      handleId: oversized?.handleId ?? '',
      expectedName: 'oversized.json',
      purpose: 'automation-draft-import',
    })).rejects.toThrow('不得超过')
  })

  it('stages a signature-checked image as an owner-bound one-time handle', async () => {
    const registry = new FileHandleRegistry()
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00,
    ])
    const handle = await registry.stageImage(23, {
      name: '../clipboard.jpeg',
      mediaType: 'image/png',
      bytes: bytes.buffer,
    })

    expect(handle).toMatchObject({
      name: 'clipboard.png',
      relativePath: 'clipboard.png',
      mediaType: 'image/png',
      sizeBytes: bytes.byteLength,
    })
    expect(JSON.stringify(handle)).not.toContain(os.tmpdir())
    await expect(registry.openForUpload(24, handle.handleId, handle.name)).rejects.toThrow(
      '不属于当前工作区窗口',
    )
    const opened = await registry.openForUpload(23, handle.handleId, handle.name)
    const chunks: Buffer[] = []
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes))
    await expect(registry.openForUpload(23, handle.handleId, handle.name)).rejects.toThrow(
      '文件句柄不存在',
    )
  })

  it('rejects staged image bytes whose signature disagrees with the declared type', async () => {
    const registry = new FileHandleRegistry()
    await expect(registry.stageImage(1, {
      name: 'spoofed.png',
      mediaType: 'image/png',
      bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0x00]).buffer,
    })).rejects.toThrow('媒体类型')
    expect(internalHandleCount(registry)).toBe(0)
  })

  it('releases an abandoned staged image only for its owning window', async () => {
    const registry = new FileHandleRegistry()
    const handle = await registry.stageImage(23, {
      name: 'map.png',
      mediaType: 'image/png',
      bytes: pngBytes().buffer,
    })
    const directory = internalRegisteredFile(registry, handle.handleId).ownedTempDirectory
    expect(directory).toBeTruthy()

    await registry.release(24, handle.handleId)
    expect(internalHandleCount(registry)).toBe(1)
    await expect(stat(directory ?? '')).resolves.toBeDefined()

    await registry.release(23, handle.handleId)
    await registry.release(23, handle.handleId)
    expect(internalHandleCount(registry)).toBe(0)
    await expect(stat(directory ?? '')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans a staged image when opening its temporary file fails', async () => {
    const registry = new FileHandleRegistry()
    const handle = await registry.stageImage(23, {
      name: 'map.png',
      mediaType: 'image/png',
      bytes: pngBytes().buffer,
    })
    const registered = internalRegisteredFile(registry, handle.handleId)
    const directory = registered.ownedTempDirectory
    await rm(registered.absolutePath)

    await expect(registry.openForUpload(23, handle.handleId, handle.name)).rejects.toThrow()
    await expect(stat(directory ?? '')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

function pngBytes(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00,
  ])
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-file-handles-'))
  temporaryDirectories.push(directory)
  return directory
}

async function writeFileTree(
  directory: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(directory, { recursive: true })
  await Promise.all(Object.entries(files).map(([name, content]) => (
    writeFile(path.join(directory, name), content)
  )))
}

function mockNativeSelection(filePaths: string[]): void {
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({
    canceled: false,
    filePaths,
  })
}

function windowFor(webContentsId: number): BrowserWindow {
  return {
    webContents: { id: webContentsId },
  } as unknown as BrowserWindow
}

function internalHandleCount(registry: FileHandleRegistry): number {
  return (registry as unknown as { handles: Map<string, unknown> }).handles.size
}

function internalRegisteredFile(registry: FileHandleRegistry, handleId: string): {
  absolutePath: string
  ownedTempDirectory: string | null
} {
  const file = (registry as unknown as {
    handles: Map<string, { absolutePath: string; ownedTempDirectory: string | null }>
  }).handles.get(handleId)
  if (!file) throw new Error(`Missing internal test handle ${handleId}`)
  return file
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 通用线程文件存储测试
//
//   文件:       fileStore.test.ts
//
//   日期:       2026年06月15日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RuntimeFileStore } from './fileStore.js'

describe('RuntimeFileStore path boundaries', () => {
  it('rejects thread and file identifiers that can escape their scope', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-files-'))
    try {
      const files = new RuntimeFileStore(root)
      await expect(files.list('../outside')).rejects.toThrow('threadId 不是合法标识符')
      await expect(files.delete('../outside', 'thread_1')).rejects.toThrow('fileId 不是合法标识符')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // 上传重试必须复用同一存储条目，避免大批气象文件出现重复时次。
  it('treats a request id as an idempotent upload key', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-files-'))
    try {
      const files = new RuntimeFileStore(root)
      const file = await stageFile(root, 'sample.nc', [1, 2, 3])

      const first = await files.save(file, 'thread_1', 'upload_retry_1')
      const retried = await files.save(file, 'thread_1', 'upload_retry_1')
      const reuploaded = await files.save(file, 'thread_1', 'upload_retry_2')
      const entries = await files.list('thread_1')

      expect(retried.id).toBe(first.id)
      expect(reuploaded.id).toBe(first.id)
      expect(first.id).not.toBe('upload_retry_1')
      expect(entries).toHaveLength(1)
      expect(entries[0].name).toBe('sample.nc')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // 气象和边界 reader 需要从 runtime 相对路径识别格式；对象身份仍由 sha256 校验。
  it('keeps the original safe extension on content-addressed objects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-files-'))
    try {
      const files = new RuntimeFileStore(root)
      const entry = await files.save(
        await stageFile(root, '202604091955_202604092000.nc', [1, 2, 3]),
        'thread_1',
        'upload_nc',
      )

      expect(entry.relativePath).toMatch(/^objects\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}[.]nc$/u)
      await expect(stat(path.join(root, entry.relativePath))).resolves.toMatchObject({ size: 3 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // 文件夹上传依赖来源相对路径区分同名文件；工具读取仍使用安全的内容寻址路径。
  it('preserves folder relative paths without using them as runtime object paths', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'geo-files-'))
    try {
      const files = new RuntimeFileStore(root)

      const first = await files.save(
        await stageFile(root, 'latest.bin.bz2', [1]),
        'thread_1',
        null,
        'Z9041/latest.bin.bz2',
      )
      const second = await files.save(
        await stageFile(root, 'latest.bin.bz2', [2]),
        'thread_1',
        null,
        'Z9573/latest.bin.bz2',
      )
      const entries = await files.list('thread_1')

      expect(first.sourceRelativePath).toBe('Z9041/latest.bin.bz2')
      expect(second.sourceRelativePath).toBe('Z9573/latest.bin.bz2')
      expect(entries.map(entry => entry.sourceRelativePath).sort()).toEqual(['Z9041/latest.bin.bz2', 'Z9573/latest.bin.bz2'])
      expect(entries.every(entry => entry.relativePath.startsWith('objects/sha256/'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a request id reused for different upload content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-files-'))
    try {
      const files = new RuntimeFileStore(root)
      await files.save(await stageFile(root, 'sample.nc', [1]), 'thread_1', 'same_request')
      await expect(
        files.save(await stageFile(root, 'sample.nc', [2]), 'thread_1', 'same_request'),
      ).rejects.toThrow("requestId 'same_request' 已用于不同的上传内容")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serializes concurrent retries through the injected store and publishes one server id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-files-'))
    try {
      const firstStore = new RuntimeFileStore(root)
      const [first, second] = await Promise.all([
        firstStore.save(await stageFile(root, 'sample.nc', [1, 2, 3]), 'thread_1', 'parallel_request'),
        firstStore.save(await stageFile(root, 'sample.nc', [1, 2, 3]), 'thread_1', 'parallel_request'),
      ])

      expect(second.id).toBe(first.id)
      expect(first.id).not.toBe('parallel_request')
      await expect(firstStore.list('thread_1')).resolves.toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never lists or deletes files outside the requested thread', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-files-'))
    try {
      const files = new RuntimeFileStore(root)
      const first = await files.save(await stageFile(root, 'first.nc', [1]), 'thread_1')
      const second = await files.save(await stageFile(root, 'second.nc', [2]), 'thread_2')

      await expect(files.list('thread_1')).resolves.toMatchObject([{ id: first.id }])
      await expect(files.delete(second.id, 'thread_1')).resolves.toBe(false)
      await expect(files.list('thread_2')).resolves.toMatchObject([{ id: second.id }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function stageFile(root: string, name: string, bytes: number[]) {
  const stagingRoot = path.join(root, 'staging')
  await mkdir(stagingRoot, { recursive: true })
  const tempPath = path.join(stagingRoot, `${randomUUID()}.upload`)
  const content = Buffer.from(bytes)
  await writeFile(tempPath, content)
  return {
    name,
    tempPath,
    sizeBytes: content.byteLength,
    contentHash: createHash('sha256').update(content).digest('hex'),
    mediaType: 'application/octet-stream',
  }
}

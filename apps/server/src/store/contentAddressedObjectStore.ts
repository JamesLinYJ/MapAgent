// +-------------------------------------------------------------------------
//
//   地理智能平台 - 内容寻址对象存储
//
//   文件:       contentAddressedObjectStore.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { ContentRef } from '../schemas/types.js'

// ContentAddressedObjectStore 只负责 SHA256 blob 的物理读写和完整性校验。
// 引用生命周期、GC 和会话语义由 ConversationPayloadStore 编排。
export class ContentAddressedObjectStore {
  private readonly publications = new Map<string, Promise<void>>()

  constructor(
    private readonly objectsRoot: string,
    private readonly publicationBoundary: {
      afterAtomicPublishBeforeSync?(): Promise<void>
    } = {},
  ) {}

  async put(content: string | Uint8Array, mediaType = 'application/octet-stream'): Promise<ContentRef> {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const relativePath = path.posix.join('objects', 'sha256', hash.slice(0, 2), hash)
    const target = path.join(this.objectsRoot, hash.slice(0, 2), hash)
    const directory = path.dirname(target)
    await mkdir(directory, { recursive: true })
    const activePublication = this.publications.get(hash)
    if (activePublication) {
      await activePublication
    } else {
      const publication = this.publishDurably(target, directory, hash, bytes)
      this.publications.set(hash, publication)
      try {
        await publication
      } finally {
        if (this.publications.get(hash) === publication) this.publications.delete(hash)
      }
    }
    return { algorithm: 'sha256', hash, mediaType, sizeBytes: bytes.byteLength, relativePath }
  }

  private async publishDurably(
    target: string,
    directory: string,
    hash: string,
    bytes: Buffer,
  ): Promise<void> {
    if (await validateAndSyncObjectAt(target, directory, hash, bytes.byteLength)) return

    // 不能直接以 wx 写最终 hash 路径：进程在 write 中崩溃会留下一个被
    // EEXIST 误认成成功的半文件。临时文件和 target 同目录，因此 rename
    // 是同一文件系统内的原子发布；文件与目录都 fsync 后才允许返回引用。
    const temporary = path.join(directory, `.${hash}.${process.pid}.${randomUUID()}.tmp`)
    let published = false
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await rename(temporary, target)
        published = true
        await this.publicationBoundary.afterAtomicPublishBeforeSync?.()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!['EEXIST', 'EPERM'].includes(code ?? '')) throw error
        if (await validateAndSyncObjectAt(target, directory, hash, bytes.byteLength)) {
          await rm(temporary, { force: true })
          published = true
        } else {
          // Windows 不允许 rename 覆盖现有文件。先隔离已确认损坏的 target，
          // 再原子发布完整临时文件；失败时尽力恢复原路径并向上抛错。
          const corrupt = path.join(directory, `.${hash}.${randomUUID()}.corrupt`)
          await rename(target, corrupt)
          try {
            await rename(temporary, target)
            published = true
            await this.publicationBoundary.afterAtomicPublishBeforeSync?.()
            await rm(corrupt, { force: true })
          } catch (publishError) {
            await rename(corrupt, target).catch(() => undefined)
            throw publishError
          }
        }
      }
      if (!await validateAndSyncObjectAt(target, directory, hash, bytes.byteLength)) {
        throw new Error(`contentRef 原子发布校验失败：${hash}`)
      }
    } finally {
      if (!published) await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async read(reference: ContentRef): Promise<Uint8Array> {
    if (reference.algorithm !== 'sha256') {
      throw new Error('contentRef 哈希格式无效')
    }
    return this.readByHash(reference.hash)
  }

  async readByHash(hash: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error('contentRef 哈希格式无效')
    const target = path.join(this.objectsRoot, hash.slice(0, 2), hash)
    const bytes = await readFile(target)
    const actualHash = createHash('sha256').update(bytes).digest('hex')
    if (actualHash !== hash) throw new Error(`contentRef 校验失败：${hash}`)
    return bytes
  }
}

async function validateAndSyncObjectAt(
  target: string,
  directory: string,
  expectedHash: string,
  expectedSize: number,
): Promise<boolean> {
  let handle
  try {
    // Windows FlushFileBuffers requires a handle with write access. Objects are
    // created 0600 by this store, so r+ is the portable durability handle there.
    handle = await open(target, 'r+')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  try {
    const bytes = await handle.readFile()
    const valid = bytes.byteLength === expectedSize
      && createHash('sha256').update(bytes).digest('hex') === expectedHash
    if (!valid) return false
    await handle.sync()
  } finally {
    await handle.close()
  }
  // Node.js 在 Windows 上不能以普通 FileHandle 打开目录；上面的 target
  // fsync 是该平台可用的 durability 边界。POSIX 还必须同步目录项本身。
  if (process.platform !== 'win32') {
    const directoryHandle = await open(directory, 'r')
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  }
  return true
}

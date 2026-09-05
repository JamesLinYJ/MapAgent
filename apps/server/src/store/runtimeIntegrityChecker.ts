// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行时数据完整性检查
//
//   文件:       runtimeIntegrityChecker.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import PQueue from 'p-queue'
import { z } from 'zod'

import type { Database } from '../db/connection.js'
import type { RuntimeFileStore } from './fileStore.js'
import { ContentAddressedObjectStore } from './contentAddressedObjectStore.js'

interface ObjectReferenceRow {
  object_hash: string
  source: string
}

interface ArtifactReferenceRow {
  artifact_id: string
  content_relative_path: string
}

interface FileContentReferenceRow {
  content_hash: string
  content_relative_path: string
  size_bytes: number
  source: string
}

interface FileProjectionRow {
  file_id: string
  thread_id: string
  status: 'pending' | 'ready' | 'deleted'
}

const objectReferenceRowsSchema = z.array(z.object({
  object_hash: z.string().min(1),
  source: z.string().min(1),
}))

const artifactReferenceRowsSchema = z.array(z.object({
  artifact_id: z.string().min(1),
  content_relative_path: z.string().min(1),
}))

const fileContentReferenceRowsSchema = z.array(z.object({
  content_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  content_relative_path: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  source: z.string().min(1),
}))

const fileProjectionRowsSchema = z.array(z.object({
  file_id: z.string().min(1),
  thread_id: z.string().min(1),
  status: z.enum(['pending', 'ready', 'deleted']),
}))

export interface RuntimeIntegrityCatalog {
  listObjectReferences(): Promise<ObjectReferenceRow[]>
  listFileContentReferences(): Promise<FileContentReferenceRow[]>
  listFileProjections(): Promise<FileProjectionRow[]>
  listArtifactReferences(): Promise<ArtifactReferenceRow[]>
}

export class PostgresRuntimeIntegrityCatalog implements RuntimeIntegrityCatalog {
  constructor(private readonly db: Pick<Database, 'execute'>) {}

  async listObjectReferences(): Promise<ObjectReferenceRow[]> {
    const result = await this.db.execute(sql`
      SELECT sdk_state_content_hash AS object_hash, 'run:' || run_id AS source
      FROM platform_runs
      WHERE sdk_state_content_hash IS NOT NULL
      UNION ALL
      SELECT content_hash AS object_hash, 'thread-memory:' || thread_id || ':' || version::text AS source
      FROM platform_thread_memory_versions
    `)
    return objectReferenceRowsSchema.parse(result.rows)
  }

  async listFileContentReferences(): Promise<FileContentReferenceRow[]> {
    const result = await this.db.execute(sql`
      SELECT content_hash, relative_path AS content_relative_path, size_bytes, 'file:' || file_id AS source
      FROM platform_file_objects
      WHERE status = 'ready'
      UNION ALL
      SELECT content_hash, file_relative_path AS content_relative_path, size_bytes,
        'meteorological-dataset:' || dataset_id AS source
      FROM platform_meteorological_datasets
      WHERE status = 'ready' AND content_hash IS NOT NULL
    `)
    return fileContentReferenceRowsSchema.parse(result.rows)
  }

  async listFileProjections(): Promise<FileProjectionRow[]> {
    const result = await this.db.execute(sql`
      SELECT file_id, thread_id, status
      FROM platform_file_objects
      ORDER BY file_id
    `)
    return fileProjectionRowsSchema.parse(result.rows)
  }

  async listArtifactReferences(): Promise<ArtifactReferenceRow[]> {
    const result = await this.db.execute(sql`
      SELECT artifact_id, content_relative_path
      FROM platform_artifacts
      ORDER BY artifact_id
    `)
    return artifactReferenceRowsSchema.parse(result.rows)
  }
}

/**
 * 启动期检查结构化事实指向的外部内容。检查器只读、不修复、不删除，
 * 以免在引用关系不完整时把数据损坏误判成可自动恢复状态。
 */
export class RuntimeIntegrityChecker {
  private readonly runtimeRoot: string
  private readonly objectStore: ContentAddressedObjectStore

  constructor(
    private readonly catalog: RuntimeIntegrityCatalog,
    private readonly runtimeFiles: Pick<RuntimeFileStore, 'verifyIntegrity'>,
    runtimeRoot: string,
  ) {
    this.runtimeRoot = path.resolve(runtimeRoot)
    this.objectStore = new ContentAddressedObjectStore(path.join(this.runtimeRoot, 'objects', 'sha256'))
  }

  async verify(): Promise<void> {
    const [objectReferences, fileContentReferences, fileProjections, artifactReferences] = await Promise.all([
      this.catalog.listObjectReferences(),
      this.catalog.listFileContentReferences(),
      this.catalog.listFileProjections(),
      this.catalog.listArtifactReferences(),
    ])
    const queue = new PQueue({ concurrency: 8 })
    const failures: string[] = []

    for (const reference of objectReferences) {
      queue.add(async () => {
        try {
          if (!/^[a-f0-9]{64}$/u.test(reference.object_hash)) {
            throw new Error('不是合法 SHA256')
          }
          await this.objectStore.readByHash(reference.object_hash)
        } catch (error) {
          failures.push(`${reference.source} -> ${reference.object_hash}: ${errorMessage(error)}`)
        }
      })
    }
    for (const artifact of artifactReferences) {
      queue.add(async () => {
        try {
          await verifyArtifactPath(this.runtimeRoot, artifact)
        } catch (error) {
          failures.push(`artifact:${artifact.artifact_id}: ${errorMessage(error)}`)
        }
      })
    }
    for (const reference of fileContentReferences) {
      queue.add(async () => {
        try {
          await verifyFileContentPath(this.runtimeRoot, reference)
        } catch (error) {
          failures.push(`${reference.source}: ${errorMessage(error)}`)
        }
      })
    }
    await queue.onIdle()

    try {
      const runtimeIntegrity = await this.runtimeFiles.verifyIntegrity()
      const ledger = new Map(fileProjections.map(row => [row.file_id, row.thread_id]))
      const physicalFileIds = new Set<string>()
      for (const projection of runtimeIntegrity.projections) {
        if (physicalFileIds.has(projection.fileId)) {
          failures.push(`runtime-upload:${projection.fileId}: 同一文件存在多个物理 metadata 投影。`)
          continue
        }
        physicalFileIds.add(projection.fileId)
        const threadId = ledger.get(projection.fileId)
        if (!threadId) {
          failures.push(
            `runtime-upload:${projection.fileId}: 物理 metadata 没有对应的数据库文件记录。`
            + '请先运行 `npm run migrate:file-lifecycle` dry-run，确认后再运行 '
            + '`npm run migrate:file-lifecycle -- --confirm`；'
            + '系统不会自动导入或使用运行时 fallback。',
          )
        } else if (threadId !== projection.threadId) {
          failures.push(`runtime-upload:${projection.fileId}: metadata 与数据库线程归属不一致。`)
        }
      }
      for (const projection of fileProjections) {
        if (projection.status === 'ready' && !physicalFileIds.has(projection.file_id)) {
          failures.push(`file:${projection.file_id}: 数据库 ready 文件缺少物理 metadata 投影。`)
        }
      }
    } catch (error) {
      failures.push(`runtime-upload: ${errorMessage(error)}`)
    }

    if (failures.length > 0) {
      throw new Error(
        `运行时数据完整性检查失败，共 ${failures.length} 项。`
        + '系统未修改任何数据；请从备份恢复缺失内容或修正数据库引用后再启动。\n'
        + failures.slice(0, 20).join('\n'),
      )
    }
  }
}

async function verifyFileContentPath(
  runtimeRoot: string,
  reference: FileContentReferenceRow,
): Promise<void> {
  if (path.isAbsolute(reference.content_relative_path)) throw new Error('内容路径必须是运行目录内的相对路径')
  const objectRoot = path.resolve(runtimeRoot, 'objects', 'sha256')
  const candidate = path.resolve(runtimeRoot, reference.content_relative_path)
  if (!isWithin(objectRoot, candidate)) throw new Error('内容路径越出内容对象目录')
  const [canonicalRoot, canonical] = await Promise.all([realpath(objectRoot), realpath(candidate)])
  if (!isWithin(canonicalRoot, canonical)) throw new Error('内容链接越出内容对象目录')
  const info = await stat(canonical)
  if (!info.isFile()) throw new Error('内容路径不是普通文件')
  if (info.size !== reference.size_bytes) throw new Error('内容大小与数据库记录不一致')
  if (await hashFile(canonical) !== reference.content_hash) throw new Error('内容哈希与数据库记录不一致')
}

async function verifyArtifactPath(
  runtimeRoot: string,
  artifact: ArtifactReferenceRow,
): Promise<void> {
  if (!artifact.content_relative_path || path.isAbsolute(artifact.content_relative_path)) {
    throw new Error('内容路径必须是运行目录内的相对路径')
  }
  const candidate = path.resolve(runtimeRoot, artifact.content_relative_path)
  if (!isWithin(runtimeRoot, candidate)) throw new Error('内容路径越出运行目录')
  const canonical = await realpath(candidate)
  if (!isWithin(runtimeRoot, canonical)) throw new Error('内容链接越出运行目录')
  const info = await stat(canonical)
  if (!info.isFile()) throw new Error('内容路径不是普通文件')
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

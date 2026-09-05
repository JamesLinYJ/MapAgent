#!/usr/bin/env node

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 旧上传元数据显式迁移
//
//   旧 RuntimeFileStore metadata 只允许通过这个一次性命令导入
//   platform_file_objects。默认 dry-run；不会在服务启动时静默 fallback。
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import pg from 'pg'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(repositoryRoot, '.env'), quiet: true })

const arguments_ = new Set(process.argv.slice(2))
const supportedArguments = new Set(['--confirm', '--help'])
const unknownArguments = [...arguments_].filter(argument => !supportedArguments.has(argument))
if (unknownArguments.length > 0) {
  throw new Error(`不支持的参数：${unknownArguments.join('、')}`)
}
if (arguments_.has('--help')) {
  process.stdout.write([
    '用法：node scripts/migrate-runtime-file-metadata.mjs [--confirm]',
    '',
    '默认只执行 dry-run。--confirm 会在单个数据库事务中导入已验证记录，',
    '随后把旧 _idempotency 目录移动到 runtime/migration-archive。',
    '',
  ].join('\n'))
  process.exit(0)
}

if (!process.env.DATABASE_URL?.trim()) {
  throw new Error('DATABASE_URL 未配置，无法迁移旧上传元数据。')
}

const confirm = arguments_.has('--confirm')
const runtimeRoot = resolveRuntimeRoot(repositoryRoot, process.env.RUNTIME_ROOT)
const uploadsRoot = path.resolve(runtimeRoot, 'uploads', 'files')
const objectRoot = path.resolve(runtimeRoot, 'objects', 'sha256')
const archiveRoot = path.resolve(runtimeRoot, 'migration-archive', 'file-idempotency')
const scan = await scanRuntimeMetadata(uploadsRoot)
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })

await client.connect()
try {
  await assertFileLifecycleTable(client)
  const ownership = await loadThreadOwnership(client, [...new Set(scan.files.map(file => file.threadId))])
  const candidates = await validateCandidates(scan.files, ownership, runtimeRoot, objectRoot)
  assignLifecycleStatus(candidates)
  assignRequestIds(candidates, scan.requestIdsByFileId)
  await validateExistingFacts(client, candidates)
  assertOneReadyVersionPerSource(candidates)

  const summary = summarize(candidates, scan.idempotencyDirectories)
  process.stdout.write(`${JSON.stringify({ mode: confirm ? 'confirm' : 'dry-run', runtimeRoot, ...summary }, null, 2)}\n`)
  if (!confirm) {
    process.stdout.write('Dry-run 通过；确认以上数量和运行目录后，使用 --confirm 执行迁移。\n')
  } else {
    await insertCandidates(client, candidates)
    await archiveIdempotencyDirectories(scan.idempotencyDirectories, uploadsRoot, archiveRoot)
    process.stdout.write('旧上传元数据迁移完成；PostgreSQL 现为文件生命周期事实源。\n')
  }
} finally {
  await client.end()
}

function resolveRuntimeRoot(root, configured) {
  const value = configured?.trim() || 'runtime'
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value)
}

async function scanRuntimeMetadata(uploadsDirectory) {
  const files = []
  const requestIdsByFileId = new Map()
  const idempotencyDirectories = []
  for (const scope of await listDirectories(uploadsDirectory)) {
    if (!isIdentifier(scope)) throw new Error(`上传线程目录不是合法标识符：${scope}`)
    const scopeDirectory = path.join(uploadsDirectory, scope)
    const idempotencyDirectory = path.join(scopeDirectory, '_idempotency')
    const idempotencyFiles = await listJsonFiles(idempotencyDirectory)
    if (idempotencyFiles.length > 0) idempotencyDirectories.push({ threadId: scope, path: idempotencyDirectory })
    for (const fileName of idempotencyFiles) {
      const record = parseIdempotencyRecord(await readJson(path.join(idempotencyDirectory, fileName)), fileName)
      if (record.requestId !== path.basename(fileName, '.json')) {
        throw new Error(`幂等记录文件名与 requestId 不一致：${fileName}`)
      }
      const mappings = requestIdsByFileId.get(record.fileId) ?? []
      mappings.push(record)
      requestIdsByFileId.set(record.fileId, mappings)
    }
    for (const fileId of (await listDirectories(scopeDirectory)).filter(name => name !== '_idempotency')) {
      if (!isIdentifier(fileId)) throw new Error(`上传文件目录不是合法标识符：${scope}/${fileId}`)
      const metadataPath = path.join(scopeDirectory, fileId, 'metadata.json')
      const metadata = parseMetadata(await readJson(metadataPath), metadataPath)
      if (metadata.id !== fileId || metadata.threadId !== scope) {
        throw new Error(`上传 metadata 的目录身份不一致：${metadataPath}`)
      }
      files.push(metadata)
    }
  }
  return { files, requestIdsByFileId, idempotencyDirectories }
}

async function loadThreadOwnership(client_, threadIds) {
  if (threadIds.length === 0) return new Map()
  const result = await client_.query(`
    SELECT thread_id, session_id, workspace_id, created_by_user_id
    FROM platform_threads
    WHERE thread_id = ANY($1::text[])
  `, [threadIds])
  const ownership = new Map(result.rows.map(row => [String(row.thread_id), {
    sessionId: String(row.session_id),
    workspaceId: nullableString(row.workspace_id),
    createdByUserId: nullableString(row.created_by_user_id),
  }]))
  const missing = threadIds.filter(threadId => !ownership.has(threadId))
  if (missing.length > 0) {
    throw new Error(`以下旧上传所属线程不在 PostgreSQL 中：${missing.join('、')}。请先恢复线程事实或人工处置这些文件。`)
  }
  return ownership
}

async function validateCandidates(files, ownership, runtimeDirectory, objectDirectory) {
  if (files.length === 0) return []
  const canonicalObjectRoot = await realpath(objectDirectory)
  const candidates = []
  for (const file of files) {
    const owner = ownership.get(file.threadId)
    if (!owner) throw new Error(`线程 '${file.threadId}' 缺少资源归属。`)
    if (path.isAbsolute(file.relativePath)) throw new Error(`文件 '${file.id}' 的对象路径必须是相对路径。`)
    const objectPath = path.resolve(runtimeDirectory, file.relativePath)
    if (!isWithin(objectDirectory, objectPath)) throw new Error(`文件 '${file.id}' 的对象路径越出 objects/sha256。`)
    const canonicalObjectPath = await realpath(objectPath)
    if (!isWithin(canonicalObjectRoot, canonicalObjectPath)) throw new Error(`文件 '${file.id}' 的对象链接越出 objects/sha256。`)
    const info = await stat(canonicalObjectPath)
    if (!info.isFile()) throw new Error(`文件 '${file.id}' 的对象路径不是普通文件。`)
    if (info.size !== file.sizeBytes) throw new Error(`文件 '${file.id}' 的对象大小与 metadata 不一致。`)
    const actualHash = await hashFile(canonicalObjectPath)
    if (actualHash !== file.contentHash) throw new Error(`文件 '${file.id}' 的对象 SHA256 与 metadata 不一致。`)
    candidates.push({
      ...file,
      ...owner,
      sourceKey: file.sourceRelativePath ?? file.name,
      status: 'ready',
      requestId: null,
    })
  }
  return candidates
}

function assignLifecycleStatus(candidates) {
  const groups = new Map()
  for (const candidate of candidates) {
    const key = `${candidate.threadId}\u0000${candidate.sourceKey}`
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    group.sort((left, right) => (
      right.uploadedAt.localeCompare(left.uploadedAt) || right.id.localeCompare(left.id)
    ))
    for (const candidate of group.slice(1)) candidate.status = 'deleted'
  }
}

function assignRequestIds(candidates, requestIdsByFileId) {
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]))
  const seen = new Set()
  for (const [fileId, records] of requestIdsByFileId) {
    const candidate = byId.get(fileId)
    if (!candidate) throw new Error(`幂等记录指向不存在的 metadata：${fileId}`)
    const matching = records.filter(record => (
      record.name === candidate.name
      && record.sourceKey === candidate.sourceKey
      && record.sizeBytes === candidate.sizeBytes
      && record.contentHash === candidate.contentHash
    ))
    if (matching.length !== records.length) {
      throw new Error(`文件 '${fileId}' 存在已经失效的旧幂等记录；请人工核对后移走对应 _idempotency 目录。`)
    }
    if (matching.length > 1) {
      throw new Error(`文件 '${fileId}' 对应多个旧 requestId，无法无损映射到当前唯一请求事实。`)
    }
    const requestId = matching[0]?.requestId ?? null
    if (requestId) {
      const key = `${candidate.threadId}\u0000${requestId}`
      if (seen.has(key)) throw new Error(`线程 '${candidate.threadId}' 的 requestId '${requestId}' 重复。`)
      seen.add(key)
      candidate.requestId = requestId
    }
  }
}

async function validateExistingFacts(client_, candidates) {
  if (candidates.length === 0) return
  const result = await client_.query(`
    SELECT file_id, workspace_id, session_id, thread_id, created_by_user_id,
      name, source_key, source_relative_path, relative_path, content_hash,
      size_bytes, media_type, request_id, status
    FROM platform_file_objects
    WHERE file_id = ANY($1::text[])
       OR (thread_id, source_key) IN (
         SELECT * FROM UNNEST($2::text[], $3::text[])
       )
       OR (thread_id, request_id) IN (
         SELECT * FROM UNNEST($4::text[], $5::text[])
       )
  `, [
    candidates.map(candidate => candidate.id),
    candidates.map(candidate => candidate.threadId),
    candidates.map(candidate => candidate.sourceKey),
    candidates.filter(candidate => candidate.requestId).map(candidate => candidate.threadId),
    candidates.filter(candidate => candidate.requestId).map(candidate => candidate.requestId),
  ])
  const candidatesById = new Map(candidates.map(candidate => [candidate.id, candidate]))
  for (const row of result.rows) {
    const candidate = candidatesById.get(String(row.file_id))
    if (!candidate) {
      throw new Error(`数据库已存在冲突的文件事实 '${String(row.file_id)}'；迁移未修改任何数据。`)
    }
    const same = nullableString(row.workspace_id) === candidate.workspaceId
      && String(row.session_id) === candidate.sessionId
      && String(row.thread_id) === candidate.threadId
      && nullableString(row.created_by_user_id) === candidate.createdByUserId
      && String(row.name) === candidate.name
      && String(row.source_key) === candidate.sourceKey
      && nullableString(row.source_relative_path) === candidate.sourceRelativePath
      && String(row.relative_path) === candidate.relativePath
      && String(row.content_hash) === candidate.contentHash
      && Number(row.size_bytes) === candidate.sizeBytes
      && String(row.media_type) === candidate.mediaType
      && (candidate.requestId === null || nullableString(row.request_id) === candidate.requestId)
      && String(row.status) === candidate.status
    if (!same) throw new Error(`数据库中的文件事实 '${candidate.id}' 与旧 metadata 不一致；迁移未修改任何数据。`)
    candidate.requestId = nullableString(row.request_id)
    candidate.alreadyMigrated = true
    candidate.status = String(row.status)
  }
}

function assertOneReadyVersionPerSource(candidates) {
  const readySources = new Set()
  for (const candidate of candidates) {
    if (candidate.status !== 'ready') continue
    const key = `${candidate.threadId}\u0000${candidate.sourceKey}`
    if (readySources.has(key)) {
      throw new Error(
        `线程 '${candidate.threadId}' 的来源 '${candidate.sourceKey}' 同时存在多个 ready 事实；迁移未修改任何数据。`,
      )
    }
    readySources.add(key)
  }
}

async function insertCandidates(client_, candidates) {
  const pending = candidates.filter(candidate => !candidate.alreadyMigrated)
  if (pending.length === 0) return
  await client_.query('BEGIN')
  try {
    for (const candidate of pending) {
      await client_.query(`
        INSERT INTO platform_file_objects (
          file_id, workspace_id, session_id, thread_id, created_by_user_id,
          name, source_key, source_relative_path, relative_path, content_hash,
          size_bytes, media_type, request_id, status, error_message,
          created_at, ready_at, deleted_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, NULL,
          $15::timestamptz,
          CASE WHEN $14 = 'ready' THEN $15::timestamptz ELSE NULL END,
          CASE WHEN $14 = 'deleted' THEN $15::timestamptz ELSE NULL END,
          $15::timestamptz
        )
      `, [
        candidate.id,
        candidate.workspaceId,
        candidate.sessionId,
        candidate.threadId,
        candidate.createdByUserId,
        candidate.name,
        candidate.sourceKey,
        candidate.sourceRelativePath,
        candidate.relativePath,
        candidate.contentHash,
        candidate.sizeBytes,
        candidate.mediaType,
        candidate.requestId,
        candidate.status,
        candidate.uploadedAt,
      ])
    }
    await client_.query('COMMIT')
  } catch (error) {
    await client_.query('ROLLBACK')
    throw error
  }
}

async function archiveIdempotencyDirectories(directories, uploadsDirectory, archiveDirectory) {
  for (const entry of directories) {
    const source = path.resolve(entry.path)
    const target = path.resolve(archiveDirectory, entry.threadId)
    if (!isWithin(uploadsDirectory, source) || !isWithin(archiveDirectory, target)) {
      throw new Error(`拒绝移动越界的旧幂等目录：${source}`)
    }
    await mkdir(path.dirname(target), { recursive: true })
    if (await pathExists(target)) {
      throw new Error(`旧幂等记录归档目标已存在：${target}。请人工合并后重试。`)
    }
    await rename(source, target)
  }
}

async function assertFileLifecycleTable(client_) {
  const result = await client_.query("SELECT to_regclass('public.platform_file_objects') AS table_name")
  if (!result.rows[0]?.table_name) {
    throw new Error('数据库缺少 platform_file_objects；请使用空数据库执行 infra/database/schema.sql。')
  }
}

function summarize(candidates, idempotencyDirectories) {
  return {
    metadataFiles: candidates.length,
    readyRecords: candidates.filter(candidate => candidate.status === 'ready' && !candidate.alreadyMigrated).length,
    retiredRecords: candidates.filter(candidate => candidate.status === 'deleted' && !candidate.alreadyMigrated).length,
    alreadyMigrated: candidates.filter(candidate => candidate.alreadyMigrated).length,
    idempotencyDirectoriesToArchive: idempotencyDirectories.length,
  }
}

function parseMetadata(value, source) {
  if (!isRecord(value)) throw new Error(`上传 metadata 不是对象：${source}`)
  const metadata = {
    id: requiredIdentifier(value.id, `${source}.id`),
    name: requiredString(value.name, `${source}.name`),
    sourceRelativePath: nullableMetadataString(value.sourceRelativePath, `${source}.sourceRelativePath`),
    sizeBytes: requiredNonnegativeInteger(value.sizeBytes, `${source}.sizeBytes`),
    uploadedAt: requiredTimestamp(value.uploadedAt, `${source}.uploadedAt`),
    threadId: requiredIdentifier(value.threadId, `${source}.threadId`),
    relativePath: requiredString(value.relativePath, `${source}.relativePath`),
    contentHash: requiredHash(value.contentHash, `${source}.contentHash`),
    mediaType: requiredString(value.mediaType, `${source}.mediaType`),
  }
  if (value.status !== 'ready') throw new Error(`旧上传 metadata '${metadata.id}' 的状态不是 ready。`)
  return metadata
}

function parseIdempotencyRecord(value, source) {
  if (!isRecord(value)) throw new Error(`上传幂等记录不是对象：${source}`)
  return {
    requestId: requiredRequestId(value.requestId, `${source}.requestId`),
    fileId: requiredIdentifier(value.fileId, `${source}.fileId`),
    name: requiredString(value.name, `${source}.name`),
    sourceKey: requiredString(value.sourceKey, `${source}.sourceKey`),
    sizeBytes: requiredNonnegativeInteger(value.sizeBytes, `${source}.sizeBytes`),
    contentHash: requiredHash(value.contentHash, `${source}.contentHash`),
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取合法 JSON：${filePath}`, { cause: error })
  }
}

async function listDirectories(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function listJsonFiles(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name)
      .sort()
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function pathExists(candidate) {
  try {
    await stat(candidate)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function hashFile(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

function requiredIdentifier(value, field) {
  const text = requiredString(value, field)
  if (!isIdentifier(text)) throw new Error(`${field} 不是合法标识符。`)
  return text
}

function requiredRequestId(value, field) {
  const requestId = requiredIdentifier(value, field)
  if (requestId.length > 200) throw new Error(`${field} 不能超过 200 个字符。`)
  return requestId
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串。`)
  return value
}

function requiredNonnegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new Error(`${field} 必须是 PostgreSQL INTEGER 范围内的非负整数。`)
  }
  return value
}

function requiredTimestamp(value, field) {
  const text = requiredString(value, field)
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${field} 不是合法时间戳。`)
  return text
}

function requiredHash(value, field) {
  const text = requiredString(value, field)
  if (!/^[a-f0-9]{64}$/u.test(text)) throw new Error(`${field} 不是合法 SHA256。`)
  return text
}

function nullableString(value) {
  return typeof value === 'string' ? value : null
}

function nullableMetadataString(value, field) {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是 null 或非空字符串。`)
  return value
}

function isIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

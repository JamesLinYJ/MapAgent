// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行时数据完整性检查测试
//
//   文件:       runtimeIntegrityChecker.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  RuntimeIntegrityChecker,
  type RuntimeIntegrityCatalog,
} from './runtimeIntegrityChecker.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('RuntimeIntegrityChecker', () => {
  it('接受存在且哈希正确的对象、Artifact 与上传元数据', async () => {
    const root = await createRoot()
    const content = Buffer.from('checkpoint')
    const hash = createHash('sha256').update(content).digest('hex')
    const objectPath = path.join(root, 'objects', 'sha256', hash.slice(0, 2), hash)
    const uploadedContent = Buffer.from('netcdf-content')
    const uploadedHash = createHash('sha256').update(uploadedContent).digest('hex')
    const uploadedRelativePath = `objects/sha256/${uploadedHash.slice(0, 2)}/${uploadedHash}.nc`
    const uploadedPath = path.join(root, ...uploadedRelativePath.split('/'))
    const artifactPath = path.join(root, 'artifacts', 'report.txt')
    await mkdir(path.dirname(objectPath), { recursive: true })
    await mkdir(path.dirname(uploadedPath), { recursive: true })
    await mkdir(path.dirname(artifactPath), { recursive: true })
    await writeFile(objectPath, content)
    await writeFile(uploadedPath, uploadedContent)
    await writeFile(artifactPath, 'report')
    const runtimeFiles = {
      verifyIntegrity: vi.fn().mockResolvedValue({
        files: 1,
        projections: [{ fileId: 'file_1', threadId: 'thread_1' }],
      }),
    }

    await expect(new RuntimeIntegrityChecker(catalog(
      [{ object_hash: hash, source: 'run:run_1' }],
      [{
        content_hash: uploadedHash,
        content_relative_path: uploadedRelativePath,
        size_bytes: uploadedContent.byteLength,
        source: 'file:file_1',
      }],
      [{ file_id: 'file_1', thread_id: 'thread_1', status: 'ready' }],
      [{ artifact_id: 'artifact_1', content_relative_path: 'artifacts/report.txt' }],
    ), runtimeFiles, root).verify()).resolves.toBeUndefined()
    expect(runtimeFiles.verifyIntegrity).toHaveBeenCalledOnce()
  })

  it('对缺失对象和越界 Artifact 硬失败且不执行修复', async () => {
    const root = await createRoot()
    const missingHash = 'a'.repeat(64)
    const runtimeFiles = { verifyIntegrity: vi.fn().mockResolvedValue({ files: 0, projections: [] }) }

    await expect(new RuntimeIntegrityChecker(catalog(
      [{ object_hash: missingHash, source: 'run:run_1' }],
      [],
      [],
      [{ artifact_id: 'artifact_1', content_relative_path: '../outside.txt' }],
    ), runtimeFiles, root).verify()).rejects.toThrow(/共 2 项.*从备份恢复/su)
  })

  it('传播上传元数据或内容损坏', async () => {
    const root = await createRoot()
    const runtimeFiles = {
      verifyIntegrity: vi.fn().mockRejectedValue(new Error('文件元数据 file_1 缺少内容对象')),
    }

    await expect(new RuntimeIntegrityChecker(catalog([], [], [], []), runtimeFiles, root).verify())
      .rejects.toThrow(/runtime-upload.*缺少内容对象/su)
  })

  it('对没有数据库记录的旧 runtime metadata 硬失败并要求显式迁移', async () => {
    const root = await createRoot()
    const runtimeFiles = {
      verifyIntegrity: vi.fn().mockResolvedValue({
        files: 1,
        projections: [{ fileId: 'legacy_file', threadId: 'thread_1' }],
      }),
    }

    await expect(new RuntimeIntegrityChecker(catalog([], [], [], []), runtimeFiles, root).verify())
      .rejects.toThrow(/legacy_file.*migrate:file-lifecycle.*--confirm.*不会自动导入.*fallback/su)
  })

  it('对数据库 ready 但缺少物理 metadata 的文件硬失败', async () => {
    const root = await createRoot()
    const runtimeFiles = {
      verifyIntegrity: vi.fn().mockResolvedValue({ files: 0, projections: [] }),
    }

    await expect(new RuntimeIntegrityChecker(catalog(
      [],
      [],
      [{ file_id: 'file_1', thread_id: 'thread_1', status: 'ready' }],
      [],
    ), runtimeFiles, root).verify())
      .rejects.toThrow(/file:file_1.*ready.*缺少物理 metadata/su)
  })

  it('按带扩展名的精确路径校验气象数据内容哈希', async () => {
    const root = await createRoot()
    const expected = Buffer.from('expected')
    const hash = createHash('sha256').update(expected).digest('hex')
    const relativePath = `objects/sha256/${hash.slice(0, 2)}/${hash}.nc`
    const objectPath = path.join(root, ...relativePath.split('/'))
    await mkdir(path.dirname(objectPath), { recursive: true })
    await writeFile(objectPath, Buffer.from('tampered'))

    await expect(new RuntimeIntegrityChecker(catalog([], [{
      content_hash: hash,
      content_relative_path: relativePath,
      size_bytes: expected.byteLength,
      source: 'meteorological-dataset:dataset_1',
    }], [], []), {
      verifyIntegrity: vi.fn().mockResolvedValue({ files: 0, projections: [] }),
    }, root).verify()).rejects.toThrow(/meteorological-dataset:dataset_1.*哈希/su)
  })
})

function catalog(
  objects: Awaited<ReturnType<RuntimeIntegrityCatalog['listObjectReferences']>>,
  fileContents: Awaited<ReturnType<RuntimeIntegrityCatalog['listFileContentReferences']>>,
  fileProjections: Awaited<ReturnType<RuntimeIntegrityCatalog['listFileProjections']>>,
  artifacts: Awaited<ReturnType<RuntimeIntegrityCatalog['listArtifactReferences']>>,
): RuntimeIntegrityCatalog {
  return {
    listObjectReferences: vi.fn().mockResolvedValue(objects),
    listFileContentReferences: vi.fn().mockResolvedValue(fileContents),
    listFileProjections: vi.fn().mockResolvedValue(fileProjections),
    listArtifactReferences: vi.fn().mockResolvedValue(artifacts),
  }
}

async function createRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-integrity-')))
  roots.push(root)
  return root
}

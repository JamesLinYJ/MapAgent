// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 资源存储
//
//   文件:       artifactStore.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import type { ArtifactRef } from '../schemas/types.js'
import { nowUtc } from '../utils/ids.js'
import type { ConversationProjectionIndex } from './conversationProjectionIndex.js'
import type {
  ArtifactAvailability,
  ArtifactRecord,
  ArtifactRepository,
  VisibleArtifactResource,
} from './postgres/artifactRepository.js'

const RESOURCE_ID = /^[a-zA-Z0-9_-]+$/u

export interface VisibleArtifactOptions {
  artifactIds?: readonly string[]
  limit?: number
}

// Artifact 元数据、归属与线程导航投影都由 PostgreSQL 原子持久化；文件系统
// 只保存 metadata.relativePath 指向的内容，不再维护 artifacts.jsonl 第二事实源。
export class ArtifactStore {
  constructor(
    private readonly index: ConversationProjectionIndex,
    private readonly artifactRepository: ArtifactRepository,
    private readonly runtimeRoot: string,
  ) {}

  async persist(artifact: ArtifactRef): Promise<void> {
    this.requireRelativePath(artifact)
    const owner = this.index.getRun(artifact.runId)
    await this.artifactRepository.persistArtifact(artifact, {
      workspaceId: owner.workspaceId,
      createdByUserId: owner.createdByUserId,
      visibility: owner.visibility,
      threadId: owner.threadId,
      runCreatedAt: owner.createdAt,
    })
    if (artifact.isIntermediate) return
    const thread = this.index.getThreadOrNull(owner.threadId)
    if (!thread) return
    const next = {
      ...thread,
      latestArtifactId: artifact.artifactId,
      latestArtifactName: artifact.name,
      updatedAt: nowUtc(),
    }
    this.index.setThread(next)
  }

  /**
   * 以当前 run 的线程、工作区和创建时间为授权边界解析可见 Artifact。
   * 调用方不能自行拼接所有权条件；PostgreSQL 元数据和实际内容文件必须同时存在。
   */
  async listVisibleToRun(
    runId: string,
    options: VisibleArtifactOptions = {},
  ): Promise<VisibleArtifactResource[]> {
    const run = this.index.getRun(runId)
    if (!run.threadId) throw new Error(`运行 '${runId}' 尚未归属线程，不能解析线程 Artifact。`)
    const records = await this.artifactRepository.listVisibleArtifacts({
      threadId: run.threadId,
      workspaceId: run.workspaceId,
      visibleAt: run.createdAt,
      ...(options.artifactIds ? { artifactIds: options.artifactIds } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    })
    const canonicalRoot = await realpath(path.resolve(this.runtimeRoot))
    return Promise.all(records.map(record => resolveVisibleArtifact(canonicalRoot, record)))
  }

  private requireRelativePath(artifact: ArtifactRef): string {
    const relativePath = typeof artifact.metadata.relativePath === 'string' ? artifact.metadata.relativePath : ''
    if (!relativePath) throw new Error(`Artifact "${artifact.artifactId}" 缺少 relativePath`)
    if (path.isAbsolute(relativePath)) {
      throw new Error(`Artifact "${artifact.artifactId}" 的 relativePath 必须是运行目录内的相对路径`)
    }
    const root = path.resolve(this.runtimeRoot)
    const candidate = path.resolve(root, relativePath)
    if (!isWithinRoot(root, candidate)) {
      throw new Error(`Artifact "${artifact.artifactId}" 的 relativePath 越出运行目录`)
    }
    return relativePath
  }
}

async function resolveVisibleArtifact(
  canonicalRoot: string,
  record: ArtifactRecord,
): Promise<VisibleArtifactResource> {
  const sandboxPath = buildSandboxPath(record)
  if (!sandboxPath) {
    return unavailableArtifact(record, 'invalid', 'Artifact 标识不符合沙箱路径约束。')
  }
  const candidate = path.resolve(canonicalRoot, record.relativePath)
  if (!isWithinRoot(canonicalRoot, candidate)) {
    return unavailableArtifact(record, 'invalid', 'Artifact 内容路径越出运行目录。', sandboxPath)
  }
  try {
    const canonicalSource = await realpath(candidate)
    if (!isWithinRoot(canonicalRoot, canonicalSource)) {
      return unavailableArtifact(record, 'invalid', 'Artifact 内容链接越出运行目录。', sandboxPath)
    }
    const info = await stat(canonicalSource)
    if (!info.isFile()) {
      return unavailableArtifact(record, 'invalid', 'Artifact 内容不是普通文件。', sandboxPath)
    }
    return {
      ...record,
      availability: 'available',
      unavailableReason: null,
      sandboxPath,
      sourcePath: canonicalSource,
    }
  } catch (error) {
    const code = filesystemErrorCode(error)
    if (code === 'ENOENT') {
      return unavailableArtifact(record, 'missing', 'Artifact 元数据存在，但内容文件已缺失。', sandboxPath)
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return unavailableArtifact(record, 'inaccessible', 'Artifact 内容文件当前不可读取。', sandboxPath)
    }
    throw error
  }
}

function buildSandboxPath(record: ArtifactRecord): string | null {
  if (!RESOURCE_ID.test(record.runId) || !RESOURCE_ID.test(record.artifactId)) return null
  const extension = path.extname(record.relativePath)
  if (extension.length > 16 || !/^(?:\.[a-zA-Z0-9]+)?$/u.test(extension)) return null
  return path.posix.join('artifacts', record.runId, `${record.artifactId}${extension.toLowerCase()}`)
}

function unavailableArtifact(
  record: ArtifactRecord,
  availability: Exclude<ArtifactAvailability, 'available'>,
  unavailableReason: string,
  sandboxPath = '',
): VisibleArtifactResource {
  return {
    ...record,
    availability,
    unavailableReason,
    sandboxPath,
    sourcePath: null,
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function filesystemErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

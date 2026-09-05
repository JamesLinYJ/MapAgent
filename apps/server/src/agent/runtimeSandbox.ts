// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 沙箱边界
//
//   文件:       runtimeSandbox.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 负责构造单次 run 的 sandbox manifest，并选择 SDK 原生 Unix 本地沙箱。
// Windows 不具备 SDK 官方支持的原生本地后端，因此默认禁用，不能伪装成可用能力。

import {
  dir,
  localBindMountStrategy,
  Manifest,
  mount,
  type SandboxClient,
  type SandboxPathGrantInit,
  type SandboxRunConfig,
} from '@openai/agents/sandbox'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  DockerSandboxClient,
  UnixLocalSandboxClient,
} from '@openai/agents/sandbox/local'
import type { RuntimeSandboxConfig } from '../schemas/types.js'

export type SandboxClientFactory = (config: RuntimeSandboxConfig) => SandboxClient

export interface SandboxBackendFactories {
  unixLocal(): SandboxClient
  docker(options: { networkMode: 'none' }): SandboxClient
}

export interface SandboxArtifactMount {
  artifactId: string
  runId: string
  sourcePath: string
  sandboxPath: string
}

export interface RuntimeSandboxResources {
  artifactDirectory?: string
  artifactMounts?: readonly SandboxArtifactMount[]
}

export function buildSandboxManifest(
  options: { runId: string; sessionId: string },
  threadId: string,
  extraPathGrants: SandboxPathGrantInit[] = [],
  resources: RuntimeSandboxResources = {},
): Manifest {
  const artifactEntries = buildArtifactEntries(options.runId, resources)
  return new Manifest({
    extraPathGrants,
    entries: {
      'README.md': {
        type: 'file',
        content: `# 智能体沙箱

本工作区由平台运行时为单次智能体运行创建。

- runId: ${options.runId}
- threadId: ${threadId}
- sessionId: ${options.sessionId}

文件、shell 和 patch 操作必须在这个 sandbox 工作区内完成。平台运行时数据、上传文件和气象数据集只能通过已注册工具访问，不要猜测宿主机路径。

当前运行和同一线程中已授权的历史 Artifact 只会按资源索引给出的 \`artifacts/<runId>/<artifactId>.<ext>\` 路径只读挂载；未列出的宿主机文件不可访问。
`,
      },
      ...artifactEntries,
    },
  })
}

function buildArtifactEntries(
  currentRunId: string,
  resources: RuntimeSandboxResources,
): Record<string, ReturnType<typeof dir>> {
  const children: Record<string, ReturnType<typeof dir> | ReturnType<typeof mount>> = {}
  if (resources.artifactDirectory) {
    assertResourceId(currentRunId, '当前运行 ID')
    children[currentRunId] = mount({
      source: path.resolve(resources.artifactDirectory),
      readOnly: true,
      mountStrategy: localBindMountStrategy(),
      description: '当前运行的 Artifact 输出目录。',
    })
  }

  const historicalRuns = new Map<string, Record<string, ReturnType<typeof mount>>>()
  for (const artifact of resources.artifactMounts ?? []) {
    if (artifact.runId === currentRunId) continue
    assertResourceId(artifact.runId, 'Artifact 所属运行 ID')
    assertResourceId(artifact.artifactId, 'Artifact ID')
    const segments = artifact.sandboxPath.split('/')
    const filename = segments[2]
    if (
      segments.length !== 3
      || segments[0] !== 'artifacts'
      || segments[1] !== artifact.runId
      || !filename
      || path.posix.parse(filename).name !== artifact.artifactId
    ) {
      throw new Error(`Artifact '${artifact.artifactId}' 的沙箱路径不符合规范。`)
    }
    const runChildren = historicalRuns.get(artifact.runId) ?? {}
    const existing = runChildren[filename]
    const sourcePath = path.resolve(artifact.sourcePath)
    if (existing && existing.source !== sourcePath) {
      throw new Error(`Artifact 沙箱路径 '${artifact.sandboxPath}' 发生冲突。`)
    }
    runChildren[filename] = mount({
      source: sourcePath,
      readOnly: true,
      mountStrategy: localBindMountStrategy(),
      description: `线程历史 Artifact ${artifact.artifactId}。`,
    })
    historicalRuns.set(artifact.runId, runChildren)
  }
  for (const [runId, runChildren] of historicalRuns) {
    children[runId] = dir({
      description: '当前线程已授权的历史 Artifact。',
      children: runChildren,
    })
  }
  return Object.keys(children).length
    ? {
        artifacts: dir({
          description: '当前运行与当前线程已授权的只读 Artifact。',
          children,
        }),
      }
    : {}
}

function assertResourceId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) throw new Error(`${label} 不符合沙箱路径约束。`)
}

export async function prepareRunArtifactDirectory(runtimeRoot: string, runId: string): Promise<string> {
  const root = path.resolve(runtimeRoot)
  const artifactDirectory = path.resolve(root, 'artifacts', runId)
  if (!artifactDirectory.startsWith(`${root}${path.sep}`)) {
    throw new Error('当前运行 Artifact 目录越出 runtime 根目录')
  }
  await mkdir(artifactDirectory, { recursive: true })
  return artifactDirectory
}

export function createConfiguredSandboxClient(
  config: RuntimeSandboxConfig,
  factories: SandboxBackendFactories = DEFAULT_SANDBOX_BACKEND_FACTORIES,
  platform: NodeJS.Platform = process.platform,
): SandboxClient {
  if (config.backend === 'unix_local') {
    if (!isSandboxBackendAvailable(config, platform)) {
      throw new Error('Windows 不支持 OpenAI Agents SDK 的 Unix 本地沙箱；请选择 sdk_docker 或禁用沙箱能力。')
    }
    return factories.unixLocal()
  }
  if (config.backend === 'sdk_docker') {
    return factories.docker({ networkMode: 'none' })
  }
  throw new Error('当前运行已禁用 SDK 沙箱，不能创建沙箱客户端。')
}

export function isSandboxBackendAvailable(
  config: RuntimeSandboxConfig,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (config.backend === 'disabled') return false
  if (config.backend === 'unix_local') return platform !== 'win32'
  return config.backend === 'sdk_docker'
}

export function buildSandboxRunConfig(
  manifest: Manifest,
  config: RuntimeSandboxConfig,
  factory: SandboxClientFactory = createConfiguredSandboxClient,
): SandboxRunConfig {
  if (config.backend === 'disabled') {
    throw new Error('当前运行已禁用 SDK 沙箱，不能构造沙箱运行配置。')
  }
  const client = factory(config)
  const expectedBackend = config.backend === 'sdk_docker' ? 'docker' : config.backend
  if (client.backendId !== expectedBackend) {
    throw new Error(`Sandbox client backend '${client.backendId}' 与运行配置 '${config.backend}' 不匹配`)
  }
  return { client, manifest }
}

const DEFAULT_SANDBOX_BACKEND_FACTORIES: SandboxBackendFactories = {
  unixLocal: () => new UnixLocalSandboxClient(),
  docker: options => new DockerSandboxClient(options),
}

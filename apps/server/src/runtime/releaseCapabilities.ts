// +-------------------------------------------------------------------------
//
//   地理智能平台 - 服务发布能力清单
//
//   文件:       releaseCapabilities.ts
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  API_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION,
  runtimeCapabilitiesSchema,
  type RuntimeCapabilities,
} from '@geo-agent-platform/shared-types/release'
import { DATABASE_SCHEMA_CONTRACT_VERSION } from '../db/schemaContract.js'

const packageVersion = readServerPackageVersion()
const runtimeManifestFileName = 'runtime-service-manifest.json'
const runtimeManifestKind = 'geo-agent-runtime-service'

/**
 * 发布 ID 优先来自显式环境配置，其次来自部署根的制品 manifest。
 * 只有 manifest 确实不存在时才认定当前运行于开发工作树。
 */
export function resolveReleaseId(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.GEO_AGENT_PLATFORM_RELEASE_ID !== undefined) {
    const configured = environment.GEO_AGENT_PLATFORM_RELEASE_ID.trim()
    assertReleaseId(configured, 'GEO_AGENT_PLATFORM_RELEASE_ID')
    return configured
  }

  const configuredRoot = environment.GEO_AGENT_PLATFORM_ROOT
  if (configuredRoot !== undefined && !configuredRoot.trim()) {
    throw new Error('GEO_AGENT_PLATFORM_ROOT 不能为空。')
  }
  const deploymentRoot = path.resolve(configuredRoot?.trim() || process.cwd())
  const manifestPath = path.join(deploymentRoot, runtimeManifestFileName)
  let manifestSource: string
  try {
    manifestSource = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return `geo-agent-platform@${packageVersion}+workspace`
    }
    throw error
  }

  const manifest: unknown = JSON.parse(manifestSource)
  if (typeof manifest !== 'object'
    || manifest === null
    || Array.isArray(manifest)
    || !('schemaVersion' in manifest)
    || manifest.schemaVersion !== 1
    || !('kind' in manifest)
    || manifest.kind !== runtimeManifestKind
    || !('releaseId' in manifest)) {
    throw new Error(`Runtime Service manifest 格式无效：${manifestPath}`)
  }
  assertReleaseId(manifest.releaseId, `Runtime Service manifest ${manifestPath}`)
  if (manifest.releaseId !== manifest.releaseId.trim()) {
    throw new Error(`Runtime Service manifest releaseId 不得包含首尾空白：${manifestPath}`)
  }
  return manifest.releaseId
}

export function buildRuntimeCapabilities(input: {
  workerContractDigest: string | null
  environment?: NodeJS.ProcessEnv
}): RuntimeCapabilities {
  return runtimeCapabilitiesSchema.parse({
    releaseId: resolveReleaseId(input.environment),
    apiProtocolVersion: API_PROTOCOL_VERSION,
    minDesktopProtocol: DESKTOP_PROTOCOL_VERSION,
    maxDesktopProtocol: DESKTOP_PROTOCOL_VERSION,
    databaseSchemaVersion: DATABASE_SCHEMA_CONTRACT_VERSION,
    workerContractDigest: input.workerContractDigest,
  })
}

function readServerPackageVersion(): string {
  const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url))
  const parsed: unknown = JSON.parse(readFileSync(path.resolve(packagePath), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string' || !parsed.version) {
    throw new Error('无法读取 geo-agent-server 发布版本。')
  }
  return parsed.version
}

function assertReleaseId(value: unknown, source: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new Error(`${source} 必须是 1 至 200 个字符的 releaseId。`)
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

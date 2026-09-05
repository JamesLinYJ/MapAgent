// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 运行元数据
//
//   文件:       agentsRuntimeMetadata.ts
//
//   日期:       2026年06月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  AGENTS_SDK_STATE_SCHEMA_VERSION,
  type AgentRuntimeConfig,
} from '../schemas/types.js'
import { agentContextDigest } from '../agent-runtime/step/agentContextDigest.js'

export const SDK_STATE_SCHEMA_VERSION = AGENTS_SDK_STATE_SCHEMA_VERSION
export const SUPPORTED_AGENTS_SDK_VERSION = '0.17.0'

let versionPromise: Promise<string> | null = null

export function agentsSdkVersion(): Promise<string> {
  versionPromise ??= readInstalledVersion()
  return versionPromise
}

export function assertAgentsSdkVersionSupported(version: string): void {
  if (version !== SUPPORTED_AGENTS_SDK_VERSION) {
    throw new Error(
      `不支持的 @openai/agents 版本 '${version}'；要求 '${SUPPORTED_AGENTS_SDK_VERSION}'`,
    )
  }
}

export function runtimeConfigDigest(config: AgentRuntimeConfig): string {
  return agentContextDigest(config)
}

async function readInstalledVersion(): Promise<string> {
  const entryUrl = import.meta.resolve('@openai/agents')
  const packageUrl = new URL('../package.json', entryUrl)
  const parsed = JSON.parse(await readFile(fileURLToPath(packageUrl), 'utf8')) as { version?: unknown }
  if (typeof parsed.version !== 'string' || !parsed.version) throw new Error('无法读取 @openai/agents 安装版本')
  return parsed.version
}

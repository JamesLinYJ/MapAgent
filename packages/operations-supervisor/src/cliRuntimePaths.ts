// +-------------------------------------------------------------------------
//
//   地理智能平台 - 监督器命令行路径投影
//
//   文件:       cliRuntimePaths.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import path from 'node:path'

import type { OperationsProfile } from '@geo-agent-platform/shared-types/operations'

export interface OperationsCliPathArguments {
  root?: string
  runtimeRoot?: string
  tokenFile?: string
  rootSecretFile?: string
}

export interface OperationsCliPathInput {
  projectRoot: string
  profile: OperationsProfile
  runtimeRoot?: string
  tokenFile?: string
  rootSecretFile?: string
}

/**
 * 命令行参数始终覆盖部署环境；部署环境覆盖工作区默认值。这里集中处理
 * systemd、WinSW、交互 CLI 与桌面 Main 必须共享的路径语义。
 */
export function resolveOperationsCliPathInput(input: {
  arguments: OperationsCliPathArguments
  environment: NodeJS.ProcessEnv
  defaultProjectRoot: string
  profile: OperationsProfile
}): OperationsCliPathInput {
  const projectRoot = resolvePath(
    input.arguments.root ?? input.environment.GEO_AGENT_PLATFORM_ROOT ?? input.defaultProjectRoot,
  )
  const runtimeRoot = optionalPath(
    input.arguments.runtimeRoot ?? input.environment.RUNTIME_ROOT,
  )
  const tokenFile = optionalPath(
    input.arguments.tokenFile ?? input.environment.GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE,
  )
  const rootSecretFile = optionalPath(
    input.arguments.rootSecretFile ?? input.environment.GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE,
  )
  return {
    projectRoot,
    profile: input.profile,
    ...(runtimeRoot ? { runtimeRoot } : {}),
    ...(tokenFile ? { tokenFile } : {}),
    ...(rootSecretFile ? { rootSecretFile } : {}),
  }
}

function optionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? resolvePath(trimmed) : undefined
}

function resolvePath(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('监督器路径不能包含控制字符。')
  }
  return path.resolve(value)
}

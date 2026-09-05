// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本地运维台入口
//
//   文件:       localConsoleEntry.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { OperationsClient } from '@geo-agent-platform/operations-supervisor/client'
import { resolveOperationsPaths } from '@geo-agent-platform/operations-supervisor/paths'
import type { OperationsProfile } from '@geo-agent-platform/shared-types/operations'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'
import { config as loadDotEnv } from 'dotenv'

import { LocalOperationsBrokerClient } from './localOperationsBrokerClient.js'
import type { LocalConsoleDataPlane } from './localConsoleTypes.js'
import { prepareTerminalColorEnvironment } from './terminalColorEnvironment.js'

async function main(): Promise<void> {
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
  loadDotEnv({ path: path.join(projectRoot, '.env'), quiet: true })
  prepareTerminalColorEnvironment()
  if (!(await stat(projectRoot)).isDirectory()) {
    throw new Error(`${PRODUCT_CODENAME} 项目根目录不存在。`)
  }
  const profile: OperationsProfile = process.env.NODE_ENV === 'production' ? 'production' : 'development'
  const paths = await resolveOperationsPaths({
    projectRoot,
    profile,
    ...(process.env.RUNTIME_ROOT ? { runtimeRoot: path.resolve(projectRoot, process.env.RUNTIME_ROOT) } : {}),
    ...(process.env.GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE
      ? { tokenFile: path.resolve(projectRoot, process.env.GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE) }
      : {}),
  })
  const connectSupervisor = async (): Promise<OperationsClient> => {
    const token = (await readFile(paths.tokenFile, 'utf8')).trim()
    return OperationsClient.connect({ endpoint: paths.endpoint, token, interactive: true })
  }

  if (process.argv.includes('--check')) {
    const client = await connectSupervisor()
    try {
      await client.status()
      process.stdout.write(`${PRODUCT_CODENAME} 本地运维台与 TypeScript 监督 IPC 已就绪。\n`)
    } finally {
      client.close()
    }
    return
  }

  let broker: LocalOperationsBrokerClient | null = null
  const openDataPlane = async (): Promise<LocalConsoleDataPlane> => {
    broker ??= LocalOperationsBrokerClient.open(projectRoot, 'accounts')
    return broker.accountDataPlane()
  }
  const { runLocalConsole } = await import('./localConsole.js')
  await runLocalConsole({
    connectSupervisor,
    openDataPlane,
    minPasswordLength: readMinimumPasswordLength(),
  })
}

function readMinimumPasswordLength(): number {
  const value = Number(process.env.BETTER_AUTH_MIN_PASSWORD_LENGTH ?? 12)
  return Number.isInteger(value) && value >= 8 && value <= 128 ? value : 12
}

main().catch(error => {
  const message = error instanceof Error ? error.message : '未知错误。'
  process.stderr.write(`${PRODUCT_CODENAME} 本地运维台启动失败：${message}\n`)
  process.exitCode = 1
})

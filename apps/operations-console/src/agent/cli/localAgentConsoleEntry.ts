// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 命令行入口
//
//   文件:       localAgentConsoleEntry.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { config as loadDotEnv } from 'dotenv'
import { z } from 'zod'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

import { LocalOperationsBrokerClient } from '../../localOperationsBrokerClient.js'
import {
  formatLocalAgentCliResult,
  localAgentHelpText,
  parseLocalAgentCli,
  readPipedPrompt,
  runLocalAgentOneShot,
} from './localAgentCli.js'
import { LocalAgentSession } from '../application/localAgentSession.js'
import { LocalAgentClient } from '../transport/localAgentClient.js'
import { prepareTerminalColorEnvironment } from '../../terminalColorEnvironment.js'

const packageSchema = z.object({ version: z.string().min(1) })

async function main(): Promise<void> {
  const options = parseLocalAgentCli(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(localAgentHelpText())
    return
  }

  const projectRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
  loadDotEnv({ path: path.join(projectRoot, '.env'), quiet: true })
  prepareTerminalColorEnvironment()
  if (!(await stat(projectRoot)).isDirectory()) {
    throw new Error(`${PRODUCT_CODENAME} 项目根目录不存在。`)
  }
  const broker = LocalOperationsBrokerClient.open(projectRoot, 'agent')
  const authorization = await broker.waitForAgentAuthorization()
  const headers = new Headers({ cookie: authorization.cookie })
  const session = new LocalAgentSession({
    connectClient: () => LocalAgentClient.connect({
      appBaseUrl: authorization.appBaseUrl,
      origin: authorization.origin,
      headers,
      csrfToken: authorization.csrfToken,
    }),
    executionMode: options.executionMode,
    reasoning: options.reasoning,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.threadId ? { threadId: options.threadId } : {}),
  })

  let outcome: 'allowed' | 'error' = 'allowed'
  let runId: string | null = null
  let threadId: string | null = null
  try {
    const ready = await session.initialize()
    if (options.check) {
      const check = {
        ok: true,
        status: 'ready',
        provider: ready.provider?.provider ?? null,
        model: ready.model,
        workspaceId: ready.bootstrap?.session.workspaceId ?? null,
        connection: ready.connection,
      }
      process.stdout.write(options.json
        ? `${JSON.stringify(check, null, 2)}\n`
        : `${PRODUCT_CODENAME} 本机 Agent 已就绪：${ready.provider?.displayName ?? '未知 Provider'} / ${ready.model ?? '未知模型'}。\n`)
      return
    }

    const prompt = options.prompt ?? await readPipedPrompt()
    if (prompt) {
      const oneShot = await runLocalAgentOneShot(session, prompt, options.timeoutMs)
      runId = oneShot.result.runId
      threadId = oneShot.result.threadId
      process.stdout.write(formatLocalAgentCliResult(oneShot.result, options.json))
      process.exitCode = oneShot.exitCode
      return
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('非交互终端必须通过 --prompt 或标准输入提供问题。')
    }
    const { runLocalAgentConsole } = await import('../ui/localAgentConsole.js')
    await runLocalAgentConsole(session, {
      version: await readProjectVersion(projectRoot),
      projectRoot,
      osUser: authorization.actor.osUser,
      hostname: authorization.actor.hostname,
      keyVersion: authorization.actor.keyVersion,
    })
    runId = session.snapshot().run?.id ?? null
    threadId = session.snapshot().threadId
  } catch (error) {
    outcome = 'error'
    throw error
  } finally {
    const latest = session.snapshot()
    runId ??= latest.run?.id ?? null
    threadId ??= latest.threadId
    session.close()
    await broker.closeAgent({ runId, threadId, outcome })
  }
}

async function readProjectVersion(projectRoot: string): Promise<string> {
  const value: unknown = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  return packageSchema.parse(value).version
}

main().catch(error => {
  const message = error instanceof Error && error.message ? error.message : '未知错误。'
  process.stderr.write(`${PRODUCT_CODENAME} 本机 Agent 启动失败：${message.replace(/[\r\n]+/gu, ' ')}\n`)
  process.exitCode = 1
})

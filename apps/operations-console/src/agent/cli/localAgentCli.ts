// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 命令行契约
//
//   文件:       localAgentCli.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AgentExecutionMode } from '@geo-agent-platform/shared-types'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'
import { z } from 'zod'

import type { LocalAgentSession, LocalAgentSessionSnapshot } from '../application/localAgentSession.js'
import { latestAssistantAnswer } from '../ui/localAgentView.js'

const MAX_STDIN_BYTES = 64 * 1024

export interface LocalAgentCliOptions {
  check: boolean
  help: boolean
  json: boolean
  prompt: string | null
  provider?: string
  model?: string
  threadId?: string
  executionMode: AgentExecutionMode
  reasoning: boolean
  timeoutMs: number
}

export interface LocalAgentCliResult {
  ok: boolean
  status: string
  runId: string | null
  threadId: string | null
  provider: string | null
  model: string | null
  answer: string
  decisions: Array<{
    decisionId: string
    kind: string
    title: string
    question: string
    options: Array<{ optionId: string | null; label: string }>
  }>
  artifacts: Array<{ artifactId: string; name: string; uri: string }>
  errors: string[]
}

export function parseLocalAgentCli(argv: string[]): LocalAgentCliOptions {
  let check = false
  let help = false
  let json = false
  let prompt: string | null = null
  let provider: string | undefined
  let model: string | undefined
  let threadId: string | undefined
  let executionMode: AgentExecutionMode = 'auto'
  let reasoning = true
  let timeoutMs = 10 * 60_000
  const positional: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument) continue
    if (argument === '--check') check = true
    else if (argument === '--help' || argument === '-h') help = true
    else if (argument === '--json') json = true
    else if (argument === '--no-reasoning') reasoning = false
    else if (argument === '--reasoning') reasoning = true
    else if (argument === '--prompt' || argument === '-p') prompt = requiredValue(argv, ++index, argument)
    else if (argument === '--provider') provider = requiredValue(argv, ++index, argument)
    else if (argument === '--model') model = requiredValue(argv, ++index, argument)
    else if (argument === '--thread') threadId = requiredValue(argv, ++index, argument)
    else if (argument === '--mode') {
      const value = requiredValue(argv, ++index, argument)
      if (value !== 'auto' && value !== 'plan') throw new Error('--mode 只允许 auto 或 plan。')
      executionMode = value
    } else if (argument === '--timeout') {
      const seconds = Number(requiredValue(argv, ++index, argument))
      if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3_600) {
        throw new Error('--timeout 必须是 5–3600 秒。')
      }
      timeoutMs = Math.trunc(seconds * 1_000)
    } else if (argument.startsWith('-')) {
      throw new Error(`未知参数 '${argument}'。`)
    } else {
      positional.push(argument)
    }
  }

  if (prompt !== null && positional.length) throw new Error('不能同时使用 --prompt 和位置问题文本。')
  if (positional.length) prompt = positional.join(' ')
  return {
    check,
    help,
    json,
    prompt,
    executionMode,
    reasoning,
    timeoutMs,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(threadId ? { threadId } : {}),
  }
}

export async function readPipedPrompt(): Promise<string | null> {
  if (process.stdin.isTTY) return null
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_STDIN_BYTES) throw new Error('标准输入超过 64 KiB 上限。')
    chunks.push(buffer)
  }
  const value = Buffer.concat(chunks).toString('utf8').trim()
  return value || null
}

export async function runLocalAgentOneShot(
  session: LocalAgentSession,
  prompt: string,
  timeoutMs: number,
): Promise<{ result: LocalAgentCliResult; exitCode: number }> {
  await session.submit(prompt)
  const snapshot = await session.waitForActionOrCompletion(timeoutMs)
  const result = projectCliResult(snapshot)
  const exitCode = snapshot.run?.status === 'completed'
    ? 0
    : snapshot.run?.status === 'waiting_approval' || snapshot.run?.status === 'clarification_needed'
      ? 2
      : 1
  return { result, exitCode }
}

export function projectCliResult(snapshot: LocalAgentSessionSnapshot): LocalAgentCliResult {
  const run = snapshot.run
  return {
    ok: run?.status === 'completed',
    status: run?.status ?? snapshot.connection,
    runId: run?.id ?? null,
    threadId: snapshot.threadId,
    provider: snapshot.provider?.provider ?? null,
    model: snapshot.model,
    answer: latestAssistantAnswer(snapshot.items),
    decisions: (run?.state.decisions ?? [])
      .filter(decision => decision.status === 'pending')
      .map(decision => ({
        decisionId: decision.decisionId,
        kind: decision.kind,
        title: decision.title,
        question: decision.question,
        options: decision.options.map(option => ({
          optionId: option.optionId,
          label: option.label,
        })),
      })),
    artifacts: (run?.state.artifacts ?? []).map(artifact => ({
      artifactId: artifact.artifactId,
      name: artifact.name,
      uri: artifact.uri,
    })),
    errors: [...(run?.state.errors ?? []), ...(snapshot.error ? [snapshot.error] : [])],
  }
}

export function formatLocalAgentCliResult(result: LocalAgentCliResult, json: boolean): string {
  if (json) return `${JSON.stringify(result, null, 2)}\n`
  if (result.answer) return `${result.answer}\n`
  if (result.decisions.length) {
    const decision = result.decisions[0]
    const options = decision?.options.map(option => option.label).join(' / ') ?? ''
    return `${decision?.question ?? '运行需要你的操作。'}${options ? `\n可选：${options}` : ''}\n`
  }
  const error = result.errors.at(-1)
  return `${error ?? `运行结束：${result.status}`}\n`
}

export function localAgentHelpText(): string {
  return [
    `${PRODUCT_CODENAME} 本机 Agent`,
    '',
    '用法：',
    '  geo-agent-platform',
    '  geo-agent-platform --prompt "杭州明天会下雨吗？"',
    '  .\\dev.ps1 agent',
    '  .\\dev.ps1 agent --prompt "杭州明天会下雨吗？"',
    '  npm run agent --workspace @geo-agent-platform/operations-console -- --prompt "杭州明天会下雨吗？" --json',
    '',
    '参数：',
    '  -p, --prompt <文本>       非交互执行一次自然语言任务',
    '  --json                   非交互模式输出稳定 JSON',
    '  --mode auto|plan         自动或计划模式',
    '  --provider <名称>        选择服务端已公布的 Provider',
    '  --model <名称>           仅允许 Provider 能力清单内的模型',
    '  --thread <ID>            恢复指定线程的最近运行',
    '  --no-reasoning           不展示/请求思考过程',
    '  --timeout <秒>           非交互等待时间（5–3600）',
    '  --check                  只验证本机身份、API、模型与工作区',
    '',
    '交互命令：/help /new /history /plan /auto /reasoning /resume /cancel /model /tools /agents /status /exit',
    '',
  ].join('\n')
}

function requiredValue(argv: string[], index: number, option: string): string {
  const value = argv[index]
  if (!value?.trim()) throw new Error(`${option} 缺少参数值。`)
  return z.string().trim().min(1).parse(value)
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 统一开发启动器
//
//   文件:       devLauncher.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdir, open, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

import { applyDevelopmentDefaults } from './developmentDefaults.js'
import { environmentWithoutSystemCredentials } from './environment.js'

export { resolveDevelopmentRuntimeRoot } from './developmentDefaults.js'

export function devLauncherChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return environmentWithoutSystemCredentials(source)
}

const actionSchema = z.enum([
  'default', 'start', 'stop', 'restart', 'status', 'logs',
  'console', 'agent', 'desktop', 'shutdown',
])
const serviceSchema = z.enum(['all', 'infra', 'worker', 'api'])
const modeSchema = z.enum(['auto', 'plan'])
const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'unknown'])
const logStreamSchema = z.enum(['stdout', 'stderr', 'supervisor'])

export interface DevLauncherCommand {
  action: z.infer<typeof actionSchema>
  service: z.infer<typeof serviceSchema>
  json: boolean
  check: boolean
  keepInfra: boolean
  follow: boolean
  includeSupervisor: boolean
  tail: number
  level?: z.infer<typeof logLevelSchema>
  stream?: z.infer<typeof logStreamSchema>
  search?: string
  prompt?: string
  mode: z.infer<typeof modeSchema>
  provider?: string
  model?: string
  thread?: string
  timeout: number
  reasoning: boolean
  help: boolean
}

export interface DevLauncherDependencies {
  run(command: string, args: readonly string[], options?: { detached?: boolean; stdoutPath?: string; stderrPath?: string }): Promise<number>
  delay(milliseconds: number): Promise<void>
}

export function parseDevLauncherCommand(arguments_: readonly string[]): DevLauncherCommand {
  const parsed = parseArgs({
    args: arguments_,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      'keep-infra': { type: 'boolean', default: false },
      follow: { type: 'boolean', default: false },
      supervisor: { type: 'boolean', default: false },
      tail: { type: 'string', default: '80' },
      level: { type: 'string' },
      stream: { type: 'string' },
      search: { type: 'string' },
      prompt: { type: 'string' },
      mode: { type: 'string', default: 'auto' },
      provider: { type: 'string' },
      model: { type: 'string' },
      thread: { type: 'string' },
      timeout: { type: 'string', default: '600' },
      'no-reasoning': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const action = actionSchema.parse(parsed.positionals[0] ?? 'default')
  const service = serviceSchema.parse(parsed.positionals[1] ?? 'all')
  if (parsed.positionals.length > 2) throw new Error('开发启动器最多接受 action 和 service 两个位置参数。')
  return {
    action,
    service,
    json: Boolean(parsed.values.json),
    check: Boolean(parsed.values.check),
    keepInfra: Boolean(parsed.values['keep-infra']),
    follow: Boolean(parsed.values.follow),
    includeSupervisor: Boolean(parsed.values.supervisor),
    tail: boundedInteger(parsed.values.tail, 'tail', 0, 10_000),
    ...(parsed.values.level ? { level: logLevelSchema.parse(parsed.values.level) } : {}),
    ...(parsed.values.stream ? { stream: logStreamSchema.parse(parsed.values.stream) } : {}),
    ...(parsed.values.search ? { search: boundedText(parsed.values.search, 'search', 200) } : {}),
    ...(parsed.values.prompt ? { prompt: boundedText(parsed.values.prompt, 'prompt', 100_000) } : {}),
    mode: modeSchema.parse(parsed.values.mode),
    ...(parsed.values.provider ? { provider: boundedText(parsed.values.provider, 'provider', 120) } : {}),
    ...(parsed.values.model ? { model: boundedText(parsed.values.model, 'model', 200) } : {}),
    ...(parsed.values.thread ? { thread: boundedText(parsed.values.thread, 'thread', 200) } : {}),
    timeout: boundedInteger(parsed.values.timeout, 'timeout', 5, 3_600),
    reasoning: !parsed.values['no-reasoning'],
    help: Boolean(parsed.values.help),
  }
}

export function prerequisiteBuilds(): ReadonlyArray<readonly [string, readonly string[]]> {
  return [
    ['npm', ['run', 'build:dev', '--workspace', '@geo-agent-platform/db']],
    ['npm', ['run', 'build:dev', '--workspace', '@geo-agent-platform/shared-types']],
    ['npm', ['run', 'build:dev', '--workspace', '@geo-agent-platform/conversation-presentation']],
    ['npm', ['run', 'build:dev', '--workspace', '@geo-agent-platform/operations-supervisor']],
  ]
}

function operationsConsoleBuilds(): ReadonlyArray<readonly [string, readonly string[]]> {
  return [
    ['npm', ['run', 'build', '--workspace', 'geo-agent-server']],
  ]
}

export async function runDevLauncher(
  command: DevLauncherCommand,
  input: {
    projectRoot: string
    nodeExecutable: string
    dependencies?: DevLauncherDependencies
  },
): Promise<number> {
  if (command.help) {
    process.stdout.write(devLauncherHelp())
    return 0
  }
  const dependencies = input.dependencies ?? nativeDependencies()
  const projectRoot = path.resolve(input.projectRoot)
  applyDevelopmentDefaults(projectRoot)
  const supervisorCli = path.join(projectRoot, 'packages', 'operations-supervisor', 'dist', 'cli.js')
  const requiresBuild = ['default', 'start', 'restart', 'console', 'agent', 'desktop'].includes(command.action)
  if (requiresBuild) {
    for (const [program, args] of prerequisiteBuilds()) {
      if (await dependencies.run(program, args) !== 0) return 1
    }
  }
  if (command.action === 'default' || command.action === 'console' || command.action === 'agent') {
    for (const [program, args] of operationsConsoleBuilds()) {
      if (await dependencies.run(program, args) !== 0) return 1
    }
  }

  const probe = () => dependencies.run(input.nodeExecutable, [
    supervisorCli, 'status', '--root', projectRoot, '--profile', 'development', '--json',
  ])
  const ensureSupervisor = async (waitForReady = true): Promise<void> => {
    if (await probe() === 0) return
    const operationsRoot = path.join(process.env.RUNTIME_ROOT!, 'ops')
    const code = await dependencies.run(input.nodeExecutable, [
      supervisorCli, 'daemon', '--root', projectRoot, '--profile', 'development',
    ], {
      detached: true,
      stdoutPath: path.join(operationsRoot, 'supervisor-launch.stdout.log'),
      stderrPath: path.join(operationsRoot, 'supervisor-launch.stderr.log'),
    })
    if (code !== 0) throw new Error('TypeScript 监督器进程未能启动。')
    if (waitForReady) await waitForSupervisorReady(probe, dependencies.delay)
  }
  const supervisor = (args: readonly string[]) => dependencies.run(input.nodeExecutable, [
    supervisorCli, ...args, '--root', projectRoot, '--profile', 'development',
  ])

  if (command.action === 'default') {
    await ensureSupervisor()
    if (await supervisor(['start', 'all']) !== 0) return 1
    return dependencies.run('npm', ['run', 'console', '--workspace', '@geo-agent-platform/operations-console'])
  }
  if (command.action === 'start' || command.action === 'restart') {
    await ensureSupervisor()
    return supervisor([
      command.action, command.service,
      ...(command.json ? ['--json'] : []),
    ])
  }
  if (command.action === 'stop') {
    if (await probe() !== 0) return 0
    return supervisor([
      'stop', command.service,
      ...(command.keepInfra ? ['--keep-infra'] : []),
      ...(command.json ? ['--json'] : []),
    ])
  }
  if (command.action === 'status') {
    if (await probe() !== 0) return 0
    return supervisor(['status', ...(command.json ? ['--json'] : [])])
  }
  if (command.action === 'logs') {
    if (await probe() !== 0) throw new Error(`${PRODUCT_CODENAME} 监督器未运行。`)
    return supervisor([
      'logs', command.service, '--tail', String(command.tail),
      ...(command.follow ? ['--follow'] : []),
      ...(command.level ? ['--level', command.level] : []),
      ...(command.stream ? ['--stream', command.stream] : []),
      ...(command.search ? ['--search', command.search] : []),
      ...(command.includeSupervisor ? ['--supervisor'] : []),
    ])
  }
  if (command.action === 'console') {
    await ensureSupervisor()
    return dependencies.run('npm', [
      'run', 'console', '--workspace', '@geo-agent-platform/operations-console',
      ...(command.check ? ['--', '--check'] : []),
    ])
  }
  if (command.action === 'agent') {
    await ensureSupervisor()
    if (await supervisor(['start', 'api']) !== 0) return 1
    return dependencies.run('npm', [
      'run', 'agent', '--workspace', '@geo-agent-platform/operations-console', '--',
      ...(command.check ? ['--check'] : []),
      ...(command.json ? ['--json'] : []),
      ...(command.prompt ? ['--prompt', command.prompt] : []),
      '--mode', command.mode,
      ...(command.provider ? ['--provider', command.provider] : []),
      ...(command.model ? ['--model', command.model] : []),
      ...(command.thread ? ['--thread', command.thread] : []),
      '--timeout', String(command.timeout),
      ...(!command.reasoning ? ['--no-reasoning'] : []),
    ])
  }
  if (command.action === 'desktop') {
    await ensureSupervisor()
    // Desktop 与 API 共享当前工作区契约。仅检查健康会让长期运行的旧 API
    // 与刚编译的 Desktop schema 发生版本撕裂；重启 Worker 会连带重启 API，
    // 再显式启动 API 可同时覆盖首次启动和已有服务两种状态，且不重启 PostGIS。
    if (await supervisor(['restart', 'worker']) !== 0) return 1
    if (await supervisor(['start', 'api']) !== 0) return 1
    return dependencies.run('npm', ['run', 'dev', '--workspace', '@geo-agent-platform/desktop'])
  }
  if (command.action === 'shutdown') {
    if (await probe() !== 0) return 0
    return supervisor(['shutdown', ...(command.json ? ['--json'] : [])])
  }
  return 1
}

export async function waitForSupervisorReady(
  probe: () => Promise<number>,
  delay: (milliseconds: number) => Promise<void>,
  attempts = 80,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await probe() === 0) return
    await delay(250)
  }
  throw new Error('TypeScript 监督器未在 20 秒内开放本机 IPC。请查看 runtime/ops/supervisor-launch.*.log。')
}

function devLauncherHelp(): string {
  return [
    '用法：dev.[sh|ps1] [start|stop|restart|status|logs|console|agent|desktop|shutdown] [all|infra|worker|api] [选项]',
    '通用：--json  --check  --help',
    '日志：--tail N  --follow  --level LEVEL  --stream STREAM  --search TEXT  --supervisor',
    'Agent：--prompt TEXT  --mode auto|plan  --provider NAME  --model NAME  --thread ID  --timeout SEC  --no-reasoning',
    '',
  ].join('\n')
}

function nativeDependencies(): DevLauncherDependencies {
  return {
    run: async (command, args, options = {}) => {
      const npmEntrypoint = command === 'npm' ? process.env.npm_execpath : undefined
      const executable = npmEntrypoint ? process.execPath : command
      const executableArguments = npmEntrypoint ? [npmEntrypoint, ...args] : [...args]
      const detachedOutput = options.detached
        ? await openDetachedOutput(options.stdoutPath, options.stderrPath)
        : null
      const child = spawn(executable, executableArguments, {
        cwd: process.env.GEO_AGENT_PLATFORM_ROOT,
        env: devLauncherChildEnvironment(process.env),
        shell: false,
        windowsHide: true,
        detached: options.detached,
        stdio: detachedOutput
          ? ['ignore', detachedOutput.stdout.fd, detachedOutput.stderr.fd]
          : ['inherit', 'inherit', 'inherit'],
      })
      if (options.detached) {
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve)
          child.once('error', reject)
        }).finally(async () => {
          await Promise.all([
            detachedOutput?.stdout.close(),
            detachedOutput?.stderr.close(),
          ])
        })
        child.unref()
        return 0
      }
      return new Promise<number>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', code => resolve(code ?? 1))
      })
    },
    delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  }
}

async function openDetachedOutput(
  stdoutPath?: string,
  stderrPath?: string,
): Promise<{
  stdout: Awaited<ReturnType<typeof open>>
  stderr: Awaited<ReturnType<typeof open>>
}> {
  if (!stdoutPath || !stderrPath) throw new Error('后台进程必须配置标准输出和错误日志。')
  await Promise.all([
    mkdir(path.dirname(stdoutPath), { recursive: true }),
    mkdir(path.dirname(stderrPath), { recursive: true }),
  ])
  await Promise.all([
    rotateDetachedOutput(stdoutPath),
    rotateDetachedOutput(stderrPath),
  ])
  const [stdout, stderr] = await Promise.all([
    open(stdoutPath, 'a'),
    open(stderrPath, 'a'),
  ])
  return { stdout, stderr }
}

/**
 * 后台启动捕获文件只承担 daemon 建立统一日志前的故障信息。每次启动前原子
 * 轮转非空旧文件，既不覆盖历史，也不让固定文件无限追加。
 */
export async function rotateDetachedOutput(
  filePath: string,
  now: Date = new Date(),
  processId: number = process.pid,
): Promise<string | null> {
  const details = await stat(filePath).catch(error => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  })
  if (!details || details.size === 0) return null
  const extension = path.extname(filePath)
  const stem = path.basename(filePath, extension)
  const timestamp = now.toISOString().replace(/[:.]/gu, '-')
  const destination = path.join(path.dirname(filePath), `${stem}.${timestamp}.${processId}${extension}`)
  await rename(filePath, destination)
  return destination
}

function boundedInteger(value: string | undefined, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} 必须是 ${minimum} 到 ${maximum} 的整数。`)
  }
  return parsed
}

function boundedText(value: string, name: string, maximum: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) throw new Error(`--${name} 长度无效。`)
  return normalized
}

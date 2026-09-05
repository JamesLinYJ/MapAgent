#!/usr/bin/env node
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 进程监督命令行入口
//
//   文件:       cli.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

import {
  operationsProfileSchema,
  operationsLogLevelSchema,
  operationsLogStreamSchema,
  operationsServiceIdSchema,
  type OperationsLogEntry,
  type OperationsLogFilter,
  type OperationsOperationResult,
  type OperationsProfile,
  type OperationsServiceId,
  type OperationsSnapshot,
} from '@geo-agent-platform/shared-types/operations'
import { config as loadDotEnv } from 'dotenv'
import lockfile from 'proper-lockfile'

import { OperationsClient } from './client.js'
import { resolveOperationsCliPathInput } from './cliRuntimePaths.js'
import { applyDevelopmentDefaults } from './developmentDefaults.js'
import { projectSupervisorEnvironment } from './environment.js'
import { OperationsIpcServer } from './ipcServer.js'
import { OperationsLogBuffer } from './logBuffer.js'
import {
  assertProductionSecretPermissions,
  ensureSecretFile,
  resolveOperationsPaths,
  type OperationsPaths,
} from './paths.js'
import { OperationsSupervisor } from './supervisor.js'
import { createSupervisorLogger } from './systemLogger.js'

const parsedArgs = parseArgs({
  allowPositionals: true,
  strict: true,
  options: {
    root: { type: 'string' },
    'runtime-root': { type: 'string' },
    'token-file': { type: 'string' },
    'root-secret-file': { type: 'string' },
    profile: { type: 'string' },
    json: { type: 'boolean', default: false },
    tail: { type: 'string', default: '80' },
    follow: { type: 'boolean', default: false },
    level: { type: 'string' },
    stream: { type: 'string' },
    search: { type: 'string' },
    supervisor: { type: 'boolean', default: false },
    'keep-infra': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

async function main(): Promise<void> {
  if (parsedArgs.values.help) {
    printHelp()
    return
  }
  const projectRoot = path.resolve(
    parsedArgs.values.root
      ?? process.env.GEO_AGENT_PLATFORM_ROOT
      ?? defaultProjectRoot(),
  )
  loadDotEnv({ path: path.join(projectRoot, '.env'), quiet: true })
  const profile = resolveProfile(parsedArgs.values.profile)
  if (profile === 'development') applyDevelopmentDefaults(projectRoot)
  const paths = await resolveOperationsPaths(resolveOperationsCliPathInput({
    arguments: {
      ...(parsedArgs.values.root ? { root: parsedArgs.values.root } : {}),
      ...(parsedArgs.values['runtime-root'] ? { runtimeRoot: parsedArgs.values['runtime-root'] } : {}),
      ...(parsedArgs.values['token-file'] ? { tokenFile: parsedArgs.values['token-file'] } : {}),
      ...(parsedArgs.values['root-secret-file']
        ? { rootSecretFile: parsedArgs.values['root-secret-file'] }
        : {}),
    },
    environment: process.env,
    defaultProjectRoot: projectRoot,
    profile,
  }))
  const command = parsedArgs.positionals[0] ?? 'status'
  if (command === 'daemon') {
    await runDaemon(paths, profile, projectSupervisorEnvironment(process.env))
    return
  }
  await runClientCommand(paths, command)
}

async function runDaemon(
  paths: OperationsPaths,
  profile: OperationsProfile,
  serviceEnvironment: NodeJS.ProcessEnv,
): Promise<void> {
  await writeFile(paths.lockTarget, '', { encoding: 'utf8', flag: 'a' })
  let releaseLock: (() => Promise<void>) | null = null
  try {
    releaseLock = await lockfile.lock(paths.lockTarget, {
      realpath: false,
      retries: 0,
      stale: 30_000,
      update: 5_000,
    })
  } catch (error) {
    throw new Error(`${PRODUCT_CODENAME} 监督器已在运行，或单实例锁不可用：${safeMessage(error)}`)
  }
  const token = await ensureSecretFile(paths.tokenFile, profile === 'development')
  if (profile === 'production') await assertProductionSecretPermissions(paths.tokenFile)
  const systemLogger = createSupervisorLogger(paths, undefined, {
    // 后台 daemon 的 stdout 已由启动器接管；正常事件只写统一 JSONL，避免重复落盘。
    includeStdout: process.stdout.isTTY === true,
  })
  const logger = systemLogger.logger
  const logBuffer = new OperationsLogBuffer()
  const supervisor = new OperationsSupervisor({
    paths,
    profile,
    environment: serviceEnvironment,
    logBuffer,
    logger,
    persistenceState: systemLogger.persistenceState,
    historyReader: systemLogger.readHistory,
  })
  let resolveShutdown: (() => void) | null = null
  const shutdownRequested = new Promise<void>(resolve => { resolveShutdown = resolve })
  const ipc = new OperationsIpcServer({
    endpoint: paths.endpoint,
    token,
    supervisor,
    logger,
    onShutdownRequested: () => resolveShutdown?.(),
  })
  const requestShutdown = (): void => resolveShutdown?.()
  process.once('SIGINT', requestShutdown)
  process.once('SIGTERM', requestShutdown)
  try {
    await supervisor.recoverLeases()
    await ipc.listen()
    logger.info({
      endpoint: paths.endpoint,
      workspaceId: paths.workspaceId,
      profile,
      pid: process.pid,
    }, `${PRODUCT_CODENAME} 监督器已就绪`)
    await shutdownRequested
  } finally {
    process.off('SIGINT', requestShutdown)
    process.off('SIGTERM', requestShutdown)
    await ipc.close().catch(error => logger.error({ error }, '关闭监督 IPC 失败'))
    await supervisor.close().catch(error => logger.error({ error }, '关闭受监督服务失败'))
    await releaseLock?.().catch(() => undefined)
    await systemLogger.close().catch(() => undefined)
  }
}

async function runClientCommand(paths: OperationsPaths, command: string): Promise<void> {
  const token = (await readFile(paths.tokenFile, 'utf8')).trim()
  const client = await OperationsClient.connect({ endpoint: paths.endpoint, token, interactive: false })
  try {
    if (command === 'status') {
      printSnapshot(await client.status(), Boolean(parsedArgs.values.json))
      return
    }
    if (command === 'logs') {
      await showLogs(
        client,
        parseTarget(parsedArgs.positionals[1]),
        parseTail(parsedArgs.values.tail),
        Boolean(parsedArgs.values.follow),
        {
          levels: parseCsv(parsedArgs.values.level, operationsLogLevelSchema),
          streams: parseCsv(parsedArgs.values.stream, operationsLogStreamSchema),
          categories: [],
          events: [],
          retentions: [],
          correlationId: '',
          search: parsedArgs.values.search?.trim() ?? '',
          includeSupervisor: Boolean(parsedArgs.values.supervisor),
          afterSequence: null,
        },
      )
      return
    }
    if (command === 'shutdown') {
      printOperation(await client.shutdown(), Boolean(parsedArgs.values.json))
      return
    }
    if (command === 'start' || command === 'stop' || command === 'restart') {
      const result = await client.operate({
        action: command,
        target: parseTarget(parsedArgs.positionals[1]),
        operationId: randomUUID(),
        ...(command === 'stop' ? { keepInfra: Boolean(parsedArgs.values['keep-infra']) } : {}),
      })
      printOperation(result, Boolean(parsedArgs.values.json))
      if (result.outcome === 'failed') process.exitCode = 1
      return
    }
    throw new Error(`未知监督命令 '${command}'。`)
  } finally {
    client.close()
  }
}

async function showLogs(
  client: OperationsClient,
  target: OperationsServiceId | 'all',
  tail: number,
  follow: boolean,
  filters: Omit<OperationsLogFilter, 'services'>,
): Promise<void> {
  const services: OperationsServiceId[] = target === 'all'
    ? ['infra', 'worker', 'api']
    : [target]
  for (const entry of (await client.logs(services, tail, filters)).entries) printLog(entry)
  if (!follow) return
  const allowed = new Set(services)
  const dispose = client.onEvent(event => {
    if (event.event !== 'log') return
    const serviceAllowed = event.entry.serviceId
      ? allowed.has(event.entry.serviceId)
      : filters.includeSupervisor
    if (serviceAllowed) printLog(event.entry)
  })
  await client.subscribe({
    metrics: false,
    logs: true,
    logFilter: { services, ...filters },
  })
  await new Promise<void>(resolve => process.once('SIGINT', resolve))
  dispose()
}

function printSnapshot(snapshot: OperationsSnapshot, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(snapshot))
    return
  }
  console.log(`${PRODUCT_CODENAME} 监督器 PID ${snapshot.host.supervisorPid} · ${snapshot.host.profile === 'production' ? '生产' : '开发'}环境`)
  console.table(snapshot.services.map(service => ({
    服务: service.displayName,
    状态: stateLabel(service.state),
    PID: service.pid ?? '—',
    CPU: formatMetric(service.cpuPercent.value, '%'),
    内存: formatBytes(service.memoryBytes.value),
    重启: service.restartCount,
    健康: service.healthMessage,
  })))
}

function printOperation(result: OperationsOperationResult, json: boolean): void {
  if (json) console.log(JSON.stringify(result))
  else console.log(`${result.outcome === 'succeeded' ? '成功' : result.outcome === 'partial' ? '部分成功' : '失败'}：${result.message}（operationId: ${result.operationId}）`)
}

function printLog(entry: OperationsLogEntry): void {
  const source = [
    entry.serviceId ?? 'supervisor',
    entry.component,
    entry.processId ? `PID ${entry.processId}` : null,
  ].filter(Boolean).join('/')
  console.log(`${entry.createdAt} [${entry.level}] [${source}] [${entry.stream}] ${entry.message}`)
}

function parseTarget(value: string | undefined): OperationsServiceId | 'all' {
  if (!value || value === 'all') return 'all'
  return operationsServiceIdSchema.parse(value)
}

function parseTail(value: string | undefined): number {
  const tail = Number(value)
  if (!Number.isInteger(tail) || tail < 0 || tail > 10_000) throw new Error('--tail 必须是 0 到 10000 的整数。')
  return tail
}

function parseCsv<T extends string>(
  value: string | undefined,
  schema: { parse(input: unknown): T },
): T[] {
  if (!value?.trim()) return []
  return [...new Set(value.split(',').map(item => schema.parse(item.trim())))]
}

function resolveProfile(value: string | undefined): OperationsProfile {
  return operationsProfileSchema.parse(value ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development'))
}

function defaultProjectRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url))
}

function stateLabel(state: string): string {
  return {
    stopped: '已停止',
    waiting_dependency: '等待依赖',
    starting: '启动中',
    healthy: '健康',
    degraded: '降级',
    stopping: '停止中',
    restart_wait: '等待重启',
    failed: '失败',
    conflict: '端口冲突',
  }[state] ?? state
}

function formatMetric(value: number | null, suffix: string): string {
  return value === null ? '未知' : `${value.toFixed(1)}${suffix}`
}

function formatBytes(value: number | null): string {
  if (value === null) return '未知'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function printHelp(): void {
  console.log(`${PRODUCT_CODENAME} TypeScript 进程监督器

用法：geo-agent-platform-supervisor <daemon|start|stop|restart|status|logs|shutdown> [all|infra|worker|api]

选项：
  --profile development|production
  --root <绝对项目路径>
  --runtime-root <绝对运行时路径>
  --json                 输出机器可读结果
  --tail <数量>          日志尾部行数
  --follow               持续跟随日志
  --level <级别,...>     按 debug/info/warn/error/unknown 筛选
  --stream <流,...>      按 stdout/stderr/supervisor 筛选
  --search <文字>        搜索服务、组件和日志正文
  --supervisor           同时包含 Supervisor 自身日志
  --keep-infra           stop all 时保留基础设施`)
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 500) : '未知错误。'
}

main().catch(error => {
  console.error(`${PRODUCT_CODENAME} 监督命令失败：${safeMessage(error)}`)
  process.exitCode = 1
})

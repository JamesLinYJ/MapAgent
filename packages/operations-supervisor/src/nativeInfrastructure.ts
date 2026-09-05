// +-------------------------------------------------------------------------
//
//   地理智能平台 - 原生基础设施进程组
//
//   文件:       nativeInfrastructure.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import concurrently, { type Command, type ConcurrentlyResult } from 'concurrently'

import { environmentForConcurrently, utilityProcessEnvironment } from './environment.js'
import { resolveNativeInfrastructureConfig, type NativeInfrastructureConfig } from './nativeInfrastructureConfig.js'

const execFileAsync = promisify(execFile)
const currentFile = fileURLToPath(import.meta.url)

async function runNativeInfrastructure(input: {
  projectRoot: string
  runtimeRoot: string
  profile: 'development' | 'production'
  environment: NodeJS.ProcessEnv
}): Promise<void> {
  const config = resolveNativeInfrastructureConfig(input)
  await ensurePostgresCluster(config)

  const postgres = startGroup([{
    name: 'postgresql',
    command: commandLine(
      config.database.binaries.postgres,
      postgresServerArguments(config),
    ),
  }], config)
  const stopPostgres = installShutdownHandlers(postgres.commands)
  const postgresExit = failWhenGroupExits(postgres, 'PostgreSQL')

  try {
    await Promise.race([
      (async () => {
        await waitForPostgres(config, 60_000)
        await verifyPostgisAvailability(config)
        await ensureDatabase(config)
        await initializeDatabaseSchema(config)
      })(),
      postgresExit,
    ])
    await postgresExit
  } finally {
    stopPostgres()
    killCommands(postgres.commands)
  }
}

/**
 * 私有数据库的所有客户端都显式走 TCP loopback。Linux 发行版常把
 * Unix socket 默认到只允许系统 PostgreSQL 用户写入的 /var/run/postgresql，
 * 普通桌面用户启动时会在已监听 TCP 后反而因创建 socket 锁失败。显式
 * 禁用未使用的 Unix socket，同时关闭发行版默认的 logging collector，
 * 让真实启动错误留在 Supervisor 的受控日志中。
 */
export function postgresServerArguments(config: NativeInfrastructureConfig): string[] {
  return [
    '-D', config.database.dataDirectory,
    '-h', config.database.host,
    '-p', String(config.database.port),
    '-c', 'unix_socket_directories=',
    '-c', 'logging_collector=off',
    '-c', 'log_checkpoints=off',
  ]
}

/**
 * PostGIS 是 PostgreSQL 的运行时扩展，不应为了定位 extension 目录而强迫最终用户
 * 安装只面向编译扩展的 pg_config/devel 软件包。私有集群启动后直接询问 PostgreSQL
 * 的扩展目录事实源，既能验证当前服务端主版本，也能给出稳定的产品错误。
 */
export function postgisAvailabilityArguments(config: NativeInfrastructureConfig): string[] {
  return [
    ...databaseArguments(config, 'postgres'),
    '-X',
    '-qAt',
    '-v', 'ON_ERROR_STOP=1',
    '-c', "SELECT default_version FROM pg_available_extensions WHERE name = 'postgis';",
  ]
}

async function checkNativeInfrastructure(input: {
  projectRoot: string
  runtimeRoot: string
  profile: 'development' | 'production'
  environment: NodeJS.ProcessEnv
}): Promise<void> {
  const config = resolveNativeInfrastructureConfig(input)
  await execFileAsync(config.database.binaries.psql, postgisHealthArguments(config), {
    env: nativeInfrastructureProcessEnvironment(config),
    timeout: 10_000,
    windowsHide: true,
  })
}

/**
 * PostgreSQL 由固定数据目录标识，并通过 pg_ctl 进行 fast shutdown。未初始化或
 * 已停止的私有集群视为幂等成功；不扫描进程表，也不接管任意 PostgreSQL 实例。
 */
async function stopNativeInfrastructure(input: {
  projectRoot: string
  runtimeRoot: string
  profile: 'development' | 'production'
  environment: NodeJS.ProcessEnv
}): Promise<void> {
  const config = resolveNativeInfrastructureConfig(input)
  const versionFile = path.join(config.database.dataDirectory, 'PG_VERSION')
  try {
    await fs.access(versionFile)
  } catch {
    return
  }

  try {
    await execFileAsync(config.database.binaries.pgCtl, [
      '-D', config.database.dataDirectory,
      'status',
    ], {
      cwd: config.projectRoot,
      env: nativeInfrastructureProcessEnvironment(config),
      timeout: 10_000,
      windowsHide: true,
    })
  } catch {
    return
  }

  await execFileAsync(config.database.binaries.pgCtl, [
    '-D', config.database.dataDirectory,
    '-m', 'fast',
    '-w',
    '-t', '30',
    'stop',
  ], {
    cwd: config.projectRoot,
    env: nativeInfrastructureProcessEnvironment(config),
    timeout: 40_000,
    windowsHide: true,
  })
}

/**
 * `pg_isready` 只能证明 PostgreSQL 正在接受连接；即使目标数据库尚未创建，
 * 它仍可能返回成功。Infra 必须在 PostGIS 与基线表均可查询后才对依赖方报健康。
 */
export function postgisHealthArguments(config: NativeInfrastructureConfig): string[] {
  return [
    ...databaseArguments(config, config.database.name),
    '-X',
    '-qAt',
    '-v', 'ON_ERROR_STOP=1',
    '-c', [
      'SELECT postgis_full_version();',
      'SELECT 1 FROM platform_sessions LIMIT 0;',
      'SELECT 1 FROM platform_layer_features LIMIT 0;',
      'SELECT 1 FROM platform_agent_step_contexts LIMIT 0;',
    ].join(' '),
  ]
}

async function verifyPostgisAvailability(config: NativeInfrastructureConfig): Promise<void> {
  const { stdout } = await execFileAsync(
    config.database.binaries.psql,
    postgisAvailabilityArguments(config),
    {
      env: nativeInfrastructureProcessEnvironment(config),
      timeout: 10_000,
      windowsHide: true,
    },
  )
  if (!stdout.trim()) {
    throw new Error('当前 PostgreSQL 未安装可用的 PostGIS 扩展。请安装与 PostgreSQL 主版本匹配的官方 PostGIS。')
  }
}

async function ensurePostgresCluster(config: NativeInfrastructureConfig): Promise<void> {
  const versionFile = path.join(config.database.dataDirectory, 'PG_VERSION')
  try {
    await fs.access(versionFile)
    return
  } catch {
    await fs.mkdir(config.database.dataDirectory, { recursive: true })
  }

  const passwordFile = path.join(config.runtimeRoot, 'native', `.postgres-password-${process.pid}`)
  await fs.mkdir(path.dirname(passwordFile), { recursive: true })
  await fs.writeFile(passwordFile, `${config.database.password}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await execFileAsync(config.database.binaries.initdb, [
      '--pgdata', config.database.dataDirectory,
      '--username', config.database.user,
      '--pwfile', passwordFile,
      '--auth-host', 'scram-sha-256',
      '--auth-local', 'scram-sha-256',
      '--encoding', 'UTF8',
    ], {
      cwd: config.projectRoot,
      env: nativeInfrastructureProcessEnvironment(config),
      timeout: 120_000,
      windowsHide: true,
    })
  } finally {
    await fs.rm(passwordFile, { force: true })
  }
}

async function ensureDatabase(config: NativeInfrastructureConfig): Promise<void> {
  const common = databaseArguments(config, 'postgres')
  const { stdout } = await execFileAsync(config.database.binaries.psql, [
    ...common,
    '-tAc',
    `SELECT 1 FROM pg_database WHERE datname = '${config.database.name}'`,
  ], {
    env: nativeInfrastructureProcessEnvironment(config),
    timeout: 15_000,
    windowsHide: true,
  })
  if (stdout.trim() === '1') return
  await execFileAsync(config.database.binaries.createdb, [
    '-h', config.database.host,
    '-p', String(config.database.port),
    '-U', config.database.user,
    config.database.name,
  ], {
    env: nativeInfrastructureProcessEnvironment(config),
    timeout: 30_000,
    windowsHide: true,
  })
}

/**
 * 数据库 SQL 只有一份空库基线。Supervisor 只在确认业务 schema 完全为空时执行；
 * 已存在数据库只做结构检查，既不 ALTER，也不通过历史脚本猜测如何升级。
 */
async function initializeDatabaseSchema(config: NativeInfrastructureConfig): Promise<void> {
  const schemaPath = path.join(config.projectRoot, 'infra', 'database', 'schema.sql')
  const metadata = await fs.stat(schemaPath).catch(() => null)
  if (!metadata?.isFile()) {
    throw new Error(`缺少权威数据库基线：${schemaPath}`)
  }

  const inspection = await execFileAsync(config.database.binaries.psql, [
    ...databaseArguments(config, config.database.name),
    '-X',
    '-qAt',
    '-v', 'ON_ERROR_STOP=1',
    '-c', [
      "SELECT CASE WHEN to_regclass('public.platform_sessions') IS NOT NULL",
      "  AND to_regclass('public.platform_agent_step_contexts') IS NOT NULL",
      "  AND to_regclass('public.platform_run_snapshots') IS NOT NULL",
      "THEN 1 ELSE 0 END,",
      '(SELECT COUNT(*) FROM information_schema.tables',
      " WHERE table_schema = 'public'",
      "   AND (table_name LIKE 'platform_%'",
      "     OR table_name LIKE 'auth_%'",
      "     OR table_name = 'tool_catalog_entries'));",
    ].join(' '),
  ], {
    env: nativeInfrastructureProcessEnvironment(config),
    timeout: 15_000,
    windowsHide: true,
  })
  const [readyText, tableCountText] = inspection.stdout.trim().split('|')
  const schemaReady = readyText === '1'
  const businessTableCount = Number.parseInt(tableCountText ?? '', 10)
  if (schemaReady) return
  if (!Number.isInteger(businessTableCount)) {
    throw new Error('无法判断数据库是否为空，拒绝执行数据库基线。')
  }
  if (businessTableCount > 0) {
    throw new Error(
      '数据库存在不完整或旧版业务结构。平台不执行增量迁移；'
      + '请先导出需要保留的数据，再使用空数据库重新初始化。',
    )
  }

  await execFileAsync(config.database.binaries.psql, [
    ...databaseArguments(config, config.database.name),
    '-X',
    '-v', 'ON_ERROR_STOP=1',
    '-f', schemaPath,
  ], {
    cwd: config.projectRoot,
    env: nativeInfrastructureProcessEnvironment(config),
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
}

async function waitForPostgres(config: NativeInfrastructureConfig, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastReason = '尚未响应'
  while (Date.now() < deadline) {
    try {
      await execFileAsync(config.database.binaries.pgIsReady, [
        '-h', config.database.host,
        '-p', String(config.database.port),
        '-U', config.database.user,
        '-q',
      ], {
        env: nativeInfrastructureProcessEnvironment(config),
        timeout: 3_000,
        windowsHide: true,
      })
      return
    } catch (error) {
      lastReason = safeReason(error)
      await delay(500)
    }
  }
  throw new Error(`PostgreSQL 未在 ${Math.ceil(timeoutMs / 1_000)} 秒内就绪：${lastReason}`)
}

function startGroup(
  commands: Array<{ name: string; command: string; env?: Record<string, string> }>,
  config: NativeInfrastructureConfig,
): ConcurrentlyResult {
  return concurrently(commands.map(command => ({
    ...command,
    cwd: config.projectRoot,
    env: environmentForConcurrently(process.env, {
      ...nativeInfrastructureProcessEnvironment(config),
      ...command.env,
    }),
  })), {
    prefix: '[{name}]',
    prefixColors: false,
    raw: false,
    handleInput: false,
    restartTries: 0,
    killOthersOn: ['failure', 'success'],
    killSignal: 'SIGTERM',
    killTimeout: 20_000,
    successCondition: 'all',
  })
}

export function nativeInfrastructureProcessEnvironment(
  config: NativeInfrastructureConfig,
): NodeJS.ProcessEnv {
  return {
    ...utilityProcessEnvironment(config.environment),
    PGPASSWORD: config.database.password,
    PGHOST: config.database.host,
    PGPORT: String(config.database.port),
    PGUSER: config.database.user,
    PGDATABASE: config.database.name,
  }
}

function databaseArguments(config: NativeInfrastructureConfig, database: string): string[] {
  return [
    '-h', config.database.host,
    '-p', String(config.database.port),
    '-U', config.database.user,
    '-d', database,
  ]
}

function commandLine(executable: string, arguments_: readonly string[]): string {
  return [executable, ...arguments_].map(quoteShellArgument).join(' ')
}

function quoteShellArgument(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/gu, '""')}"`
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

function installShutdownHandlers(commands: readonly Command[]): () => void {
  const stop = () => killCommands(commands)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  return () => {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

function killCommands(commands: readonly Command[]): void {
  for (const command of commands) {
    if (!command.killed && !command.exited) command.kill('SIGTERM')
  }
}

async function failWhenGroupExits(result: ConcurrentlyResult, label: string): Promise<never> {
  try {
    const events = await result.result
    const exit = events[0]?.exitCode ?? 'unknown'
    throw new Error(`${label} 原生进程组意外退出（${String(exit)}）。`)
  } catch (error) {
    throw new Error(`${label} 原生进程组失败：${safeReason(error)}`)
  }
}

function safeReason(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\r\n]+/gu, ' ').slice(0, 500)
    : '未知错误'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function main(): Promise<void> {
  const projectRoot = process.env.GEO_AGENT_PLATFORM_ROOT ?? process.cwd()
  const runtimeRoot = process.env.RUNTIME_ROOT ?? path.join(projectRoot, 'runtime')
  const profile = process.env.NODE_ENV === 'production' ? 'production' : 'development'
  const input = { projectRoot, runtimeRoot, profile, environment: process.env } as const
  if (process.argv.includes('--stop')) {
    await stopNativeInfrastructure(input)
    return
  }
  if (process.argv.includes('--check')) {
    await checkNativeInfrastructure(input)
    return
  }
  await runNativeInfrastructure(input)
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(currentFile)) {
  main().catch(error => {
    process.stderr.write(`原生基础设施启动失败：${safeReason(error)}\n`)
    process.exitCode = 1
  })
}

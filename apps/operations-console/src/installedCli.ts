// +-------------------------------------------------------------------------
//
//   地理智能平台 - 安装版统一命令行
//
//   文件:       installedCli.ts
//
//   日期:       2026年08月12日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-09-03):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 安装版命令扩展到 macOS 随包运行时，并从当前应用位置启动桌面端。
// --------------------------------------------------------------------------

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { OperationsClient } from '@geo-agent-platform/operations-supervisor/client'
import {
  preparePackagedLocalRuntime,
} from '@geo-agent-platform/operations-supervisor/packaged-local-runtime'
import { resolveOperationsPaths } from '@geo-agent-platform/operations-supervisor/paths'
import {
  PLATFORM_TECHNICAL_ID,
  PRODUCT_CODENAME,
  PRODUCT_DESKTOP_NAME,
  PRODUCT_EXECUTABLE_BASENAME,
} from '@geo-agent-platform/shared-types/product-identity'
import { parse as parseDotEnv } from 'dotenv'
const SYSTEM_RUNTIME_MANIFEST = '/etc/geo-agent-platform/runtime-manifest.v1.json'
const SUPERVISOR_READY_TIMEOUT_MS = 30_000
const DESKTOP_EARLY_EXIT_WINDOW_MS = 1_500
const DESKTOP_SESSION_ENVIRONMENT_NAMES = new Set([
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'ELECTRON_OZONE_PLATFORM_HINT',
  'GDK_BACKEND',
  'GTK_USE_PORTAL',
  'HOME',
  'LANG',
  'LOGNAME',
  'PATH',
  'SHELL',
  'USER',
  'USERNAME',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CURRENT_DESKTOP',
  'XDG_DATA_DIRS',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_DESKTOP',
  'XDG_SESSION_TYPE',
  'XDG_STATE_HOME',
])
const INSTALLED_CLI_CHILD_ENVIRONMENT_NAMES = new Set([
  'BETTER_AUTH_MIN_PASSWORD_LENGTH',
  'CI',
  'COLORTERM',
  'COLUMNS',
  'COMSPEC',
  'ComSpec',
  'FORCE_COLOR',
  'GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE',
  'GEO_AGENT_PLATFORM_REDUCED_MOTION',
  'GEO_AGENT_PLATFORM_ROOT',
  'GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE',
  'HOME',
  'LANG',
  'LINES',
  'LOGNAME',
  'NODE_ENV',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'Path',
  'RUNTIME_ROOT',
  'SHELL',
  'SYSTEMROOT',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'WINDIR',
  'XDG_RUNTIME_DIR',
])

export type InstalledCliCommand =
  | { kind: 'agent'; arguments: string[] }
  | { kind: 'console'; arguments: string[] }
  | { kind: 'desktop' }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'supervisor'; command: 'status' | 'logs'; arguments: string[] }
  | { kind: 'start' }

export interface InstalledCliDependencies {
  runtimeRoot: string
  environment: NodeJS.ProcessEnv
  homeDirectory: string
  ownerUid?: number
  stdout: Pick<NodeJS.WriteStream, 'write'>
  stderr: Pick<NodeJS.WriteStream, 'write'>
  runChild: (executable: string, arguments_: readonly string[], environment: NodeJS.ProcessEnv) => Promise<number>
  launchDesktop: (environment: NodeJS.ProcessEnv) => Promise<void>
  now: () => number
  delay: (milliseconds: number) => Promise<void>
}

export async function runInstalledCli(
  argv: readonly string[],
  dependencies: InstalledCliDependencies = productionDependencies(),
): Promise<number> {
  assertProductNodeRuntime(process.versions.node)
  const command = parseInstalledCli(argv)
  if (command.kind === 'help') {
    dependencies.stdout.write(installedCliHelpText())
    return 0
  }
  if (command.kind === 'version') {
    const packageJson: unknown = JSON.parse(await readFile(
      path.join(dependencies.runtimeRoot, 'package.json'),
      'utf8',
    ))
    const version = typeof packageJson === 'object' && packageJson !== null
      && 'version' in packageJson && typeof packageJson.version === 'string'
      ? packageJson.version
      : 'unknown'
    dependencies.stdout.write(`${PRODUCT_CODENAME} ${version}\n`)
    return 0
  }
  if (command.kind === 'desktop') {
    assertGraphicalDesktopSession(dependencies.environment)
    await launchInstalledDesktop({
      ensureBackend: () => ensureInstalledBackend(dependencies),
      launchDesktop: () => dependencies.launchDesktop(
        createDesktopLaunchEnvironment(dependencies.environment),
      ),
    })
    return 0
  }

  const environmentFile = await prepareInstalledRuntime(dependencies)
  Object.assign(dependencies.environment, parseDotEnv(await readFile(environmentFile, 'utf8')))
  dependencies.environment.NODE_ENV = 'production'
  dependencies.environment.GEO_AGENT_PLATFORM_ROOT = dependencies.runtimeRoot

  const supervisor = await connectSupervisor(dependencies)
  try {
    if (command.kind === 'start') {
      await startApi(supervisor)
      dependencies.stdout.write(`${PRODUCT_DESKTOP_NAME} 后端已就绪。\n`)
      return 0
    }
    if (command.kind === 'supervisor') {
      supervisor.close()
      return dependencies.runChild(
        process.execPath,
        [
          path.join(dependencies.runtimeRoot, 'packages', 'operations-supervisor', 'dist', 'cli.js'),
          command.command,
          ...command.arguments,
          '--root', dependencies.runtimeRoot,
          '--profile', 'production',
        ],
        createInstalledChildEnvironment(dependencies.environment, environmentFile),
      )
    }
    await startApi(supervisor)
  } finally {
    supervisor.close()
  }

  const entry = command.kind === 'console'
    ? path.join(dependencies.runtimeRoot, 'apps', 'operations-console', 'dist', 'localConsoleEntry.js')
    : path.join(
        dependencies.runtimeRoot,
        'apps',
        'operations-console',
        'dist',
        'agent',
        'cli',
        'localAgentConsoleEntry.js',
      )
  return dependencies.runChild(
    process.execPath,
    [entry, ...command.arguments],
    createInstalledChildEnvironment(dependencies.environment, environmentFile),
  )
}

export function assertProductNodeRuntime(version: string): void {
  const major = Number(version.split('.')[0])
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(`安装版需要内置 Node 24+，当前误用了 Node ${version}。请修复安装后重试。`)
  }
}

export function parseInstalledCli(argv: readonly string[]): InstalledCliCommand {
  const [first, ...rest] = argv
  if (first === '--help' || first === '-h' || first === 'help') return { kind: 'help' }
  if (first === '--version' || first === '-V' || first === 'version') return { kind: 'version' }
  if (first === 'agent') return { kind: 'agent', arguments: rest }
  if (first === 'console') return { kind: 'console', arguments: rest }
  if (first === 'desktop') return { kind: 'desktop' }
  if (first === 'start') return { kind: 'start' }
  if (first === 'status' || first === 'logs') {
    return { kind: 'supervisor', command: first, arguments: rest }
  }
  // 无子命令和直接传 Agent 参数都进入 Agent，保持最短使用路径。
  return { kind: 'agent', arguments: [...argv] }
}

export function installedCliHelpText(platform: NodeJS.Platform = process.platform): string {
  const firstRunDescription = platform === 'darwin'
    ? '首次运行会自动准备并启动当前用户的本机后台服务。'
    : '首次运行会自动创建当前用户的 PostgreSQL、Worker、API 配置并启动 systemd 用户服务。'
  return [
    '地理智能平台安装版命令行',
    '',
    '用法：',
    '  geo-agent-platform                         自动启动后端并进入交互式 Agent',
    '  geo-agent-platform -p "分析杭州降雨"       执行一次任务',
    '  geo-agent-platform agent [参数]            Agent 完整参数',
    '  geo-agent-platform console                 打开本机运维台',
    '  geo-agent-platform start                   部署并启动本机后端',
    '  geo-agent-platform status                  查看后端状态',
    '  geo-agent-platform logs [服务]             查看后端日志',
    '  geo-agent-platform desktop                 启动后端并打开桌面工作台',
    '  geo-agent-platform --version               显示版本',
    '',
    firstRunDescription,
    '无需 Docker，也无需进入源码目录。',
    '',
  ].join('\n')
}

export async function launchInstalledDesktop(input: {
  ensureBackend: () => Promise<void>
  launchDesktop: () => Promise<void>
}): Promise<void> {
  await input.ensureBackend()
  await input.launchDesktop()
}

export function assertGraphicalDesktopSession(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'linux') return
  if (!environment.DISPLAY?.trim() && !environment.WAYLAND_DISPLAY?.trim()) {
    throw new Error('当前终端未连接图形会话；请从桌面终端运行，或从应用菜单打开工作台。')
  }
  if (!environment.DBUS_SESSION_BUS_ADDRESS?.trim() && !environment.XDG_RUNTIME_DIR?.trim()) {
    throw new Error('当前终端缺少用户会话总线；请在已登录的桌面会话中运行。')
  }
}

/**
 * 安装版桌面以受保护的 runtime manifest 为唯一运行时事实源。
 * CLI 会为后端加载 runtime.env，但这些值不能继承到 Electron，
 * 否则会被误判为用户尝试绕过 manifest 覆盖生产配置。
 */
export function createDesktopLaunchEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return projectNamedEnvironment(environment, DESKTOP_SESSION_ENVIRONMENT_NAMES)
}

/**
 * Agent、运维台和监督命令只接收交互字段与受保护文件路径。数据库地址、服务
 * 密钥和任何 API Key 即使存在于 runtime.env，也不会在读取值后进入子进程。
 */
export function createInstalledChildEnvironment(
  environment: NodeJS.ProcessEnv,
  serviceEnvironmentFile: string,
): NodeJS.ProcessEnv {
  if (!path.isAbsolute(serviceEnvironmentFile) || /[\0\r\n]/u.test(serviceEnvironmentFile)) {
    throw new Error('安装版服务配置文件路径无效。')
  }
  return {
    ...projectNamedEnvironment(environment, INSTALLED_CLI_CHILD_ENVIRONMENT_NAMES),
    GEO_AGENT_PLATFORM_SERVICE_ENV_FILE: serviceEnvironmentFile,
  }
}

/**
 * CLI 自身只保留服务启动和图形会话需要的固定字段。敏感名称先于取值判断，
 * 避免初始化 CLI 时读取宿主 Provider、签名或包管理凭据。
 */
export function projectInstalledCliEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const projected: NodeJS.ProcessEnv = {}
  for (const name of Object.keys(source)) {
    if (
      !DESKTOP_SESSION_ENVIRONMENT_NAMES.has(name)
      && !INSTALLED_CLI_CHILD_ENVIRONMENT_NAMES.has(name)
      && !name.startsWith('LC_')
    ) continue
    const value = source[name]
    if (value !== undefined) projected[name] = value
  }
  return projected
}

function projectNamedEnvironment(
  source: NodeJS.ProcessEnv,
  allowedNames: ReadonlySet<string>,
): NodeJS.ProcessEnv {
  const projected: NodeJS.ProcessEnv = {}
  for (const name of Object.keys(source)) {
    if (!allowedNames.has(name) && !name.startsWith('LC_')) continue
    const value = source[name]
    if (value !== undefined) projected[name] = value
  }
  return projected
}

async function ensureInstalledBackend(dependencies: InstalledCliDependencies): Promise<void> {
  // 后端运行时环境只在这条启动链内有效；不污染随后启动的桌面进程。
  const backendDependencies: InstalledCliDependencies = {
    ...dependencies,
    environment: { ...dependencies.environment },
  }
  const environmentFile = await prepareInstalledRuntime(backendDependencies)
  Object.assign(
    backendDependencies.environment,
    parseDotEnv(await readFile(environmentFile, 'utf8')),
  )
  backendDependencies.environment.NODE_ENV = 'production'
  backendDependencies.environment.GEO_AGENT_PLATFORM_ROOT = dependencies.runtimeRoot

  const supervisor = await connectSupervisor(backendDependencies)
  try {
    await startApi(supervisor)
  } finally {
    supervisor.close()
  }
}

async function prepareInstalledRuntime(dependencies: InstalledCliDependencies): Promise<string> {
  const resolution = await preparePackagedLocalRuntime({
    platform: process.platform,
    resourcesPath: path.dirname(dependencies.runtimeRoot),
    homeDirectory: dependencies.homeDirectory,
    environment: dependencies.environment,
    ...(dependencies.ownerUid === undefined ? {} : { ownerUid: dependencies.ownerUid }),
    systemRuntimeManifestPath: SYSTEM_RUNTIME_MANIFEST,
  })
  if (resolution) return resolution.serviceEnvironmentFile

  const configHome = dependencies.environment.XDG_CONFIG_HOME?.trim()
    || path.join(dependencies.homeDirectory, '.config')
  const environmentFile = path.join(configHome, PLATFORM_TECHNICAL_ID, 'runtime.env')
  try {
    await readFile(environmentFile, 'utf8')
    return environmentFile
  } catch {
    throw new Error('未找到可用的本机运行时配置；请重新安装应用或检查系统部署清单。')
  }
}

async function connectSupervisor(dependencies: InstalledCliDependencies): Promise<OperationsClient> {
  const projectRoot = dependencies.runtimeRoot
  const environment = dependencies.environment
  const paths = await resolveOperationsPaths({
    projectRoot,
    profile: 'production',
    ...(environment.RUNTIME_ROOT ? { runtimeRoot: environment.RUNTIME_ROOT } : {}),
    ...(environment.GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE
      ? { tokenFile: environment.GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE }
      : {}),
    ...(environment.GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE
      ? { rootSecretFile: environment.GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE }
      : {}),
  })
  const deadline = dependencies.now() + SUPERVISOR_READY_TIMEOUT_MS
  let lastError: unknown = null
  while (dependencies.now() < deadline) {
    try {
      const token = (await readFile(paths.tokenFile, 'utf8')).trim()
      return await OperationsClient.connect({
        endpoint: paths.endpoint,
        token,
        interactive: true,
        timeoutMs: 1_000,
      })
    } catch (error) {
      lastError = error
      await dependencies.delay(200)
    }
  }
  const reason = lastError instanceof Error ? lastError.message : '未知错误'
  throw new Error(`本机后端监督器未能就绪：${reason}`)
}

async function startApi(client: OperationsClient): Promise<void> {
  const operation = await client.operate({ action: 'start', target: 'api' })
  if (operation.outcome === 'failed') {
    throw new Error(operation.message || '本机 API 启动失败。')
  }
}

function productionDependencies(): InstalledCliDependencies {
  const runtimeRoot = fileURLToPath(new URL('../../../', import.meta.url))
  return {
    runtimeRoot,
    environment: projectInstalledCliEnvironment(process.env),
    homeDirectory: os.homedir(),
    ...(process.getuid ? { ownerUid: process.getuid() } : {}),
    stdout: process.stdout,
    stderr: process.stderr,
    runChild: (executable, arguments_, environment) => new Promise<number>((resolve, reject) => {
      const child = spawn(executable, [...arguments_], {
        cwd: runtimeRoot,
        env: environment,
        stdio: 'inherit',
      })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (signal) reject(new Error(`子进程被信号 ${signal} 终止。`))
        else resolve(code ?? 1)
      })
    }),
    launchDesktop: environment => new Promise<void>((resolve, reject) => {
      const desktopExecutable = resolveInstalledDesktopExecutable(process.platform, runtimeRoot)
      const child = spawn(desktopExecutable, [], {
        detached: true,
        env: environment,
        stdio: 'ignore',
      })
      let settled = false
      child.once('error', error => {
        if (settled) return
        settled = true
        reject(error)
      })
      child.once('exit', (code, signal) => {
        if (settled) return
        settled = true
        const outcome = signal ? `信号 ${signal}` : `退出码 ${code ?? 1}`
        reject(new Error(`桌面进程启动后立即终止（${outcome}）。`))
      })
      child.once('spawn', () => {
        setTimeout(() => {
          if (settled) return
          settled = true
          child.unref()
          resolve()
        }, DESKTOP_EARLY_EXIT_WINDOW_MS)
      })
    }),
    now: Date.now,
    delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  }
}

export function resolveInstalledDesktopExecutable(
  platform: NodeJS.Platform,
  runtimeRoot: string,
): string {
  if (platform === 'darwin') {
    const applicationRoot = path.resolve(runtimeRoot, '..', '..', '..')
    if (!applicationRoot.toLowerCase().endsWith('.app')) {
      throw new Error('安装版运行时不在有效的 macOS 应用包内。')
    }
    return path.join(
      applicationRoot,
      'Contents',
      'MacOS',
      PRODUCT_EXECUTABLE_BASENAME,
    )
  }
  if (platform === 'linux') return '/usr/bin/geo-agent-platform-desktop'
  throw new Error('当前操作系统不支持从安装版命令启动桌面工作台。')
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 原生基础设施配置解析
//
//   文件:       nativeInfrastructureConfig.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'

import type { OperationsProfile } from '@geo-agent-platform/shared-types/operations'
import { z } from 'zod'

import { environmentForService } from './environment.js'

const portSchema = z.coerce.number().int().min(1).max(65_535)
const nativeEnvironmentSchema = z.object({
  DATABASE_URL: z.string().url(),
  POSTGIS_PORT: portSchema,
  POSTGRES_BIN_DIR: z.string().min(1).optional(),
  POSTGRES_DATA_DIR: z.string().min(1).optional(),
}).passthrough()

interface PostgreSqlBinaries {
  postgres: string
  initdb: string
  pgCtl: string
  pgIsReady: string
  psql: string
  createdb: string
}

export interface NativeInfrastructureConfig {
  profile: OperationsProfile
  projectRoot: string
  runtimeRoot: string
  environment: NodeJS.ProcessEnv
  database: {
    url: string
    host: '127.0.0.1'
    port: number
    user: string
    password: string
    name: string
    dataDirectory: string
    binaries: PostgreSqlBinaries
  }
}

/**
 * 原生基础设施只接管本机私有 PostgreSQL 集群。远程数据库或与固定端口不一致的
 * DATABASE_URL 必须硬失败，避免 Supervisor 把外部数据库误认为自己的子进程。
 */
export function resolveNativeInfrastructureConfig(input: {
  profile: OperationsProfile
  projectRoot: string
  runtimeRoot: string
  environment: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): NativeInfrastructureConfig {
  // 直接执行基础设施入口时也先按服务契约投影；Zod 不得遍历并复制父进程中
  // 与 PostgreSQL 无关的 Provider、签名或系统凭据。
  const projectedEnvironment = environmentForService('infra', input.environment, {})
  const environment = nativeEnvironmentSchema.parse(projectedEnvironment)
  const platform = input.platform ?? process.platform
  const projectRoot = path.resolve(input.projectRoot)
  const runtimeRoot = path.resolve(input.runtimeRoot)
  const databaseUrl = new URL(environment.DATABASE_URL)
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new Error('DATABASE_URL 必须使用 postgres 或 postgresql 协议。')
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(databaseUrl.hostname)) {
    throw new Error('原生 infra 只能管理本机 PostgreSQL，DATABASE_URL 不得指向远程主机。')
  }
  const databasePort = Number(databaseUrl.port || 5432)
  if (databasePort !== environment.POSTGIS_PORT) {
    throw new Error('DATABASE_URL 端口必须与 POSTGIS_PORT 完全一致。')
  }
  const databaseUser = decodeURIComponent(databaseUrl.username)
  const databasePassword = decodeURIComponent(databaseUrl.password)
  const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\/+/u, ''))
  if (!validSqlIdentifier(databaseUser) || !validSqlIdentifier(databaseName)) {
    throw new Error('PostgreSQL 用户名和数据库名只能包含字母、数字与下划线，且不能以数字开头。')
  }
  if (!databasePassword) {
    throw new Error('原生 PostgreSQL 必须配置密码，不允许空密码启动。')
  }

  const postgresBinDirectory = resolvePostgresBinDirectory({
    configured: environment.POSTGRES_BIN_DIR,
    projectRoot,
    runtimeRoot,
    platform,
    environment: projectedEnvironment,
  })
  const executableSuffix = platform === 'win32' ? '.exe' : ''
  const postgresExecutable = (name: string): string => requireExecutable(
    path.join(postgresBinDirectory, `${name}${executableSuffix}`),
    `PostgreSQL ${name}`,
  )

  return {
    profile: input.profile,
    projectRoot,
    runtimeRoot,
    environment: projectedEnvironment,
    database: {
      url: environment.DATABASE_URL,
      host: '127.0.0.1',
      port: databasePort,
      user: databaseUser,
      password: databasePassword,
      name: databaseName,
      dataDirectory: resolveConfiguredPath(
        environment.POSTGRES_DATA_DIR ?? path.join(runtimeRoot, 'native', 'postgresql'),
        projectRoot,
      ),
      binaries: {
        postgres: postgresExecutable('postgres'),
        initdb: postgresExecutable('initdb'),
        pgCtl: postgresExecutable('pg_ctl'),
        pgIsReady: postgresExecutable('pg_isready'),
        psql: postgresExecutable('psql'),
        createdb: postgresExecutable('createdb'),
      },
    },
  }
}

function resolvePostgresBinDirectory(input: {
  configured: string | undefined
  projectRoot: string
  runtimeRoot: string
  platform: NodeJS.Platform
  environment: NodeJS.ProcessEnv
}): string {
  if (input.configured) {
    return requireDirectory(resolveConfiguredPath(input.configured, input.projectRoot), 'PostgreSQL bin')
  }

  // 安装器和开发环境都把经过校验的便携运行时放在同一固定位置。生产环境的
  // runtimeRoot 受操作系统 ACL 保护；开发环境则由当前用户拥有。
  const portableBin = path.join(
    input.runtimeRoot,
    'native',
    'postgresql-portable',
    'bin',
  )
  if (isFile(path.join(
    portableBin,
    input.platform === 'win32' ? 'postgres.exe' : 'postgres',
  ))) {
    return requireDirectory(portableBin, '便携 PostgreSQL bin')
  }

  const fromPath = findOnPath(
    input.platform === 'win32' ? 'postgres.exe' : 'postgres',
    input.environment.PATH,
  )
  if (fromPath) return path.dirname(fromPath)

  if (input.platform === 'win32') {
    const programFiles = input.environment.ProgramFiles
      ?? input.environment.PROGRAMFILES
      ?? input.environment.ProgramW6432
      ?? input.environment.PROGRAMW6432
    if (programFiles) {
      const installationRoot = path.join(programFiles, 'PostgreSQL')
      if (fs.existsSync(installationRoot)) {
        const versions = fs.readdirSync(installationRoot, { withFileTypes: true })
          .filter(entry => entry.isDirectory() && /^\d+(?:\.\d+)?$/u.test(entry.name))
          .sort((left, right) => Number(right.name) - Number(left.name))
        for (const version of versions) {
          const candidate = path.join(installationRoot, version.name, 'bin')
          if (fs.existsSync(path.join(candidate, 'postgres.exe'))) return candidate
        }
      }
    }
  }
  throw new Error('未找到原生 PostgreSQL。请安装 PostgreSQL/PostGIS，或配置 POSTGRES_BIN_DIR。')
}

function findOnPath(fileName: string, pathEnvironment?: string): string | null {
  for (const directory of (pathEnvironment ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory.replace(/^"|"$/gu, ''), fileName)
    if (isFile(candidate)) return candidate
  }
  return null
}

function resolveConfiguredPath(value: string, projectRoot: string): string {
  rejectControlCharacters(value)
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(projectRoot, value)
}

function rejectControlCharacters(value: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('基础设施路径不能包含控制字符。')
  }
}

function validSqlIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
}

function requireExecutable(value: string, label: string): string {
  if (!isFile(value)) throw new Error(`${label} 可执行文件不存在：${value}`)
  return path.resolve(value)
}

function requireDirectory(value: string, label: string): string {
  if (!fs.existsSync(value) || !fs.statSync(value).isDirectory()) {
    throw new Error(`${label}目录不存在：${value}`)
  }
  return path.resolve(value)
}

function isFile(value: string): boolean {
  return fs.existsSync(value) && fs.statSync(value).isFile()
}

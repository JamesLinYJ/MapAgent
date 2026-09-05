// +-------------------------------------------------------------------------
//
//   地理智能平台 - 受监督服务环境隔离
//
//   文件:       environment.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { OperationsServiceId } from '@geo-agent-platform/shared-types/operations'

const COMMON_NAMES = new Set([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'WINDIR',
  'TEMP', 'TMP', 'HOME', 'USER', 'USERNAME', 'LOGNAME', 'USERPROFILE',
  'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'ProgramFiles', 'PROGRAMFILES', 'ProgramW6432', 'PROGRAMW6432',
  'SHELL', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'NODE_ENV',
  'GEO_AGENT_PLATFORM_ROOT', 'RUNTIME_ROOT', 'PYTHONIOENCODING', 'PYTHONUTF8',
])

const PREFIXES: Record<OperationsServiceId, readonly string[]> = {
  infra: ['DATABASE_', 'POSTGRES_', 'POSTGIS_', 'RUNTIME_'],
  worker: ['WORKER_', 'PYTHON', 'GDAL_', 'PROJ_', 'RUNTIME_', 'POSTGIS_', 'DATA_'],
  api: [
    'API_', 'APP_', 'WORKER_', 'DATABASE_', 'POSTGRES_', 'POSTGIS_',
    'BETTER_AUTH_', 'BOOTSTRAP_', 'CSRF_', 'TRUSTED_',
    'OPENAI_', 'DEEPSEEK_', 'ANTHROPIC_', 'GEMINI_', 'OLLAMA_', 'MODEL_', 'DEFAULT_MODEL_',
    'GATEWAY_', 'AMAP_', 'OPEN_METEO_', 'VALHALLA_', 'ROUTING_', 'TIANDITU_',
    'ENABLED_', 'DEVELOPER_', 'SEED_', 'SCHEDULED_', 'SANDBOX_', 'RUNTIME_',
    'MAX_', 'MAP_', 'USAGE_', 'AZURE_SPEECH_', 'GEO_AGENT_PLATFORM_MEMORY_', 'RIPGREP_', 'RG_',
    'GEO_AGENT_PLATFORM_RELEASE_', 'OTEL_', 'LOG_',
  ],
}

const FORBIDDEN_PREFIXES = [
  'GEO_AGENT_PLATFORM_SUPERVISOR_',
  'GEO_AGENT_PLATFORM_LOCAL_ROOT_',
]

const PROVIDER_CREDENTIAL_NAME = /^(?:OPENAI|DEEPSEEK|ANTHROPIC|GEMINI|OLLAMA|MODEL|DEFAULT_MODEL)_(?:.*_)?(?:API_KEY|TOKEN|SECRET|PASSWORD)$/iu
const SECRET_ENVIRONMENT_NAME = /_(?:KEY|TOKEN|SECRET|PASSWORD)$/iu
const EXPLICIT_CREDENTIAL_SOURCE_NAMES = new Set([
  'CSC_LINK',
  'WIN_CSC_LINK',
  'DOCKER_AUTH_CONFIG',
  'NPM_CONFIG__AUTH',
  'NPM_CONFIG_USERCONFIG',
])
const SUPERVISOR_PATH_NAMES = new Set([
  'GEO_AGENT_PLATFORM_SERVICE_ENV_FILE',
  'GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE',
  'GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE',
  'GEO_AGENT_PLATFORM_OPERATORS_PRINCIPAL',
])
const SERVICE_SECRET_NAMES: Record<OperationsServiceId, ReadonlySet<string>> = {
  infra: new Set(),
  worker: new Set(['WORKER_SHARED_SECRET']),
  api: new Set([
    'BETTER_AUTH_SECRET',
    'WORKER_SHARED_SECRET',
    'AZURE_SPEECH_KEY',
    'TIANDITU_API_KEY',
  ]),
}

export function isProviderCredentialEnvironmentName(name: string): boolean {
  return PROVIDER_CREDENTIAL_NAME.test(name)
}

export function isSystemCredentialEnvironmentName(name: string): boolean {
  return SECRET_ENVIRONMENT_NAME.test(name) || EXPLICIT_CREDENTIAL_SOURCE_NAMES.has(name)
}

export function isSupportedServiceSecretEnvironmentName(name: string): boolean {
  return Object.values(SERVICE_SECRET_NAMES).some(names => names.has(name))
}

/**
 * 构建、命令行和其它非服务子进程只继承非敏感环境。先判断变量名，再读取值，
 * 避免为了清洗子进程环境反而访问系统 Provider、签名或包管理凭据。
 */
export function environmentWithoutSystemCredentials(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const projected: NodeJS.ProcessEnv = {}
  for (const name of Object.keys(source)) {
    if (isProviderCredentialEnvironmentName(name) || isSystemCredentialEnvironmentName(name)) continue
    const value = source[name]
    if (value !== undefined) projected[name] = value
  }
  return projected
}

/** 仅供 ACL 等系统工具使用，不向辅助进程暴露数据库或服务配置。 */
export function utilityProcessEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const projected: NodeJS.ProcessEnv = {}
  for (const name of Object.keys(source)) {
    if (isProviderCredentialEnvironmentName(name) || isSystemCredentialEnvironmentName(name)) continue
    const allowed = COMMON_NAMES.has(name)
      || name === 'GEO_AGENT_PLATFORM_OPERATORS_PRINCIPAL'
      || name === 'LANG'
      || name.startsWith('LC_')
    if (!allowed) continue
    const value = source[name]
    if (value !== undefined) projected[name] = value
  }
  return projected
}

/**
 * 监督器只投影服务启动需要的固定字段。未知密钥名在读取值之前被排除；
 * 数据库、认证、Worker 和当前产品服务的必需密钥按精确名称注入。
 */
export function projectSupervisorEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const projected: NodeJS.ProcessEnv = {}
  for (const name of Object.keys(source)) {
    if (isProviderCredentialEnvironmentName(name)) continue
    const requiredSecret = isSupportedServiceSecretEnvironmentName(name)
    if (isSystemCredentialEnvironmentName(name) && !requiredSecret) continue
    const allowed = requiredSecret
      || SUPERVISOR_PATH_NAMES.has(name)
      || COMMON_NAMES.has(name)
      || Object.values(PREFIXES).some(prefixes => prefixes.some(prefix => name.startsWith(prefix)))
    if (!allowed) continue
    const value = source[name]
    if (value !== undefined) projected[name] = value
  }
  return projected
}

export function environmentForService(
  serviceId: OperationsServiceId,
  source: NodeJS.ProcessEnv,
  additions: Record<string, string>,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const name of Object.keys(source)) {
    if (
      isProviderCredentialEnvironmentName(name)
      || FORBIDDEN_PREFIXES.some(prefix => name.startsWith(prefix))
    ) continue
    if (isSystemCredentialEnvironmentName(name) && !SERVICE_SECRET_NAMES[serviceId].has(name)) continue
    const value = source[name]
    if (value === undefined) continue
    if (COMMON_NAMES.has(name) || PREFIXES[serviceId].some(prefix => name.startsWith(prefix))) {
      result[name] = value
    }
  }
  for (const [name, value] of Object.entries(additions)) result[name] = value
  return result
}

/**
 * concurrently 会把父进程环境先合并到 command.env。对不在白名单中的键显式写入
 * undefined，使 Node spawn 真正删除这些键，而不是让执行适配器绕过隔离边界。
 */
export function environmentForConcurrently(
  parent: NodeJS.ProcessEnv,
  allowed: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...allowed }
  for (const name of Object.keys(parent)) {
    if (!(name in allowed)) result[name] = undefined
  }
  return result
}

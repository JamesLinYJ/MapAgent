// +-------------------------------------------------------------------------
//
//   地理智能平台 - 生产监督器环境校验器
//
//   文件:       validate-production-environment.mjs
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

const options = parseOptions(process.argv.slice(2))
const environmentFile = requireAbsolutePath(options, 'file')
const projectRoot = requireAbsolutePath(options, 'project-root')
const runtimeRoot = requireAbsolutePath(options, 'runtime-root')
const supervisorTokenFile = requireAbsolutePath(options, 'supervisor-token-file')
const apiBaseUrl = normalizeHttpOrigin(requireOption(options, 'api-base-url'), 'api-base-url')

const stat = lstatSync(environmentFile)
if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
  throw new Error('生产环境文件必须是单链接普通文件。')
}
if (stat.size <= 0 || stat.size > 256 * 1_024) {
  throw new Error('生产环境文件大小必须在 1 字节到 256 KiB 之间。')
}

const environment = parseEnvironment(readFileSync(environmentFile, 'utf8'))
const requiredNames = [
  'NODE_ENV',
  'GEO_AGENT_PLATFORM_ROOT',
  'RUNTIME_ROOT',
  'GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE',
  'GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE',
  'POSTGIS_PORT',
  'WORKER_PORT',
  'API_HOST',
  'API_PORT',
  'WORKER_PYTHON',
  'DATABASE_URL',
  'WORKER_URL',
  'APP_BASE_URL',
  'BETTER_AUTH_URL',
  'BETTER_AUTH_SECRET',
  'WORKER_SHARED_SECRET',
  'ENABLED_TOOL_PROVIDERS',
]
for (const name of requiredNames) {
  if (!environment.get(name)?.trim()) throw new Error(`生产环境缺少 ${name}。`)
}

if (environment.get('NODE_ENV') !== 'production') {
  throw new Error('NODE_ENV 必须为 production。')
}
assertEquivalentPath(environment.get('GEO_AGENT_PLATFORM_ROOT'), projectRoot, 'GEO_AGENT_PLATFORM_ROOT')
assertEquivalentPath(environment.get('RUNTIME_ROOT'), runtimeRoot, 'RUNTIME_ROOT')
assertEquivalentPath(
  environment.get('GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE'),
  supervisorTokenFile,
  'GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE',
)
for (const name of ['GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE', 'WORKER_PYTHON']) {
  const value = environment.get(name)
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} 必须是绝对路径。`)
}

const apiHost = environment.get('API_HOST')
if (!apiHost || !isLoopbackHost(apiHost)) {
  throw new Error('API_HOST 必须绑定本机回环地址。')
}
const apiPort = parsePort(environment.get('API_PORT'), 'API_PORT')
assertLoopbackOrigin(apiBaseUrl, apiPort, 'Desktop apiBaseUrl')
if (normalizeHttpOrigin(environment.get('APP_BASE_URL'), 'APP_BASE_URL') !== apiBaseUrl) {
  throw new Error('APP_BASE_URL 必须与 Desktop apiBaseUrl 一致。')
}
if (normalizeHttpOrigin(environment.get('BETTER_AUTH_URL'), 'BETTER_AUTH_URL') !== apiBaseUrl) {
  throw new Error('BETTER_AUTH_URL 必须与 Desktop apiBaseUrl 一致。')
}

const workerPort = parsePort(environment.get('WORKER_PORT'), 'WORKER_PORT')
assertLoopbackOrigin(
  normalizeHttpOrigin(environment.get('WORKER_URL'), 'WORKER_URL'),
  workerPort,
  'WORKER_URL',
)
parsePort(environment.get('POSTGIS_PORT'), 'POSTGIS_PORT')

const databaseUrl = new URL(requireEnvironment(environment, 'DATABASE_URL'))
if (databaseUrl.protocol !== 'postgresql:' && databaseUrl.protocol !== 'postgres:') {
  throw new Error('DATABASE_URL 必须使用 PostgreSQL 协议。')
}
if (/replace|example|changeme/iu.test(databaseUrl.href)) {
  throw new Error('DATABASE_URL 仍包含示例占位值。')
}
for (const secretName of ['BETTER_AUTH_SECRET', 'WORKER_SHARED_SECRET']) {
  const secret = requireEnvironment(environment, secretName)
  if (secret.length < 32 || /replace|example|changeme/iu.test(secret)) {
    throw new Error(`${secretName} 必须是至少 32 字符且不含示例占位值的生产密钥。`)
  }
}

const providers = requireEnvironment(environment, 'ENABLED_TOOL_PROVIDERS')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
if (providers.length === 0 || new Set(providers).size !== providers.length) {
  throw new Error('ENABLED_TOOL_PROVIDERS 必须是非空且不重复的 provider 列表。')
}

process.stdout.write(`生产环境校验通过：${environmentFile}\n`)

function parseOptions(arguments_) {
  const parsed = new Map()
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index]
    const value = arguments_[index + 1]
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`无效参数：${name ?? '<missing>'}`)
    }
    const normalizedName = name.slice(2)
    if (parsed.has(normalizedName)) throw new Error(`重复参数：${name}`)
    parsed.set(normalizedName, value)
  }
  return parsed
}

function requireOption(parsed, name) {
  const value = parsed.get(name)?.trim()
  if (!value) throw new Error(`缺少 --${name}。`)
  return value
}

function requireAbsolutePath(parsed, name) {
  const value = requireOption(parsed, name)
  if (!path.isAbsolute(value)) throw new Error(`--${name} 必须是绝对路径。`)
  return path.normalize(value)
}

function parseEnvironment(source) {
  const parsed = new Map()
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) throw new Error(`生产环境第 ${index + 1} 行无效。`)
    const name = trimmed.slice(0, separator).trim()
    let value = trimmed.slice(separator + 1).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`生产环境第 ${index + 1} 行变量名无效。`)
    }
    if (parsed.has(name)) throw new Error(`生产环境包含重复变量 ${name}。`)
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    parsed.set(name, value)
  }
  return parsed
}

function requireEnvironment(environment, name) {
  const value = environment.get(name)?.trim()
  if (!value) throw new Error(`生产环境缺少 ${name}。`)
  return value
}

function normalizeHttpOrigin(value, name) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} 必须是绝对 URL。`)
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error(`${name} 必须是不含凭据、路径、查询参数或片段的 HTTP/HTTPS 源站地址。`)
  }
  return url.origin
}

function parsePort(value, name) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} 必须是 1–65535 的整数。`)
  }
  return parsed
}

function assertLoopbackOrigin(origin, expectedPort, name) {
  const url = new URL(origin)
  if (!isLoopbackHost(url.hostname)) throw new Error(`${name} 必须使用本机回环地址。`)
  const effectivePort = url.port
    ? Number(url.port)
    : (url.protocol === 'https:' ? 443 : 80)
  if (effectivePort !== expectedPort) throw new Error(`${name} 端口必须为 ${expectedPort}。`)
}

function isLoopbackHost(hostname) {
  const normalized = hostname.trim().toLowerCase()
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]'
}

function assertEquivalentPath(configured, expected, name) {
  if (!configured || !path.isAbsolute(configured)) throw new Error(`${name} 必须是绝对路径。`)
  const normalize = value => {
    const normalized = path.normalize(value)
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  if (normalize(configured) !== normalize(expected)) {
    throw new Error(`${name} 必须与安装参数一致。`)
  }
}

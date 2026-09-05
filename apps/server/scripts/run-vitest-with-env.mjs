// +-------------------------------------------------------------------------
//
//   地理智能平台 - Vitest 安全环境启动器
//
//   文件:       run-vitest-with-env.mjs
//
//   日期:       2026年07月02日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const defaults = {
  APP_BASE_URL: 'http://127.0.0.1:8000',
  BETTER_AUTH_SECRET: 'test-only-better-auth-secret-change-before-production',
  BETTER_AUTH_ALLOW_SIGN_UP: 'true',
  BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
  BETTER_AUTH_MIN_PASSWORD_LENGTH: '12',
  CSRF_HEADER_NAME: 'x-geo-agent-platform-csrf',
  TRUSTED_ORIGINS: 'geo-agent-platform://app,com.geo-agent-platform.desktop://auth/callback',
  WORKER_SHARED_SECRET: 'test-only-worker-shared-secret-change-before-production',
}

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value
}
if (!process.env.BETTER_AUTH_URL) process.env.BETTER_AUTH_URL = process.env.APP_BASE_URL

const __dirname = path.dirname(fileURLToPath(import.meta.url))
if (!process.env.GEO_AGENT_PLATFORM_MEMORY_BASE_DIR) {
  process.env.GEO_AGENT_PLATFORM_MEMORY_BASE_DIR = path.resolve(__dirname, '..', '.tmp-test-memory')
}
const vitestEntrypoint = path.resolve(__dirname, '..', '..', '..', 'node_modules', 'vitest', 'vitest.mjs')
const vitestArgs = process.argv.slice(2)
if (!vitestArgs.some(argument => argument === '--maxWorkers' || argument.startsWith('--maxWorkers='))) {
  // 文件载荷测试会执行真实 fsync/rename；限制并发可避免大量 worker 同时争用 Windows I/O。
  vitestArgs.push(`--maxWorkers=${process.env.GEO_AGENT_PLATFORM_TEST_WORKERS ?? '4'}`)
}

const child = spawn(process.execPath, [vitestEntrypoint, ...vitestArgs], {
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', code => process.exit(code ?? 1))

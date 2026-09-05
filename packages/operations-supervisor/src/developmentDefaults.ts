// +-------------------------------------------------------------------------
//
//   地理智能平台 - 开发环境默认值
//
//   文件:       developmentDefaults.ts
//
//   日期:       2026年08月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import path from 'node:path'
import {
  PLATFORM_DESKTOP_APP_ORIGIN,
  PLATFORM_DESKTOP_AUTH_CALLBACK_URL,
} from '@geo-agent-platform/shared-types/product-identity'

/**
 * 装配开发启动器和直接监督器 CLI 共享的环境契约。
 *
 * dotenv 在调用方中先加载，因此这里只使用 ??= 写入默认值：外部环境和
 * .env 的显式配置优先于默认值。项目根是当前启动边界，始终投影为调用方
 * 解析出的根目录；RUNTIME_ROOT 则先读取已配置值，再解析为绝对路径。
 */
export function applyDevelopmentDefaults(projectRoot: string): string {
  const resolvedProjectRoot = path.resolve(projectRoot)
  const runtimeRoot = resolveDevelopmentRuntimeRoot(resolvedProjectRoot, process.env.RUNTIME_ROOT)
  const defaults: Record<string, string> = {
    NODE_ENV: 'development',
    POSTGIS_PORT: '55432',
    WORKER_PORT: '8012',
    API_PORT: '8000',
    WORKER_PYTHON: process.platform === 'win32' ? 'python.exe' : 'python3',
    API_HOST: '127.0.0.1',
  }
  for (const [name, value] of Object.entries(defaults)) process.env[name] ??= value

  process.env.GEO_AGENT_PLATFORM_ROOT = resolvedProjectRoot
  process.env.RUNTIME_ROOT = runtimeRoot
  process.env.DATABASE_URL ??= `postgresql://geo_agent:geo_agent@127.0.0.1:${process.env.POSTGIS_PORT}/geo_agent`
  process.env.WORKER_URL ??= `http://127.0.0.1:${process.env.WORKER_PORT}`
  process.env.APP_BASE_URL ??= `http://127.0.0.1:${process.env.API_PORT}`
  process.env.BETTER_AUTH_URL ??= process.env.APP_BASE_URL
  process.env.TRUSTED_ORIGINS ??= (
    `${PLATFORM_DESKTOP_APP_ORIGIN},${PLATFORM_DESKTOP_AUTH_CALLBACK_URL}`
  )
  process.env.BOOTSTRAP_ADMIN_EMAIL ??= 'admin@example.com'
  process.env.GEO_AGENT_PLATFORM_DESKTOP_AUTO_AUTH ??= 'true'
  process.env.GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE ??= path.join(runtimeRoot, 'ops', 'supervisor.token')
  process.env.GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE ??= path.join(runtimeRoot, 'ops', 'local-root.secret')
  return runtimeRoot
}

export function resolveDevelopmentRuntimeRoot(
  projectRoot: string,
  configuredRuntimeRoot?: string,
): string {
  const configured = configuredRuntimeRoot?.trim()
  return path.resolve(projectRoot, configured || 'runtime')
}

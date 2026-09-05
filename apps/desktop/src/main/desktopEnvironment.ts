// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 非敏感环境投影
//
//   文件:       desktopEnvironment.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

const DESKTOP_ENVIRONMENT_KEYS = [
  'API_PORT',
  'APP_BASE_URL',
  'DESKTOP_RENDERER_PORT',
  'GEO_AGENT_PLATFORM_DESKTOP_AUTO_AUTH',
  'GEO_AGENT_PLATFORM_ROOT',
  'GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE',
  'ProgramData',
  'RUNTIME_ROOT',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
] as const

/**
 * 桌面进程只读取启动和路径解析所需的固定非敏感字段。调用方不得把完整
 * process.env 传给日志、诊断、认证存储或子进程。
 */
export function projectDesktopEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const projected: NodeJS.ProcessEnv = {}
  for (const name of DESKTOP_ENVIRONMENT_KEYS) {
    const value = source[name]
    if (value !== undefined) projected[name] = value
  }
  return projected
}

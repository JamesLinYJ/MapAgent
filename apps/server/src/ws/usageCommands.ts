// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 用量统计命令
//
//   文件:       usageCommands.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AuthContext } from '../security/types.js'
import type { WsCommandRegistry } from './commandRegistry.js'

export function registerUsageCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'usage:summary',
    handler: (_payload, context) => context.dependencies.usageStats.summarizeWorkspace(requireAuth(context.auth)),
  })
  registry.register({
    type: 'usage:thread-summary',
    handler: (payload, context) => {
      requireAuth(context.auth)
      return context.dependencies.usageStats.summarizeThread(payload.threadId)
    },
  })
}

function requireAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 子智能体控制命令
//
//   文件:       subAgentCommands.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { SubAgentState } from '../schemas/types.js'
import type { AuthContext } from '../security/types.js'
import type { WsCommandRegistry } from './commandRegistry.js'

export function registerSubAgentCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'subagent:list',
    handler: (payload, context) => ({
      items: context.dependencies.store.getRun(payload.runId).state.subAgents,
    }),
  })

  registry.register({
    type: 'subagent:get',
    handler: async (payload, context) => {
      const run = context.dependencies.store.getRun(payload.runId)
      const agent = requireSubAgent(run.state.subAgents, payload.agentId)
      const events = (await context.dependencies.store.listEvents(payload.runId))
        .filter(event => event.payload.agentId === payload.agentId || event.payload.fromAgentId === payload.agentId)
      return { agent, events }
    },
  })

  registry.register({
    type: 'subagent:follow-up',
    handler: (payload, context) => context.dependencies.runtime.followUpSubAgent({
      runId: payload.runId,
      agentId: payload.agentId,
      controlId: payload.followUpId,
      content: payload.content,
      createdByUserId: requireAuth(context.auth).userId,
    }),
  })

  registry.register({
    type: 'subagent:cancel',
    handler: (payload, context) => context.dependencies.runtime.cancelSubAgent({
      runId: payload.runId,
      agentId: payload.agentId,
      controlId: payload.cancellationId,
      content: payload.reason ?? '用户取消了子智能体任务。',
      createdByUserId: requireAuth(context.auth).userId,
    }),
  })
}

function requireSubAgent(subAgents: SubAgentState[], agentId: string): SubAgentState {
  const agent = subAgents.find(candidate => candidate.agentId === agentId)
  if (!agent) throw new Error(`子 Agent '${agentId}' 不存在。`)
  return agent
}

function requireAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}

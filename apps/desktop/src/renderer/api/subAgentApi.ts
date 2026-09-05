// +-------------------------------------------------------------------------
//
//   地理智能平台 - 子智能体控制 API
//
//   文件:       subAgentApi.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { requestControl } from './transport'

export function getSubAgent(runId: string, agentId: string) {
  return requestControl('subagent:get', { runId, agentId })
}

export function followUpSubAgent(runId: string, agentId: string, content: string, followUpId: string) {
  return requestControl('subagent:follow-up', { runId, agentId, content, followUpId })
}

export function cancelSubAgent(runId: string, agentId: string, cancellationId: string, reason?: string) {
  return requestControl('subagent:cancel', { runId, agentId, cancellationId, reason })
}

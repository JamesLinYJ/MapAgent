// +-------------------------------------------------------------------------
//
//   地理智能平台 - OpenAI Agents SDK segment 输入轮换信号
//
//   文件:       AgentsSdkSegmentRotation.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import type { AgentInputItem } from '@openai/agents'

export interface AgentsSdkSegmentInput {
  items: AgentInputItem[]
  objectiveRevision: number
  leaseId: string
}

/**
 * callModelInputFilter 已晚于 SDK 的 pending-input admission。发现新输入时
 * 结束尚未发包的当前 segment，再用公开 RunState.addInput() 恢复下一段。
 */
export class AgentsSdkSegmentRotation extends Error {
  constructor(readonly input: AgentsSdkSegmentInput) {
    super('Agent Runner segment 收到新的持久输入')
    this.name = 'AgentsSdkSegmentRotation'
  }
}

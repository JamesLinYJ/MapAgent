// +-------------------------------------------------------------------------
//
//   地理智能平台 - OpenAI Agents SDK 公共状态防腐边界
//
//   文件:       AgentsSdkBridge.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import {
  Agent,
  RunContext,
  RunState,
  type AgentInputItem,
  type RunToolApprovalItem,
} from '@openai/agents'

export type AgentsSdkState<TContext> = RunState<TContext, Agent<TContext>>

export interface RestoreAgentsSdkStateInput<TContext> {
  agent: Agent<TContext>
  context: TContext
  publicSerializedState: string
}

/**
 * 业务运行时只能通过这里操作 SDK RunState。序列化字符串保持 opaque；
 * 本模块不解析、探测或依赖 SDK 的内部 JSON 字段。
 */
export class AgentsSdkBridge {
  isState<TContext>(value: unknown): value is AgentsSdkState<TContext> {
    return value instanceof RunState
  }

  serialize<TContext>(state: AgentsSdkState<TContext>): string {
    return state.toString()
  }

  restore<TContext>(input: RestoreAgentsSdkStateInput<TContext>): Promise<AgentsSdkState<TContext>> {
    return RunState.fromStringWithContext(
      input.agent,
      input.publicSerializedState,
      new RunContext(input.context),
      { contextStrategy: 'replace' },
    )
  }

  stageInput<TContext>(
    state: AgentsSdkState<TContext>,
    items: readonly AgentInputItem[],
  ): void {
    state.addInput([...structuredClone(items)])
  }

  interruptions<TContext>(state: AgentsSdkState<TContext>): RunToolApprovalItem[] {
    return state.getInterruptions()
  }

  resolveApproval<TContext>(input: {
    state: AgentsSdkState<TContext>
    interruption: RunToolApprovalItem
    approved: boolean
    rejectionMessage: string
  }): void {
    if (input.approved) {
      input.state.approve(input.interruption)
      return
    }
    input.state.reject(input.interruption, { message: input.rejectionMessage })
  }
}

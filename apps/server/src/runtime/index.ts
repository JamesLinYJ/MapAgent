// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runtime Bounded Context
//
//   文件:       runtime/index.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       Claude Code:Opus 4.8
// --------------------------------------------------------------------------

// Agent 生命周期管理——创建 run、提交消息、处理 plan mode、工具审批。
// 通过接口与其他 context 通信，不直接依赖文件系统或 HTTP 层。

export type { ConversationPayloadStorage } from '../store/conversationPayloadStorage.js'
export interface AgentRuntime {
  startRun(input: {
    sessionId: string
    threadId: string
    userQuery: string
    executionMode?: 'auto' | 'plan'
  }): Promise<RunHandle>
}

export interface RunHandle {
  runId: string
  status: 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed'
  cancel(): Promise<void>
  respondApproval(decision: 'approved' | 'denied'): Promise<void>
}

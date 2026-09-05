// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行输入会话投影
//
//   文件:       runInputConversationItem.ts
//
//   日期:       2026年08月10日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { conversationItemSchema, type ConversationItem, type RunSteeringRecord } from '../schemas/types.js'

// platform_run_inputs 是交付事实源；ConversationItem 是与状态事务一起追加的
// 可重建 UI 投影。所有写路径共用此映射，避免 ack 后崩溃留下 leased 假象。
export function runInputConversationItem(record: RunSteeringRecord): ConversationItem {
  return conversationItemSchema.parse({
    itemId: record.itemId,
    itemType: 'message',
    runId: record.runId,
    threadId: record.threadId,
    turnId: record.turnId,
    callId: null,
    role: 'user',
    body: record.content,
    name: null,
    arguments: null,
    output: null,
    isError: false,
    phase: null,
    status: record.status,
    metadata: {
      steeringId: record.steeringId,
      transcriptEntryId: record.entryId,
      inputSequence: record.inputSequence,
      leaseId: record.leaseId,
      modelRequestId: record.modelRequestId,
    },
    timestamp: record.queuedAt,
  })
}

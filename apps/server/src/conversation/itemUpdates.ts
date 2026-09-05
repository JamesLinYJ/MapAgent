// +-------------------------------------------------------------------------
//
//   地理智能平台 - ConversationItem 服务端写入事件
//
//   文件:       itemUpdates.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ConversationItem } from '../schemas/types.js'

export interface ReplaceConversationItem {
  updateType: 'replace_item'
  item: ConversationItem
}

export interface AppendConversationItemBody {
  updateType: 'append_body'
  runId: string
  threadId: string | null
  itemId: string
  text: string
}

/** RunStore 在唯一校验边界内为这些本地事件分配 streamId/cursor。 */
export type ConversationItemWrite = ReplaceConversationItem | AppendConversationItemBody

export type ConversationItemStoreUpdate = ConversationItem | ConversationItemWrite

export function isConversationItemWrite(
  update: ConversationItemStoreUpdate,
): update is ConversationItemWrite {
  return 'updateType' in update
}

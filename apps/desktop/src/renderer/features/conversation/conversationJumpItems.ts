// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话跳转索引
//
//   文件:       conversationJumpItems.ts
//
//   日期:       2026年07月09日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { ConversationEntry } from '@geo-agent-platform/conversation-presentation'

export interface ConversationJumpItem {
  id: string
  anchorId: string
  label: string
  sequence: number
}

export function buildConversationJumpItems(conversation: ReadonlyArray<ConversationEntry>): ConversationJumpItem[] {
  return conversation
    .filter((entry) => entry.kind === 'message' && entry.role === 'user' && entry.body.trim())
    .map((entry, index) => ({
      id: entry.id,
      anchorId: conversationJumpAnchorId(entry.id),
      label: compactJumpLabel(entry.body),
      sequence: index + 1,
    }))
}

export function conversationJumpAnchorId(entryId: string) {
  return `cc-jump-${entryId.replace(/[^a-zA-Z0-9_-]/gu, '-')}`
}

function compactJumpLabel(value: string) {
  const text = value.replace(/\s+/gu, ' ').trim()
  if (text.length <= 32) return text
  return `${text.slice(0, 31)}…`
}

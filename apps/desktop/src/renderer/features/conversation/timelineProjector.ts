// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话时间线投影器
//
//   文件:       timelineProjector.ts
//
//   日期:       2026年06月25日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 服务端 transcript 是完整 thread 基线，当前 run stream 是实时 overlay。
// 这里集中处理去重和排序，避免 AppShell 根据局部状态临时拼出错序时间线。

import type { ConversationItem } from '@geo-agent-platform/shared-types'
import { projectConversationItems } from '@geo-agent-platform/conversation-presentation'

export function projectTimeline(canonical: ConversationItem[], liveOverlay: ConversationItem[]): ConversationItem[] {
  return projectConversationItems(canonical, liveOverlay)
}

export const mergeConversationItems = projectTimeline

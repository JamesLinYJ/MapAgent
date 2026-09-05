// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话跳转轨道测试
//
//   文件:       conversationJumpRail.test.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import {
  buildConversationJumpItems,
  conversationJumpAnchorId,
} from '../features/conversation/conversationJumpItems'
import { conversationJumpRailReducer } from '../features/conversation/conversationJumpRailState'
import {
  CONVERSATION_TIMELINE_GAP_PX,
  firstVisibleConversationIndex,
} from '../features/conversation/conversationTimelineVirtualization'
import type { ConversationEntry } from '@geo-agent-platform/conversation-presentation'

describe('buildConversationJumpItems', () => {
  it('derives jump items only from user messages', () => {
    const entries: ConversationEntry[] = [
      entry({ id: 'u1', role: 'user', body: '第一条问题' }),
      entry({ id: 'a1', role: 'assistant', body: '回答' }),
      {
        id: 'tool:call-1',
        kind: 'command_batch',
        timestamp: '2026-07-08T00:00:02.000Z',
        title: '工具',
        body: '完成',
        status: 'completed',
      },
      entry({ id: 'u2', role: 'user', body: '  第二条问题  ' }),
    ]

    expect(buildConversationJumpItems(entries)).toEqual([
      {
        id: 'u1',
        anchorId: 'cc-jump-u1',
        label: '第一条问题',
        sequence: 1,
      },
      {
        id: 'u2',
        anchorId: 'cc-jump-u2',
        label: '第二条问题',
        sequence: 2,
      },
    ])
  })

  it('normalizes labels and anchor ids', () => {
    const [item] = buildConversationJumpItems([
      entry({
        id: 'thread/message:1',
        role: 'user',
        body: '请继续基于同一批资料，回答接下来 30 分钟降水趋势有没有增强，并说明最后几个时次是否适合生成风险区划图。',
      }),
    ])

    expect(item?.anchorId).toBe('cc-jump-thread-message-1')
    expect(item?.label).toBe('请继续基于同一批资料，回答接下来 30 分钟降水趋势有没有增强…')
  })
})

describe('conversationJumpAnchorId', () => {
  it('keeps DOM ids stable and safe', () => {
    expect(conversationJumpAnchorId('message:abc/123')).toBe('cc-jump-message-abc-123')
  })
})

describe('conversationJumpRailReducer', () => {
  it('keeps a clicked index open after pointer exit until it is dismissed', () => {
    const hovered = conversationJumpRailReducer({ hovered: false, pinned: false }, { type: 'enter' })
    const pinned = conversationJumpRailReducer(hovered, { type: 'toggle-pin' })
    const afterPointerExit = conversationJumpRailReducer(pinned, { type: 'leave' })

    expect(afterPointerExit).toEqual({ hovered: false, pinned: true })
    expect(conversationJumpRailReducer(afterPointerExit, { type: 'dismiss' })).toEqual({
      hovered: false,
      pinned: false,
    })
  })
})

describe('conversation timeline virtualization', () => {
  it('keeps the timeline spacing used by the connector rail', () => {
    expect(CONVERSATION_TIMELINE_GAP_PX).toBe(16)
  })

  it('ignores overscanned rows that are already above the viewport', () => {
    const virtualItems = [
      { index: 0, end: 112 },
      { index: 1, end: 240 },
      { index: 2, end: 368 },
    ]

    expect(firstVisibleConversationIndex(virtualItems, 240)).toBe(2)
  })
})

function entry(params: { id: string; role: 'user' | 'assistant'; body: string }): ConversationEntry {
  return {
    id: params.id,
    kind: 'message',
    timestamp: '2026-07-08T00:00:00.000Z',
    title: params.role === 'user' ? '用户' : '回答',
    body: params.body,
    status: 'completed',
    role: params.role,
  }
}

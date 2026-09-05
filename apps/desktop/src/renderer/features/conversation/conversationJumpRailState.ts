// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话跳转轨道交互状态
//
//   文件:       conversationJumpRailState.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

export interface ConversationJumpRailInteraction {
  hovered: boolean
  pinned: boolean
}

export type ConversationJumpRailAction =
  | { type: 'enter' }
  | { type: 'leave' }
  | { type: 'toggle-pin' }
  | { type: 'dismiss' }

export const initialConversationJumpRailInteraction: ConversationJumpRailInteraction = {
  hovered: false,
  pinned: false,
}

export function conversationJumpRailReducer(
  state: ConversationJumpRailInteraction,
  action: ConversationJumpRailAction,
): ConversationJumpRailInteraction {
  if (action.type === 'enter') return { ...state, hovered: true }
  if (action.type === 'leave') return { ...state, hovered: false }
  if (action.type === 'toggle-pin') return { hovered: false, pinned: !state.pinned }
  return initialConversationJumpRailInteraction
}

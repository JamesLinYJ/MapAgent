// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台对话面板宿主
//
//   文件:       WorkspaceConversationPanel.tsx
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { ChatPanel } from '../../features/conversation/ChatPanel'
import type { ChatPanelProps } from '../../features/conversation/types'

export function WorkspaceConversationPanel(props: ChatPanelProps) {
  return <ChatPanel {...props} />
}

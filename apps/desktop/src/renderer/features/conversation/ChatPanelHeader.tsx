// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话面板头部
//
//   文件:       ChatPanelHeader.tsx
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { Maximize2, Minimize2, Pencil } from 'lucide-react'
import { AppIcon } from '../../shared/components/AppIcon'
import type { PanelExpansionMotion } from '../../shared/usePanelExpansionMotion'

export interface ChatPanelHeaderProps {
  title: string
  statusLine: string
  isHistoryView: boolean
  sessionCount: number
  isPanelExpanded: boolean
  panelExpansion: PanelExpansionMotion
  onToggleHistory: () => void
  onNewConversation: () => void
}

export function ChatPanelHeader({
  title,
  statusLine,
  isHistoryView,
  sessionCount,
  isPanelExpanded,
  panelExpansion,
  onToggleHistory,
  onNewConversation,
}: ChatPanelHeaderProps) {
  return (
    <header className="cc-panel-header">
      <div className="cc-title-block">
        <span>{title}</span>
        <small>{statusLine}</small>
      </div>
      <div className="cc-header-actions">
        {sessionCount > 0 && (
          <button
            className="cc-icon-button"
            aria-label="历史对话"
            onClick={onToggleHistory}
          >
            <AppIcon name="history" size={15} />
            <span>{isHistoryView ? '返回' : sessionCount}</span>
          </button>
        )}
        <button className="cc-icon-button" aria-label="新建对话" onClick={onNewConversation}>
          <Pencil size={14} />
          <span>新建</span>
        </button>
        <button
          className="cc-icon-button"
          aria-label={isPanelExpanded ? '收起对话框' : '放大对话框'}
          disabled={panelExpansion.isMorphing}
          onClick={isPanelExpanded ? panelExpansion.collapse : panelExpansion.expand}
        >
          {isPanelExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </div>
    </header>
  )
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话历史面板
//
//   文件:       HistoryPanel.tsx
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { m } from 'framer-motion'
import type { HTMLMotionProps, Variants } from 'framer-motion'
import type { AgentThreadRecord } from '@geo-agent-platform/shared-types'
import { AppIcon } from '../../shared/components/AppIcon'
import { formatThreadDisplayTitle } from './threadTitles'

export interface HistoryPanelProps {
  filteredTasks: AgentThreadRecord[]
  currentThreadId: string | undefined
  trashedThreads: Array<{ thread: AgentThreadRecord; deletedAt: string; purgeAfter: string }>
  search: string
  showTrash: boolean
  viewMotion: HTMLMotionProps<'section'>
  feedVariants: Variants
  onBack: () => void
  onSelectTask: (id: string) => void
  onRename: (task: AgentThreadRecord) => void
  onDelete: (task: AgentThreadRecord) => void
  onRestore: (id: string) => void
  onPurge: (id: string) => void
  onSearchChange: (value: string) => void
  onToggleTrash: (show: boolean) => void
  onLoadTrash?: () => void
  formatDate: (value?: string | null) => string
}

export function HistoryPanel({
  filteredTasks,
  currentThreadId,
  trashedThreads,
  search,
  showTrash,
  viewMotion,
  feedVariants,
  onBack,
  onSelectTask,
  onRename,
  onDelete,
  onRestore,
  onPurge,
  onSearchChange,
  onToggleTrash,
  onLoadTrash,
  formatDate,
}: HistoryPanelProps) {
  return (
    <m.section key="history" className="cc-task-view" aria-label="历史对话" {...viewMotion}>
      <div className="cc-task-top">
        <button className="cc-back-button" onClick={onBack}>
          <AppIcon name="arrow_back" size={15} />
          返回
        </button>
        <strong>历史对话</strong>
        <button
          className="cc-trash-toggle"
          type="button"
          onClick={() => {
            const next = !showTrash
            onToggleTrash(next)
            if (next) onLoadTrash?.()
          }}
        >
          {showTrash ? '返回会话' : `回收站 ${trashedThreads.length || ''}`}
        </button>
      </div>
      {!showTrash && <input className="cc-task-search" value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="搜索会话..." />}
      <m.div className="cc-task-list" variants={feedVariants} initial="hidden" animate="visible" layout>
        {showTrash ? (
          trashedThreads.length ? trashedThreads.map(({ thread, deletedAt, purgeAfter }) => (
            <div key={thread.id} className="cc-task-row-wrap cc-task-row-wrap--trash">
              <div className="cc-task-row">
                <span className="cc-task-row__main"><strong>{formatThreadDisplayTitle(thread)}</strong><small>删除于 {formatDate(deletedAt)} · 保留至 {formatDate(purgeAfter)}</small></span>
              </div>
              <div className="cc-task-actions">
                <button aria-label="恢复" onClick={() => onRestore(thread.id)}><RefreshCw size={13} /></button>
                <button aria-label="永久删除" onClick={() => onPurge(thread.id)}><Trash2 size={13} /></button>
              </div>
            </div>
          )) : <div className="cc-empty">回收站为空</div>
        ) : filteredTasks.length ? (
          filteredTasks.map((task) => (
            <div key={task.id} className="cc-task-row-wrap">
              <button
                className={`cc-task-row ${task.id === currentThreadId ? 'cc-task-row--active' : ''}`}
                onClick={() => {
                  onSelectTask(task.id)
                  onBack()
                }}
              >
                <span className="cc-task-row__main">
                  <strong>{formatThreadDisplayTitle(task)}</strong>
                  <small>{task.historyPreview || task.latestUserQuery || '暂无摘要'}</small>
                </span>
                <span className="cc-task-row__meta">
                  {formatDate(task.updatedAt)}
                  <small>{task.runCount} 次运行</small>
                </span>
              </button>
              <div className="cc-task-actions">
                <button aria-label="重命名" onClick={() => onRename(task)}>
                  <Pencil size={13} />
                </button>
                <button aria-label="删除" onClick={() => onDelete(task)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="cc-empty">没有匹配的会话</div>
        )}
      </m.div>
    </m.section>
  )
}

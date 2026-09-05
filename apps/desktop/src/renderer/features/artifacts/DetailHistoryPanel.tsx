// +-------------------------------------------------------------------------
//
//   地理智能平台 - 详情历史面板
//
//   文件:       DetailHistoryPanel.tsx
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 渲染右侧详情栏的任务进度、历史运行和实时事件回放。
// 历史分页触发器的 DOM 观察逻辑封装在本文件，避免 DetailPanel 持有滚动实现细节。

import { useEffect, useRef } from 'react'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale/zh-CN'

import type { AgentState, RunEvent, RunSummary } from '@geo-agent-platform/shared-types'

import { AppIcon } from '../../shared/components/AppIcon'

interface ProgressItem {
  id: string
  title: string
  description: string
  status: 'done' | 'active' | 'pending' | 'warning'
}

interface DetailHistoryPanelProps {
  currentRunId?: string
  events: RunEvent[]
  hasMoreHistory?: boolean
  isHistoryLoading?: boolean
  progressItems: ReadonlyArray<ProgressItem>
  sessionRuns: RunSummary[]
  subAgents: NonNullable<AgentState['subAgents']>
  todoItems: NonNullable<AgentState['todos']>
  onLoadMoreHistory?: () => void
  onSelectHistoryRun: (runId: string) => void
}

export function DetailHistoryPanel({
  currentRunId,
  events,
  hasMoreHistory,
  isHistoryLoading,
  progressItems,
  sessionRuns,
  subAgents,
  todoItems,
  onLoadMoreHistory,
  onSelectHistoryRun,
}: DetailHistoryPanelProps) {
  // 历史面板渲染边界
  //
  // progressItems 是当前运行进度，sessionRuns 是持久化历史任务，
  // events 是运行事件回放，三类事实分区展示，避免混成伪进度。
  return (
    <section className="dc-card">
      <div className="dc-card__header">
        <div>
          <div className="dc-card__eyebrow">历史</div>
          <h3>执行过程</h3>
        </div>
        <div className="dc-card__icon">
          <AppIcon name="history" size={18} />
        </div>
      </div>

      <div className="dc-timeline">
        {progressItems.map((item) => (
          <article key={item.id} className={`dc-timeline__item dc-timeline__item--${item.status}`}>
            <strong>{item.title}</strong>
            <p>{item.description}</p>
          </article>
        ))}
      </div>

      <div className="dc-panel-section">
        <div className="dc-panel-section__title">历史任务</div>
        <div className="dc-panel-list">
          {sessionRuns.length ? (
            sessionRuns.map((sessionRun) => (
              <button
                key={sessionRun.id}
                type="button"
                className={`dc-panel-item dc-history-run${sessionRun.id === currentRunId ? ' dc-panel-item--active' : ''}`}
                onClick={() => onSelectHistoryRun(sessionRun.id)}
              >
                <div>
                  <strong>{sessionRun.userQuery}</strong>
                  <span>{formatRunMeta(sessionRun)}</span>
                </div>
                <span className="dc-pill-meta">{formatRunStatus(sessionRun.status)}</span>
              </button>
            ))
          ) : (
            <p className="dc-empty-copy">当前会话还没有可回看的任务记录。</p>
          )}
        </div>
        <HistoryLoadMoreTrigger
          hasMore={Boolean(hasMoreHistory)}
          loading={Boolean(isHistoryLoading)}
          onLoadMore={onLoadMoreHistory}
        />
      </div>

      <div className="dc-panel-section">
        <div className="dc-panel-section__title">运行事件</div>
        <div className="dc-panel-list">
          {events.length ? (
            [...events].reverse().slice(0, 8).map((event) => (
              <div key={event.eventId} className="dc-panel-item dc-panel-item--static">
                <div>
                  <strong>{event.message}</strong>
                  <span>{formatEventTime(event.timestamp)}</span>
                </div>
                <span className="dc-pill-meta">{event.type}</span>
              </div>
            ))
          ) : (
            <p className="dc-empty-copy">开始分析后，这里会记录每一步的执行情况。</p>
          )}
        </div>
      </div>

      {todoItems.length ? (
        <div className="dc-panel-section">
          <div className="dc-panel-section__title">待办状态</div>
          <div className="dc-panel-list">
            {todoItems.map((todo) => (
              <div key={todo.todoId} className="dc-panel-item dc-panel-item--static">
                <div>
                  <strong>{todo.title}</strong>
                  <span>{todo.description ?? '系统会持续回写这个待办的执行信息。'}</span>
                </div>
                <span className="dc-pill-meta">{todo.status}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {subAgents.length ? (
        <div className="dc-panel-section">
          <div className="dc-panel-section__title">子智能体状态</div>
          <div className="dc-panel-list">
            {subAgents.map((agent) => (
              <div key={agent.agentId} className="dc-panel-item dc-panel-item--static">
                <div>
                  <strong>{agent.name}</strong>
                  <span>{agent.latestMessage ?? agent.summary}</span>
                </div>
                <span className="dc-pill-meta">{agent.status}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}

function formatEventTime(timestamp: string) {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return timestamp
  return format(parsed, 'M月d日 HH:mm', { locale: zhCN })
}

import { formatRunStatus } from '../../shared/utils/statusLabels'

function formatRunMeta(run: RunSummary) {
  const parsed = new Date(run.updatedAt)
  const stamp = Number.isNaN(parsed.getTime())
    ? run.updatedAt
    : format(parsed, 'M月d日 HH:mm', { locale: zhCN })
  return `${stamp} · ${run.artifactCount} 个结果`
}

function HistoryLoadMoreTrigger({
  hasMore,
  loading,
  onLoadMore,
}: {
  hasMore: boolean
  loading: boolean
  onLoadMore?: () => void
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const trigger = triggerRef.current
    if (!trigger || !hasMore || loading || !onLoadMore) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) onLoadMore()
    }, { rootMargin: '180px 0px' })
    observer.observe(trigger)
    return () => observer.disconnect()
  }, [hasMore, loading, onLoadMore])

  if (!hasMore || !onLoadMore) return null
  return (
    <button
      ref={triggerRef}
      type="button"
      className="btn btn-secondary btn-sm dc-history-more"
      disabled={loading}
      onClick={onLoadMore}
    >
      {loading ? '正在加载…' : '加载更多历史'}
    </button>
  )
}

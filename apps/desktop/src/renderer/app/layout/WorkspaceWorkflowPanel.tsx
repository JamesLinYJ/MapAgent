// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作流侧栏面板
//
//   文件:       WorkspaceWorkflowPanel.tsx
//
//   日期:       2026年07月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Clock3,
  ListTree,
  LoaderCircle,
  MessageSquareText,
  Send,
  Sparkles,
  X,
} from 'lucide-react'
import { useState } from 'react'
import type { AgentState, RunEvent, SubAgentState } from '@geo-agent-platform/shared-types'
import {
  deriveWorkspaceWorkflowView,
  type WorkspaceWorkflowAgentView,
} from './WorkspaceWorkflowModel'

interface WorkspaceWorkflowPanelProps {
  agentState?: AgentState | null
  runId?: string
  onGetSubAgent?: (runId: string, agentId: string) => Promise<{
    agent: SubAgentState
    events: RunEvent[]
  }>
  onFollowUpSubAgent?: (runId: string, agentId: string, content: string) => Promise<SubAgentState>
  onCancelSubAgent?: (runId: string, agentId: string, reason?: string) => Promise<SubAgentState>
}

export function WorkspaceWorkflowPanel({
  agentState,
  runId,
  onGetSubAgent,
  onFollowUpSubAgent,
  onCancelSubAgent,
}: WorkspaceWorkflowPanelProps) {
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null)
  const [agentDetail, setAgentDetail] = useState<{ agent: SubAgentState; events: RunEvent[] } | null>(null)
  const [followUp, setFollowUp] = useState('')
  const [operation, setOperation] = useState<string | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)
  const workflow = deriveWorkspaceWorkflowView(agentState)
  if (!workflow) {
    return (
      <section
        id="workbench-workflow-panel"
        className="workbench-inspector-card workbench-workflow-card workbench-workflow-card--empty"
        aria-label="智能体工作流"
      >
        <div className="workbench-workflow-card__head">
          <div className="workbench-workflow-card__title">
            <ListTree size={16} aria-hidden="true" />
            <div>
              <strong>任务计划</strong>
              <span>尚未生成工作流</span>
            </div>
          </div>
          <span className="workbench-workflow-status">
            <Circle size={8} aria-hidden="true" />
            未开始
          </span>
        </div>

        <div className="workbench-workflow-empty">
          <span className="workbench-workflow-empty__icon" aria-hidden="true">
            <Sparkles size={18} />
          </span>
          <div>
            <strong>这里会同步展示智能体的执行计划</strong>
            <p>提交一个需要分步处理的目标后，可在此核对步骤、进度、审批和协作智能体。</p>
          </div>
        </div>

        <ol className="workbench-workflow-empty__steps" aria-label="开始工作流">
          <li><span>1</span><p><strong>描述目标</strong>在右侧智能对话中说明要解决的问题和期望成果。</p></li>
          <li><span>2</span><p><strong>提交分析</strong>智能体会根据任务复杂度生成可核验计划。</p></li>
          <li><span>3</span><p><strong>跟踪执行</strong>计划生成后，本页会实时显示步骤状态与待审批动作。</p></li>
        </ol>

        <div className="workbench-workflow-empty__next">
          <MessageSquareText size={14} aria-hidden="true" />
          <span>下一步：在右侧智能对话输入目标并发送</span>
          <ArrowRight size={13} aria-hidden="true" />
        </div>
      </section>
    )
  }

  const progress = workflow.steps.length
    ? Math.round((workflow.completedCount / workflow.steps.length) * 100)
    : deriveAgentProgress(workflow.agents)

  const loadAgentDetail = async (agentId: string): Promise<void> => {
    if (!runId || !onGetSubAgent) return
    setOperation(`detail:${agentId}`)
    setControlError(null)
    try {
      setAgentDetail(await onGetSubAgent(runId, agentId))
    } catch (error) {
      setControlError(formatControlError(error, '协作智能体详情加载失败。'))
    } finally {
      setOperation(null)
    }
  }

  const toggleAgentDetail = (agentId: string): void => {
    if (expandedAgentId === agentId) {
      setExpandedAgentId(null)
      setAgentDetail(null)
      setControlError(null)
      return
    }
    setExpandedAgentId(agentId)
    setAgentDetail(null)
    setFollowUp('')
    void loadAgentDetail(agentId)
  }

  const submitFollowUp = async (agentId: string): Promise<void> => {
    const content = followUp.trim()
    if (!runId || !onFollowUpSubAgent || !content) return
    setOperation(`follow-up:${agentId}`)
    setControlError(null)
    try {
      const agent = await onFollowUpSubAgent(runId, agentId, content)
      setAgentDetail(previous => ({ agent, events: previous?.events ?? [] }))
      setFollowUp('')
      await loadAgentDetail(agentId)
    } catch (error) {
      setControlError(formatControlError(error, '追问发送失败。'))
    } finally {
      setOperation(null)
    }
  }

  const cancelAgent = async (agentId: string): Promise<void> => {
    if (!runId || !onCancelSubAgent) return
    setOperation(`cancel:${agentId}`)
    setControlError(null)
    try {
      const agent = await onCancelSubAgent(runId, agentId, '用户从任务计划面板取消该协作智能体')
      setAgentDetail(previous => ({ agent, events: previous?.events ?? [] }))
      await loadAgentDetail(agentId)
    } catch (error) {
      setControlError(formatControlError(error, '协作智能体取消失败。'))
    } finally {
      setOperation(null)
    }
  }

  return (
    <section
      id="workbench-workflow-panel"
      className="workbench-inspector-card workbench-workflow-card"
      aria-label="智能体工作流"
    >
      <div className="workbench-workflow-card__head">
        <div className="workbench-workflow-card__title">
          <ListTree size={16} aria-hidden="true" />
          <div>
            <strong>任务计划</strong>
            <span>{workflow.steps.length
              ? `第 ${workflow.revision} 版 · ${workflow.steps.length} 步`
              : `${workflow.agents.length} 个协作智能体`}</span>
          </div>
        </div>
        <span className={`workbench-workflow-status workbench-workflow-status--${workflow.status}`}>
          {workflow.awaitingApproval ? <Clock3 size={12} aria-hidden="true" /> : null}
          {workflow.statusLabel}
        </span>
      </div>

      <p className="workbench-workflow-card__goal">{workflow.goal}</p>
      <div
        className="workbench-workflow-progress"
        role="progressbar"
        aria-label="工作流完成进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${progress}%` }} />
      </div>

      {workflow.steps.length ? <ol className="workbench-workflow-steps">
        {workflow.steps.map((step, index) => (
          <li key={step.stepId} className={`workbench-workflow-step workbench-workflow-step--${step.status}`}>
            <span className="workbench-workflow-step__icon" aria-hidden="true">
              {step.status === 'completed' || step.status === 'skipped' ? <Check size={12} />
                : step.status === 'running' ? <LoaderCircle size={12} />
                  : step.status === 'failed' || step.status === 'blocked' ? <X size={12} />
                    : <Circle size={9} />}
            </span>
            <div className="workbench-workflow-step__copy">
              <strong>{index + 1}. {step.title}</strong>
              <span>{step.technicalLabel} · {step.statusLabel}</span>
              {step.argsSummary ? <code title={step.argsSummary}>{step.argsSummary}</code> : null}
              {step.detail ? <small>{step.detail}</small> : null}
            </div>
          </li>
        ))}
      </ol> : null}

      {workflow.agents.length ? (
        <div className="workbench-workflow-agents" aria-label="协作智能体">
          <span className="workbench-workflow-agents__label"><Bot size={13} aria-hidden="true" />协作智能体</span>
          {workflow.agents.map(agent => (
            <div
              key={agent.agentId}
              className={`workbench-workflow-agent${agent.stalled ? ' workbench-workflow-agent--stalled' : ''}`}
            >
              <div className="workbench-workflow-agent__summary">
                <div>
                  <strong>{agent.name}</strong>
                  <span>{agent.role} · {agent.delegationMode === 'handoff' ? 'Handoff' : 'Agent tool'}</span>
                  {agent.currentStep ? <small>{agent.currentStep}</small>
                    : agent.detail ? <small>{agent.detail}</small> : null}
                </div>
                <div className="workbench-workflow-agent__state">
                  <span>{agent.statusLabel}</span>
                  {agent.progressPercent !== null ? <small>{agent.progressPercent}%</small> : null}
                  <button
                    type="button"
                    aria-expanded={expandedAgentId === agent.agentId}
                    aria-controls={`workbench-subagent-${agent.agentId}`}
                    onClick={() => toggleAgentDetail(agent.agentId)}
                  >
                    {expandedAgentId === agent.agentId
                      ? <ChevronUp size={12} aria-hidden="true" />
                      : <ChevronDown size={12} aria-hidden="true" />}
                    详情
                  </button>
                </div>
              </div>

              {expandedAgentId === agent.agentId ? (
                <div id={`workbench-subagent-${agent.agentId}`} className="workbench-workflow-agent__detail">
                  {operation === `detail:${agent.agentId}` && !agentDetail
                    ? <p className="workbench-workflow-agent__loading"><LoaderCircle size={12} />正在读取服务端状态…</p>
                    : null}

                  <dl className="workbench-workflow-agent__facts">
                    <div><dt>活动</dt><dd>{agentDetail?.agent.activityCount ?? agent.activityCount} 次</dd></div>
                    <div><dt>最近更新</dt><dd>{formatTimestamp(agentDetail?.agent.lastActivityAt ?? agent.lastActivityAt)}</dd></div>
                    <div><dt>步骤</dt><dd>{agentDetail?.agent.currentStepId ?? agent.currentStepId ?? '—'}</dd></div>
                  </dl>

                  {(agentDetail?.agent.stalled ?? agent.stalled) ? (
                    <p className="workbench-workflow-agent__warning">
                      <AlertTriangle size={13} aria-hidden="true" />
                      长时间没有新活动，可能需要追问或单独取消。
                    </p>
                  ) : null}

                  {(agentDetail?.agent.deliveryEvidence ?? agent.deliveryEvidence).length ? (
                    <div className="workbench-workflow-agent__evidence">
                      <strong>交付证据</strong>
                      <ul>
                        {(agentDetail?.agent.deliveryEvidence ?? agent.deliveryEvidence).map((evidence, index) => (
                          <li key={`${evidence.source}:${index}`}><span>{evidence.claim}</span><code>{evidence.source}</code></li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {(agentDetail?.agent.resultRefs ?? agent.resultRefs).length ? (
                    <div className="workbench-workflow-agent__refs">
                      <strong>结果引用</strong>
                      {(agentDetail?.agent.resultRefs ?? agent.resultRefs).map(reference => <code key={reference}>{reference}</code>)}
                    </div>
                  ) : null}

                  {agentDetail?.events.length ? (
                    <div className="workbench-workflow-agent__events">
                      <strong>运行审计事件</strong>
                      <ol>
                        {agentDetail.events.slice(-8).map(event => (
                          <li key={event.eventId}>
                            <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
                            <span>{event.message}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : null}

                  {controlError ? <p className="workbench-workflow-agent__error" role="alert">{controlError}</p> : null}

                  {(agentDetail?.agent.status ?? agent.status) === 'running'
                    || (agentDetail?.agent.status ?? agent.status) === 'cancelling' ? (
                    <div className="workbench-workflow-agent__controls">
                      <label htmlFor={`workbench-subagent-follow-up-${agent.agentId}`}>给该智能体追加要求</label>
                      <textarea
                        id={`workbench-subagent-follow-up-${agent.agentId}`}
                        value={followUp}
                        maxLength={4000}
                        rows={2}
                        placeholder="例如：优先核验数据年份，并附上来源。"
                        disabled={!runId || !onFollowUpSubAgent || Boolean(operation)}
                        onChange={event => setFollowUp(event.target.value)}
                      />
                      <div>
                        <button
                          type="button"
                          disabled={!followUp.trim() || !runId || !onFollowUpSubAgent || Boolean(operation)}
                          onClick={() => { void submitFollowUp(agent.agentId) }}
                        >
                          <Send size={12} aria-hidden="true" />追加要求
                        </button>
                        <button
                          type="button"
                          className="workbench-workflow-agent__cancel"
                          disabled={!runId || !onCancelSubAgent || Boolean(operation)
                            || (agentDetail?.agent.status ?? agent.status) === 'cancelling'}
                          onClick={() => { void cancelAgent(agent.agentId) }}
                        >
                          <Ban size={12} aria-hidden="true" />
                          {(agentDetail?.agent.status ?? agent.status) === 'cancelling' ? '取消中' : '单独取消'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function deriveAgentProgress(agents: WorkspaceWorkflowAgentView[]): number {
  if (!agents.length) return 0
  const percentages = agents.map(agent => {
    if (agent.progressPercent !== null) return agent.progressPercent
    if (agent.status === 'completed') return 100
    if (agent.status === 'cancelled' || agent.status === 'failed') return 0
    return agent.status === 'running' || agent.status === 'cancelling' ? 10 : 0
  })
  return Math.round(percentages.reduce((total, value) => total + value, 0) / percentages.length)
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—'
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) return value
  return timestamp.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatControlError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

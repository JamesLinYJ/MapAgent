// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话投影 Hook
//
//   文件:       useConversation.ts
//
//   日期:       2026年06月25日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { format, formatDuration, intervalToDuration } from 'date-fns'
import { zhCN } from 'date-fns/locale/zh-CN'
import type {
  ConversationItem,
  DecisionRequest,
  ToolDescriptor,
} from '@geo-agent-platform/shared-types'
import { ConversationPresentationIndex } from '@geo-agent-platform/conversation-presentation'
import { formatRunStatus } from '../../shared/utils/statusLabels'

// 聊天 UI 的事实入口是 ConversationItem[]。
//
// Hook 只做稳定 memo 和状态文案投影，不从事件流补造回答。
export function useConversationEntries(
  items: ReadonlyArray<ConversationItem>,
  _runStatus?: string,
  tools: ReadonlyArray<ToolDescriptor> = [],
) {
  const [projection] = useState(() => new ConversationPresentationIndex(items, tools))
  useLayoutEffect(() => {
    projection.replaceItems(items, tools)
  }, [items, projection, tools])
  return useSyncExternalStore(
    projection.subscribe,
    projection.getSnapshot,
    projection.getSnapshot,
  )
}

export function errorCardTitle(message?: string) {
  const lower = (message ?? '').toLowerCase()
  if (!lower.trim()) return '运行出错'
  if (lower.includes('response_format') || lower.includes('invalid_request_error') || lower.includes('badrequesterror') || lower.includes('模型')) {
    return '模型调用失败'
  }
  if (lower.includes('tool') || lower.includes('工具')) {
    return '工具执行失败'
  }
  if (lower.includes('failed to fetch') || lower.includes('network') || lower.includes('timeout') || lower.includes('连接')) {
    return '连接失败'
  }
  return '运行出错'
}

export function pickPendingDecision(decisions: ReadonlyArray<DecisionRequest> = []): DecisionRequest | null {
  return decisions.find(decision => decision.status === 'pending' && decision.kind === 'approval')
    ?? decisions.find(decision => decision.status === 'pending' && decision.kind === 'clarification')
    ?? null
}

export interface DecisionWorkflowPreview {
  goal: string
  steps: Array<{
    stepId: string
    title: string
    kind: string
    phase: string | null
    toolName: string
    ownerAgentId: string
    args: Record<string, unknown>
    reason: string
    dependsOn: string[]
  }>
}

// 工作流在批准前还不能写入 run.state.agentWorkflow；审批 payload 中的
// submit/revise_agent_workflow 参数是审批前唯一可信的工作流草案。
export function workflowPreviewFromDecision(decision: DecisionRequest): DecisionWorkflowPreview | null {
  const action = decision.payload.action
  if (decision.kind !== 'approval'
    || (action !== 'submit_agent_workflow' && action !== 'revise_agent_workflow')) return null
  const args = asRecord(decision.payload.args)
  const workflow = asRecord(args?.workflow)
  if (!workflow) return null
  const goal = typeof workflow.goal === 'string' ? workflow.goal.trim() : ''
  const steps = Array.isArray(workflow.steps)
    ? workflow.steps.flatMap((value, index) => {
      const step = asRecord(value)
      if (!step || typeof step.title !== 'string' || !step.title.trim()) return []
      return [{
        stepId: typeof step.stepId === 'string' && step.stepId.trim() ? step.stepId : `step_${index + 1}`,
        title: step.title.trim(),
        kind: typeof step.kind === 'string' ? step.kind.trim() : '',
        phase: typeof step.phase === 'string' && step.phase.trim() ? step.phase.trim() : null,
        toolName: typeof step.toolName === 'string' ? step.toolName.trim() : '',
        ownerAgentId: typeof step.ownerAgentId === 'string' ? step.ownerAgentId.trim() : '',
        args: asRecord(step.args) ?? {},
        reason: typeof step.reason === 'string' ? step.reason.trim() : '',
        dependsOn: Array.isArray(step.dependsOn)
          ? step.dependsOn.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
          : [],
      }]
    })
    : []
  return goal || steps.length ? { goal, steps } : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function formatStatusLine(
  runStatus: string | undefined,
  providerLabel: string,
  artifactCount: number,
  uploadedLayerName?: string,
  submissionDisabledReason?: string,
) {
  const parts = submissionDisabledReason
    ? [submissionDisabledReason]
    : [formatRunStatus(runStatus), `模型路由 ${providerLabel}`]
  if (artifactCount > 0) parts.push(`${artifactCount} 结果`)
  if (uploadedLayerName) parts.push(uploadedLayerName)
  return parts.join(' · ')
}

export function fmtElapsed(startedAt: string) {
  const started = new Date(startedAt).getTime()
  if (Number.isNaN(started)) return '0 秒'
  const elapsed = Math.max(0, Date.now() - started)
  return formatDuration(intervalToDuration({ start: 0, end: elapsed }), { locale: zhCN })
}

export function formatSessionDate(value?: string | null) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return format(date, 'yyyy-MM-dd')
}

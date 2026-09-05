// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作流侧栏视图模型
//
//   文件:       WorkspaceWorkflowModel.ts
//
//   日期:       2026年07月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 侧栏只投影服务端工作流或待审批草案，不维护第二份计划状态。

import type {
  AgentState,
  AgentWorkflowStep,
  SubAgentControlMessage,
  SubAgentState,
} from '@geo-agent-platform/shared-types'
import { workflowPreviewFromDecision } from '../../features/conversation/useConversation'

interface WorkspaceWorkflowStepView {
  stepId: string
  title: string
  status: AgentWorkflowStep['status']
  statusLabel: string
  technicalLabel: string
  argsSummary: string | null
  detail: string
}

export interface WorkspaceWorkflowAgentView {
  agentId: string
  name: string
  role: string
  delegationMode: SubAgentState['delegationMode']
  status: SubAgentState['status']
  statusLabel: string
  detail: string
  currentStepId: string | null
  currentStep: string | null
  progressPercent: number | null
  activityCount: number
  startedAt: string | null
  completedAt: string | null
  lastActivityAt: string | null
  stalled: boolean
  stalledSince: string | null
  resultRefs: string[]
  deliveryEvidence: Array<{ claim: string; source: string }>
  controls: SubAgentControlMessage[]
}

export interface WorkspaceWorkflowView {
  goal: string
  status: string
  statusLabel: string
  revision: number
  awaitingApproval: boolean
  completedCount: number
  steps: WorkspaceWorkflowStepView[]
  agents: WorkspaceWorkflowAgentView[]
}

export function deriveWorkspaceWorkflowView(agentState?: AgentState | null): WorkspaceWorkflowView | null {
  if (!agentState) return null

  const agents = projectAgents(agentState)

  for (const decision of [...agentState.decisions].reverse()) {
    if (decision.status !== 'pending') continue
    const preview = workflowPreviewFromDecision(decision)
    if (!preview) continue
    return {
      goal: preview.goal || '按以下步骤完成当前目标',
      status: 'awaiting_approval',
      statusLabel: '等待审批',
      revision: (agentState.agentWorkflow?.revision ?? 0) + 1,
      awaitingApproval: true,
      completedCount: 0,
      steps: preview.steps.map(step => ({
        stepId: step.stepId,
        title: step.title,
        status: 'pending',
        statusLabel: '待执行',
        technicalLabel: technicalLabel(step.phase, step.kind, step.toolName, step.ownerAgentId, step.args),
        argsSummary: summarizeArgs(step.args),
        detail: step.reason,
      })),
      agents,
    }
  }

  const workflow = agentState.agentWorkflow
  if (!workflow) {
    if (!agents.length) return null
    const status = deriveAgentOnlyWorkflowStatus(agents)
    return {
      goal: agentState.goal?.condition || agentState.userQuery || '协作智能体正在处理当前目标',
      status,
      statusLabel: workflowStatusLabel(status),
      revision: 0,
      awaitingApproval: false,
      completedCount: 0,
      steps: [],
      agents,
    }
  }
  return {
    goal: workflow.goal,
    status: workflow.status,
    statusLabel: workflowStatusLabel(workflow.status),
    revision: workflow.revision,
    awaitingApproval: workflow.status === 'awaiting_approval',
    completedCount: workflow.steps.filter(step => step.status === 'completed' || step.status === 'skipped').length,
    steps: workflow.steps.map(step => ({
      stepId: step.stepId,
      title: step.title,
      status: step.status,
      statusLabel: workflowStepStatusLabel(step.status),
      technicalLabel: technicalLabel(step.phase, step.kind, step.toolName, step.ownerAgentId, step.args),
      argsSummary: summarizeArgs(step.args),
      detail: step.errorMessage ?? step.resultSummary ?? step.reason,
    })),
    agents,
  }
}

function projectAgents(agentState: AgentState): WorkspaceWorkflowAgentView[] {
  return agentState.subAgents
    .filter(agent => agent.stepIds.length > 0 || agent.status !== 'pending')
    .map(agent => ({
      agentId: agent.agentId,
      name: agent.name,
      role: agent.role,
      delegationMode: agent.delegationMode,
      status: agent.status,
      statusLabel: subAgentStatusLabel(agent),
      detail: agent.latestMessage ?? agent.summary,
      currentStepId: agent.currentStepId,
      currentStep: agent.currentStep,
      progressPercent: agent.progressPercent,
      activityCount: agent.activityCount,
      startedAt: agent.startedAt,
      completedAt: agent.completedAt,
      lastActivityAt: agent.lastActivityAt,
      stalled: agent.stalled,
      stalledSince: agent.stalledSince,
      resultRefs: agent.resultRefs,
      deliveryEvidence: agent.deliveryEvidence,
      controls: agent.controls,
    }))
}

function deriveAgentOnlyWorkflowStatus(agents: WorkspaceWorkflowAgentView[]): string {
  if (agents.some(agent => agent.status === 'running' || agent.status === 'cancelling')) return 'running'
  if (agents.some(agent => agent.status === 'failed')) return 'failed'
  if (agents.every(agent => agent.status === 'completed' || agent.status === 'cancelled')) return 'completed'
  return 'pending'
}

function technicalLabel(
  phase: string | null,
  kind: string,
  toolName: string,
  ownerAgentId: string,
  args: Record<string, unknown>,
): string {
  const phasePrefix = phaseLabel(phase)
  const withPhase = (label: string): string => phasePrefix ? `${phasePrefix} · ${label}` : label
  if (kind === 'automation' || toolName === 'execute_automation') {
    const automationId = typeof args.automation_id === 'string' ? args.automation_id : null
    return withPhase(automationId ? `Automation · ${automationId}` : 'Automation')
  }
  if (kind === 'agent' || (ownerAgentId && ownerAgentId !== 'supervisor')) {
    return withPhase(`Agent · ${ownerAgentId || toolName}`)
  }
  return withPhase(toolName || 'Supervisor')
}

function phaseLabel(phase: string | null): string {
  if (phase === 'discover') return '数据发现'
  if (phase === 'validate') return '质量核验'
  if (phase === 'analyze') return '分析执行'
  if (phase === 'visualize') return '可视化'
  if (phase === 'verify') return '结果验证'
  if (phase === 'deliver') return '成果交付'
  return ''
}

function summarizeArgs(args: Record<string, unknown>): string | null {
  if (!Object.keys(args).length) return null
  return JSON.stringify(args)
}

function workflowStatusLabel(status: string): string {
  if (status === 'awaiting_approval') return '等待审批'
  if (status === 'running') return '执行中'
  if (status === 'adjusting') return '调整中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  return status
}

function workflowStepStatusLabel(status: AgentWorkflowStep['status']): string {
  const labels: Record<AgentWorkflowStep['status'], string> = {
    pending: '待执行',
    running: '执行中',
    completed: '已完成',
    failed: '失败',
    blocked: '已阻塞',
    skipped: '已跳过',
  }
  return labels[status]
}

function subAgentStatusLabel(agent: SubAgentState): string {
  if (agent.stalled && agent.status === 'running') return '疑似停滞'
  if (agent.status === 'pending') return '待命'
  if (agent.status === 'running') return '执行中'
  if (agent.status === 'completed') return '已返回'
  if (agent.status === 'failed') return '失败'
  if (agent.status === 'cancelling') return '取消中'
  if (agent.status === 'cancelled') return '已取消'
  return agent.status
}

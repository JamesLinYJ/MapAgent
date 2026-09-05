// +-------------------------------------------------------------------------
//
//   地理智能平台 - 智能体工作流状态机
//
//   文件:       agentWorkflowState.ts
//
//   日期:       2026年07月17日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { isDeepStrictEqual } from 'node:util'
import {
  agentWorkflowDraftSchema,
  agentWorkflowRevisionSchema,
  agentWorkflowSchema,
  type AgentWorkflow,
  type AgentWorkflowDraft,
  type AgentWorkflowRevision,
  type AgentWorkflowStep,
} from '../schemas/types.js'
import { makeId, nowUtc } from '../utils/ids.js'

export const AGENT_WORKFLOW_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  'request_clarification',
  'enter_plan_mode',
  'submit_agent_workflow',
  'revise_agent_workflow',
  'todo_write',
])

export function createAgentWorkflow(input: unknown, objectiveRevision = 1): AgentWorkflow {
  const draft = agentWorkflowDraftSchema.parse(input)
  assertValidDependencyGraph(draft)
  const now = nowUtc()
  return agentWorkflowSchema.parse({
    agentWorkflowId: makeId('agent_workflow'),
    objectiveRevision,
    revision: 1,
    goal: draft.goal,
    status: 'running',
    changeReason: null,
    createdAt: now,
    updatedAt: now,
    approvedAt: now,
    completedAt: null,
    steps: draft.steps.map(step => runtimeStep(step)),
  })
}

export function reviseAgentWorkflow(
  current: AgentWorkflow,
  input: unknown,
  objectiveRevision = current.objectiveRevision,
): AgentWorkflow {
  const revision = agentWorkflowRevisionSchema.parse(input)
  assertValidDependencyGraph(revision)
  // completed 只表示当前计划步骤已完成。Run 在最终交付提交前仍可能需要
  // 追加验证或修订执行契约；只有显式取消才是不可恢复的工作流终态。
  if (current.status === 'cancelled') {
    throw new Error('已取消的智能体工作流不能再调整。')
  }
  const now = nowUtc()
  const previous = new Map(current.steps.map(step => [step.stepId, step]))
  return agentWorkflowSchema.parse({
    ...current,
    objectiveRevision,
    revision: current.revision + 1,
    goal: revision.goal,
    status: 'running',
    changeReason: revision.changeReason,
    updatedAt: now,
    completedAt: null,
    steps: revision.steps.map(step => {
      const prior = previous.get(step.stepId)
      return prior && prior.status === 'completed' && sameExecutionContract(prior, step)
        ? { ...prior, title: step.title, reason: step.reason, ownerAgentId: step.ownerAgentId }
        : runtimeStep(step)
    }),
  })
}

// 用户为同一 Run 追加输入后，旧工作流的完成态只能作为历史证据，不能继续
// 充当新目标版本的交付凭证。步骤结果保留给显式 revise 复用，但工作流必须
// 回到 adjusting，直到模型按新输入提交下一版执行契约。
export function advanceAgentWorkflowObjectiveRevision(
  workflow: AgentWorkflow,
  objectiveRevision: number,
): AgentWorkflow {
  if (objectiveRevision <= workflow.objectiveRevision) return workflow
  return agentWorkflowSchema.parse({
    ...workflow,
    objectiveRevision,
    status: 'adjusting',
    changeReason: `Run 输入已更新到 objective revision ${objectiveRevision}。`,
    updatedAt: nowUtc(),
    completedAt: null,
  })
}

export function findRunnableAgentWorkflowStep(
  workflow: AgentWorkflow,
  invocation: {
    toolName: string
    ownerAgentId?: string | null
    workflowStepId?: string | null
  },
  excludedStepIds: ReadonlySet<string> = new Set(),
): AgentWorkflowStep | null {
  const completed = new Set(
    workflow.steps
      .filter(step => step.status === 'completed' || step.status === 'skipped')
      .map(step => step.stepId),
  )
  const runnable = workflow.steps.filter(step => (
    step.status === 'pending'
    && step.toolName === invocation.toolName
    && step.ownerAgentId === (invocation.ownerAgentId ?? 'supervisor')
    && !excludedStepIds.has(step.stepId)
    && step.dependsOn.every(dependency => completed.has(dependency))
  ))
  if (invocation.workflowStepId) {
    return runnable.find(step => step.stepId === invocation.workflowStepId) ?? null
  }
  return runnable.length === 1 ? runnable[0] ?? null : null
}

export function startAgentWorkflowStep(
  workflow: AgentWorkflow,
  input: { stepId: string },
): AgentWorkflow {
  const now = nowUtc()
  return updateStep(workflow, input.stepId, step => {
    assertStepStatus(step, 'pending', '开始')
    return {
      ...step,
      status: 'running',
      attempt: step.attempt + 1,
      startedAt: now,
      completedAt: null,
      resultSummary: null,
      errorMessage: null,
    }
  }, { status: 'running', updatedAt: now })
}

export function completeAgentWorkflowStep(
  workflow: AgentWorkflow,
  input: { stepId: string; resultSummary: string },
): AgentWorkflow {
  const now = nowUtc()
  const next = updateStep(workflow, input.stepId, step => {
    assertStepStatus(step, 'running', '完成')
    return {
      ...step,
      status: 'completed',
      resultSummary: input.resultSummary.trim() || null,
      errorMessage: null,
      completedAt: now,
    }
  }, { updatedAt: now })
  const finished = next.steps.every(step => step.status === 'completed' || step.status === 'skipped')
  // adjusting 表示输入 revision 已改变或执行契约失败。即使旧 revision 启动的
  // 在途步骤随后返回，也不能把该旧契约重新提升为 completed。
  return finished && next.status !== 'adjusting'
    ? agentWorkflowSchema.parse({ ...next, status: 'completed', completedAt: now })
    : next
}

export function failAgentWorkflowStep(
  workflow: AgentWorkflow,
  input: { stepId: string; errorMessage: string },
): AgentWorkflow {
  const now = nowUtc()
  const failed = updateStep(workflow, input.stepId, step => {
    assertStepStatus(step, 'running', '标记失败')
    return {
      ...step,
      status: 'failed',
      errorMessage: input.errorMessage,
      completedAt: now,
    }
  }, { status: 'adjusting', updatedAt: now })
  const blocked = transitiveDependants(failed.steps, input.stepId)
  return agentWorkflowSchema.parse({
    ...failed,
    steps: failed.steps.map(step => (
      blocked.has(step.stepId) && step.status === 'pending'
        ? { ...step, status: 'blocked' as const, errorMessage: `依赖步骤 '${input.stepId}' 执行失败。` }
        : step
    )),
  })
}

function assertStepStatus(
  step: AgentWorkflowStep,
  expected: AgentWorkflowStep['status'],
  action: string,
): void {
  if (step.status !== expected) {
    throw new Error(`步骤 '${step.stepId}' 当前状态为 '${step.status}'，不能${action}。`)
  }
}

function runtimeStep(step: AgentWorkflowDraft['steps'][number]): AgentWorkflowStep {
  return {
    ...step,
    status: 'pending',
    attempt: 0,
    resultSummary: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
  }
}

function assertValidDependencyGraph(input: AgentWorkflowDraft | AgentWorkflowRevision): void {
  const ids = new Set<string>()
  for (const step of input.steps) {
    if (ids.has(step.stepId)) throw new Error(`智能体工作流步骤 ID '${step.stepId}' 重复。`)
    ids.add(step.stepId)
  }
  for (const step of input.steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`步骤 '${step.stepId}' 依赖不存在的步骤 '${dependency}'。`)
      if (dependency === step.stepId) throw new Error(`步骤 '${step.stepId}' 不能依赖自身。`)
    }
  }
  const dependencies = new Map(input.steps.map(step => [step.stepId, step.dependsOn]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (stepId: string): void => {
    if (visiting.has(stepId)) throw new Error(`智能体工作流存在循环依赖，涉及步骤 '${stepId}'。`)
    if (visited.has(stepId)) return
    visiting.add(stepId)
    for (const dependency of dependencies.get(stepId) ?? []) visit(dependency)
    visiting.delete(stepId)
    visited.add(stepId)
  }
  for (const step of input.steps) visit(step.stepId)
}

function sameExecutionContract(
  previous: AgentWorkflowStep,
  next: AgentWorkflowDraft['steps'][number],
): boolean {
  return previous.kind === next.kind
    && previous.toolName === next.toolName
    && previous.ownerAgentId === next.ownerAgentId
    && isDeepStrictEqual(previous.args, next.args)
    && isDeepStrictEqual(previous.dependsOn, next.dependsOn)
}

function updateStep(
  workflow: AgentWorkflow,
  stepId: string,
  update: (step: AgentWorkflowStep) => AgentWorkflowStep,
  workflowPatch: Partial<AgentWorkflow>,
): AgentWorkflow {
  let found = false
  const steps = workflow.steps.map(step => {
    if (step.stepId !== stepId) return step
    found = true
    return update(step)
  })
  if (!found) throw new Error(`智能体工作流步骤 '${stepId}' 不存在。`)
  return agentWorkflowSchema.parse({ ...workflow, ...workflowPatch, steps })
}

function transitiveDependants(steps: AgentWorkflowStep[], failedStepId: string): Set<string> {
  const blocked = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const step of steps) {
      if (blocked.has(step.stepId)) continue
      if (step.dependsOn.some(dependency => dependency === failedStepId || blocked.has(dependency))) {
        blocked.add(step.stepId)
        changed = true
      }
    }
  }
  return blocked
}

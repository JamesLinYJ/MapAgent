// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行终态领域策略
//
//   文件:       TerminalPolicy.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  AgentState,
  RunGoal,
  RunGoalVerdict,
  SupervisorDelivery,
} from '../../schemas/types.js'
import { evaluateTerminalDelivery } from '../../agent/terminalDeliveryPolicy.js'

export const MAX_TERMINAL_REPAIR_ATTEMPTS = 2

export type TerminalCandidateStateDecision =
  | { type: 'supersede' }
  | {
      type: 'clarification'
      clarification: NonNullable<AgentState['clarification']>
      cancelActiveGoal: boolean
    }
  | {
      type: 'reject'
      code: 'workflow_missing' | 'workflow_incomplete' | 'todos_incomplete'
      message: string
    }
  | { type: 'ready' }

export type TerminalDeliveryPolicyDecision =
  | { type: 'accepted' }
  | {
      type: 'repair'
      code: 'preparation_only'
      reason: string
      instruction: string
      nextAttempt: number
    }
  | {
      type: 'reject'
      code: 'repair_budget_exhausted'
      reason: string
    }

export type GoalPreJudgeDecision =
  | { type: 'evaluate' }
  | { type: 'exhausted'; reason: string }

export type GoalVerdictDecision =
  | { type: 'satisfied' }
  | { type: 'impossible'; reason: string }
  | { type: 'exhausted'; reason: string }
  | {
      type: 'recheck'
      recheckCount: number
      instruction: string
    }

export function evaluateTerminalCandidateState(
  state: Readonly<AgentState> | null,
  objectiveRevision: number,
): TerminalCandidateStateDecision {
  if (!state) return { type: 'supersede' }
  if (state.clarification && !state.clarification.selectedOptionId) {
    return {
      type: 'clarification',
      clarification: state.clarification,
      cancelActiveGoal: Boolean(
        state.goal && (state.goal.status === 'active' || state.goal.status === 'evaluating'),
      ),
    }
  }
  if (state.runProfile === 'geospatial_compose' && !state.agentWorkflow) {
    return {
      type: 'reject',
      code: 'workflow_missing',
      message: '地理分析 Compose 运行必须提交并完成 discover、validate、analyze、verify 阶段工作流后才能交付。',
    }
  }
  if (state.agentWorkflow && (
    state.agentWorkflow.status !== 'completed'
    || state.agentWorkflow.objectiveRevision !== objectiveRevision
  )) {
    return {
      type: 'reject',
      code: 'workflow_incomplete',
      message: `智能体工作流尚未完成，当前状态为 ${state.agentWorkflow.status}。必须完成或显式调整剩余步骤后再交付最终回答。`,
    }
  }
  const incompleteTodos = state.todos
    .filter(todo => todo.status === 'pending' || todo.status === 'running')
  if (incompleteTodos.length) {
    return {
      type: 'reject',
      code: 'todos_incomplete',
      message: `运行仍有未完成 Todo：${incompleteTodos.map(todo => todo.title).join('、')}。请先更新为完成、失败或受阻状态。`,
    }
  }
  return { type: 'ready' }
}

export function evaluateTerminalDeliveryCandidate(input: {
  executionMode: 'plan' | 'auto' | undefined
  delivery: SupervisorDelivery
  repairAttempts: number
}): TerminalDeliveryPolicyDecision {
  if (input.executionMode === 'plan') return { type: 'accepted' }
  const decision = evaluateTerminalDelivery({ delivery: input.delivery })
  if (decision.accepted) return { type: 'accepted' }
  if (input.repairAttempts >= MAX_TERMINAL_REPAIR_ATTEMPTS) {
    return {
      type: 'reject',
      code: 'repair_budget_exhausted',
      reason: decision.reason,
    }
  }
  return {
    type: 'repair',
    code: decision.code,
    reason: decision.reason,
    instruction: decision.repairInstruction,
    nextAttempt: input.repairAttempts + 1,
  }
}

export function evaluateGoalBeforeJudge(input: {
  goal: Readonly<RunGoal>
  tokenUsage: number
  nowEpochMs: number
}): GoalPreJudgeDecision {
  const reason = goalBoundaryReason(input.goal, input.tokenUsage, input.nowEpochMs, 'before_judge')
  return reason ? { type: 'exhausted', reason } : { type: 'evaluate' }
}

export function evaluateGoalVerdict(input: {
  goal: Readonly<RunGoal>
  verdict: Readonly<RunGoalVerdict>
  nowEpochMs: number
}): GoalVerdictDecision {
  const afterJudgeBoundary = goalBoundaryReason(
    input.goal,
    input.verdict.tokenUsage,
    input.nowEpochMs,
    'after_judge',
  )
  if (afterJudgeBoundary) return { type: 'exhausted', reason: afterJudgeBoundary }
  if (input.verdict.status === 'impossible') {
    return { type: 'impossible', reason: input.verdict.reason }
  }
  if (input.verdict.status === 'satisfied') return { type: 'satisfied' }

  if (input.goal.recheckCount >= input.goal.maxRechecks) {
    return {
      type: 'exhausted',
      reason: `Goal 在 ${input.goal.maxRechecks} 次最大复验续跑后仍未满足。`,
    }
  }
  const beforeRecheckBoundary = goalBoundaryReason(
    input.goal,
    input.verdict.tokenUsage,
    input.nowEpochMs,
    'before_judge',
  )
  if (beforeRecheckBoundary) return { type: 'exhausted', reason: beforeRecheckBoundary }
  return {
    type: 'recheck',
    recheckCount: input.goal.recheckCount + 1,
    instruction: goalRecheckInstruction(input.goal, input.verdict),
  }
}

function goalBoundaryReason(
  goal: Readonly<RunGoal>,
  tokenUsage: number,
  nowEpochMs: number,
  stage: 'before_judge' | 'after_judge',
): string | null {
  if (goal.deadlineAt && nowEpochMs >= Date.parse(goal.deadlineAt)) {
    return `Goal 已超过截止时间 ${goal.deadlineAt}，停止验收与续跑。`
  }
  if (goal.maxTokenBudget === null) return null
  const exceeded = stage === 'before_judge'
    ? tokenUsage >= goal.maxTokenBudget
    : tokenUsage > goal.maxTokenBudget
  return exceeded
    ? `Goal 词元预算已用尽：${tokenUsage}/${goal.maxTokenBudget}。`
    : null
}

function goalRecheckInstruction(goal: Readonly<RunGoal>, verdict: Readonly<RunGoalVerdict>): string {
  return [
    '独立 Goal 验收器判定当前证据不完整，必须继续真实执行，不得只改写最终结论。',
    `Goal：${goal.condition}`,
    `判定原因：${verdict.reason}`,
    `缺失验收项：${verdict.missingCriteria.join('；')}`,
    '请在现有 SDK Session 中使用已授权工具、valueRef 与工作流证据补齐缺失项；如果工具或数据真实阻断，保留失败证据并如实说明。',
  ].join('\n')
}

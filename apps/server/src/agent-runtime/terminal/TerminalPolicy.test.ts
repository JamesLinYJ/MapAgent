// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行终态领域策略测试
//
//   文件:       TerminalPolicy.test.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  agentStateSchema,
  runGoalSchema,
  runGoalVerdictSchema,
  type AgentState,
  type RunGoal,
  type RunGoalVerdict,
} from '../../schemas/types.js'
import { describe, expect, it } from 'vitest'
import {
  evaluateGoalBeforeJudge,
  evaluateGoalVerdict,
  evaluateTerminalCandidateState,
  evaluateTerminalDeliveryCandidate,
  MAX_TERMINAL_REPAIR_ATTEMPTS,
} from './TerminalPolicy.js'

const NOW = Date.parse('2026-08-24T00:00:00.000Z')

describe('TerminalPolicy', () => {
  it('supersedes a candidate whose immutable state disappeared under new steering', () => {
    expect(evaluateTerminalCandidateState(null, 2)).toEqual({ type: 'supersede' })
  })

  it('emits clarification and rejects incomplete workflow or Todo states without mutating them', () => {
    const clarification = state({
      clarification: {
        clarificationId: 'clarification_1',
        kind: 'scope',
        reason: 'missing_area',
        question: '请选择分析范围',
        options: [],
        selectedOptionId: null,
        allowFreeText: true,
      },
      goal: goal(),
    })
    expect(evaluateTerminalCandidateState(clarification, 1)).toMatchObject({
      type: 'clarification',
      cancelActiveGoal: true,
    })

    const compose = state({ runProfile: 'geospatial_compose' })
    expect(evaluateTerminalCandidateState(compose, 1)).toMatchObject({
      type: 'reject',
      code: 'workflow_missing',
    })

    const todos = state({
      todos: [{
        todoId: 'todo_1',
        title: '生成地图',
        status: 'running',
        description: null,
        activeForm: null,
        ownerAgentId: null,
        stepId: null,
      }],
    })
    expect(evaluateTerminalCandidateState(todos, 1)).toMatchObject({
      type: 'reject',
      code: 'todos_incomplete',
    })
    expect(todos.todos[0]?.status).toBe('running')
  })

  it('turns preparation-only output into a bounded repair command', () => {
    const delivery = {
      markdown: '我先查询数据，接下来生成地图。',
      summary: '准备查询',
      artifactIds: [],
      warnings: [],
    }
    expect(evaluateTerminalDeliveryCandidate({
      executionMode: 'auto',
      delivery,
      repairAttempts: 0,
    })).toMatchObject({ type: 'repair', nextAttempt: 1 })
    expect(evaluateTerminalDeliveryCandidate({
      executionMode: 'auto',
      delivery,
      repairAttempts: MAX_TERMINAL_REPAIR_ATTEMPTS,
    })).toMatchObject({ type: 'reject', code: 'repair_budget_exhausted' })
  })

  it('covers Goal exhausted-before-judge, impossible, incomplete recheck, exhausted, and satisfied', () => {
    expect(evaluateGoalBeforeJudge({
      goal: goal({ maxTokenBudget: 100 }),
      tokenUsage: 100,
      nowEpochMs: NOW,
    })).toMatchObject({ type: 'exhausted' })

    expect(evaluateGoalVerdict({
      goal: goal(),
      verdict: verdict('impossible'),
      nowEpochMs: NOW,
    })).toEqual({ type: 'impossible', reason: '当前结论' })

    expect(evaluateGoalVerdict({
      goal: goal({ recheckCount: 0, maxRechecks: 2 }),
      verdict: verdict('incomplete'),
      nowEpochMs: NOW,
    })).toMatchObject({
      type: 'recheck',
      recheckCount: 1,
      instruction: expect.stringContaining('缺失验收项：缺少地图'),
    })

    expect(evaluateGoalVerdict({
      goal: goal({ recheckCount: 2, maxRechecks: 2 }),
      verdict: verdict('incomplete'),
      nowEpochMs: NOW,
    })).toMatchObject({ type: 'exhausted' })

    expect(evaluateGoalVerdict({
      goal: goal(),
      verdict: verdict('satisfied'),
      nowEpochMs: NOW,
    })).toEqual({ type: 'satisfied' })
  })
})

function state(overrides: Partial<AgentState> = {}): AgentState {
  return agentStateSchema.parse({
    sessionId: 'session_1',
    threadId: 'thread_1',
    userQuery: '生成风险地图',
    ...overrides,
  })
}

function goal(overrides: Partial<RunGoal> = {}): RunGoal {
  return runGoalSchema.parse({
    goalId: 'goal_1',
    condition: '生成风险地图',
    acceptanceCriteria: ['存在地图产物'],
    maxRechecks: 2,
    deadlineAt: null,
    maxTokenBudget: null,
    objectiveRevision: 1,
    status: 'active',
    recheckCount: 0,
    lastVerdict: null,
    failureReason: null,
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  })
}

function verdict(status: RunGoalVerdict['status']): RunGoalVerdict {
  return runGoalVerdictSchema.parse({
    status,
    reason: '当前结论',
    evidence: status === 'incomplete'
      ? []
      : [{ source: 'artifact', referenceId: 'artifact_1', statement: '存在地图产物' }],
    missingCriteria: status === 'incomplete' ? ['缺少地图'] : [],
    attempt: 1,
    evaluatedAt: '2026-08-24T00:00:00.000Z',
    tokenUsage: 10,
  })
}

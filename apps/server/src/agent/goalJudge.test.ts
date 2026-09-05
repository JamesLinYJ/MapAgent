// +-------------------------------------------------------------------------
//
//   地理智能平台 - Goal 独立验收器测试
//
//   文件:       goalJudge.test.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ModelCompletionService } from '../model/modelResultCache.js'
import { toolCallSchema } from '../schemas/types.js'
import { createTestPersistenceFacade } from '../../test-support/persistenceFacadeHarness.js'
import {
  GoalJudge,
  goalJudgeDecisionSchema,
  type CanonicalGoalEvidenceBundle,
  validateJudgeEvidence,
} from './goalJudge.js'

describe('GoalJudge', () => {
  it('uses a separate structured call over canonical evidence and records its usage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-goal-judge-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession({ workspaceId: 'workspace_goal', userId: 'user_goal' })
      const thread = await store.createThread(session.id, 'Goal 验收')
      const run = await store.createRun(session.id, '检查图层', {
        threadId: thread.id,
        modelProvider: 'fake',
        goal: goalInput(),
      })
      await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'message',
        payload: { role: 'user', content: '检查图层并提供可验证结论。' },
      })
      await store.updateRunState(run.id, {
        toolResults: [toolCallSchema.parse({
          stepId: 'step_check',
          tool: 'query_layer',
          status: 'completed',
          message: '已读取 12 个要素。',
          resultId: 'result_layer_check',
        })],
      })
      let capturedRequest: Record<string, unknown> | null = null
      const judge = new GoalJudge(store, fakeCompletions({
        status: 'satisfied',
        reason: '工具账本证明图层已查询。',
        evidence: [{
          source: 'tool_result',
          referenceId: 'result_layer_check',
          statement: '查询成功返回 12 个要素。',
        }],
        missingCriteria: [],
      }, request => { capturedRequest = request }))
      const goal = store.getRun(run.id).state.goal
      if (!goal) throw new Error('goal missing')

      const verdict = await judge.evaluate({
        runId: run.id,
        threadId: thread.id,
        provider: 'fake',
        goal,
      })

      expect(verdict).toMatchObject({ status: 'satisfied', attempt: 1, tokenUsage: 12 })
      expect(capturedRequest).toMatchObject({
        runId: run.id,
        purpose: 'goal_judgement',
        cacheMode: 'bypass',
      })
      expect(String(capturedRequest?.prompt)).toContain('<canonical-evidence>')
      expect(String(capturedRequest?.prompt)).toContain('result_layer_check')
      expect(store.getRun(run.id).state.runtimeStats.modelTotalTokens).toBe(12)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects satisfied verdicts supported only by the working assistant text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-goal-judge-self-report-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession({ workspaceId: 'workspace_goal', userId: 'user_goal' })
      const thread = await store.createThread(session.id, 'Goal 主观总结')
      const run = await store.createRun(session.id, '完成分析', {
        threadId: thread.id,
        modelProvider: 'fake',
        goal: goalInput(),
      })
      const assistant = await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'message',
        payload: { role: 'assistant', content: '我已经完成了所有工作。' },
      })
      const judge = new GoalJudge(store, fakeCompletions({
        status: 'satisfied',
        reason: '助手说已完成。',
        evidence: [{ source: 'transcript', referenceId: assistant.entryId, statement: '助手声称已完成。' }],
        missingCriteria: [],
      }))
      const goal = store.getRun(run.id).state.goal
      if (!goal) throw new Error('goal missing')

      await expect(judge.evaluate({ runId: run.id, threadId: thread.id, provider: 'fake', goal }))
        .rejects.toThrow('不能只引用用户请求或工作 Agent 的助手文本')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not treat the current user request as proof that the goal was completed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-goal-judge-user-request-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession({ workspaceId: 'workspace_goal', userId: 'user_goal' })
      const thread = await store.createThread(session.id, 'Goal 用户请求不是证据')
      const run = await store.createRun(session.id, '完成分析', {
        threadId: thread.id,
        modelProvider: 'fake',
        goal: goalInput(),
      })
      const request = await store.appendTranscript({
        threadId: thread.id,
        runId: run.id,
        kind: 'message',
        payload: { role: 'user', content: '请完成图层检查。' },
      })
      const judge = new GoalJudge(store, fakeCompletions({
        status: 'satisfied',
        reason: '用户要求完成。',
        evidence: [{ source: 'transcript', referenceId: request.entryId, statement: '用户提出了要求。' }],
        missingCriteria: [],
      }))
      const goal = store.getRun(run.id).state.goal
      if (!goal) throw new Error('goal missing')

      await expect(judge.evaluate({ runId: run.id, threadId: thread.id, provider: 'fake', goal }))
        .rejects.toThrow('不能只引用用户请求或工作 Agent 的助手文本')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects hallucinated evidence references', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-goal-judge-reference-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession({ workspaceId: 'workspace_goal', userId: 'user_goal' })
      const thread = await store.createThread(session.id, 'Goal 引用')
      const run = await store.createRun(session.id, '完成分析', {
        threadId: thread.id,
        modelProvider: 'fake',
        goal: goalInput(),
      })
      const judge = new GoalJudge(store, fakeCompletions({
        status: 'impossible',
        reason: '数据不存在。',
        evidence: [{ source: 'tool_result', referenceId: 'invented_result', statement: '伪造引用。' }],
        missingCriteria: [],
      }))
      const goal = store.getRun(run.id).state.goal
      if (!goal) throw new Error('goal missing')

      await expect(judge.evaluate({ runId: run.id, threadId: thread.id, provider: 'fake', goal }))
        .rejects.toThrow("不存在的 tool_result 证据 'invented_result'")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects evidence references from an earlier run in the same thread', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-goal-judge-run-scope-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession({ workspaceId: 'workspace_goal', userId: 'user_goal' })
      const thread = await store.createThread(session.id, 'Goal 运行证据隔离')
      const earlierRun = await store.createRun(session.id, '上一次分析', {
        threadId: thread.id,
        modelProvider: 'fake',
      })
      const earlierEvidence = await store.appendTranscript({
        threadId: thread.id,
        runId: earlierRun.id,
        kind: 'checkpoint',
        payload: { type: 'verified_result', content: '旧运行的分析结果。' },
      })
      const currentRun = await store.createRun(session.id, '当前分析', {
        threadId: thread.id,
        modelProvider: 'fake',
        goal: goalInput(),
      })
      await store.appendTranscript({
        threadId: thread.id,
        runId: currentRun.id,
        kind: 'message',
        payload: { role: 'user', content: '请重新检查当前数据。' },
      })
      const judge = new GoalJudge(store, fakeCompletions({
        status: 'satisfied',
        reason: '旧运行已经完成。',
        evidence: [{
          source: 'transcript',
          referenceId: earlierEvidence.entryId,
          statement: '引用了上一次运行的证据。',
        }],
        missingCriteria: [],
      }))
      const goal = store.getRun(currentRun.id).state.goal
      if (!goal) throw new Error('goal missing')

      await expect(judge.evaluate({
        runId: currentRun.id,
        threadId: thread.id,
        provider: 'fake',
        goal,
      })).rejects.toThrow(`不存在的 transcript 证据 '${earlierEvidence.entryId}'`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('validateJudgeEvidence', () => {
  it.each([
    {
      label: '模型输入摘要 checkpoint',
      source: 'transcript' as const,
      referenceId: 'entry_summary',
      bundle: evidenceBundle({
        transcript: [transcriptEvidence('entry_summary', 'checkpoint', {
          type: 'model_input_summary',
          content: '已完成。',
        })],
      }),
    },
    {
      label: '助手工具前文 checkpoint',
      source: 'transcript' as const,
      referenceId: 'entry_preamble',
      bundle: evidenceBundle({
        transcript: [transcriptEvidence('entry_preamble', 'checkpoint', {
          type: 'assistant_content_for_tool_call',
          content: '结果已生成。',
        })],
      }),
    },
    {
      label: 'Goal 复检 checkpoint',
      source: 'transcript' as const,
      referenceId: 'entry_recheck',
      bundle: evidenceBundle({
        transcript: [transcriptEvidence('entry_recheck', 'checkpoint', {
          type: 'goal_recheck',
          status: 'satisfied',
        })],
      }),
    },
    {
      label: 'started checkpoint',
      source: 'transcript' as const,
      referenceId: 'entry_started',
      bundle: evidenceBundle({
        transcript: [transcriptEvidence('entry_started', 'checkpoint', {
          name: 'query_layer',
          ledgerStatus: 'started',
        })],
      }),
    },
    {
      label: 'failed checkpoint',
      source: 'transcript' as const,
      referenceId: 'entry_failed_checkpoint',
      bundle: evidenceBundle({
        transcript: [transcriptEvidence('entry_failed_checkpoint', 'checkpoint', {
          name: 'query_layer',
          ledgerStatus: 'failed',
          error: '失败。',
        })],
      }),
    },
    {
      label: '失败的 transcript 工具结果',
      source: 'transcript' as const,
      referenceId: 'entry_failed',
      bundle: evidenceBundle({
        transcript: [transcriptEvidence('entry_failed', 'tool_result', {
          name: 'query_layer',
          ledgerStatus: 'failed',
          summary: '数据读取失败。',
        })],
      }),
    },
    {
      label: '失败的 durable 工具结果',
      source: 'tool_result' as const,
      referenceId: 'result_failed',
      bundle: evidenceBundle({
        toolLedger: [{
          referenceId: 'result_failed',
          resultId: 'result_failed',
          tool: 'query_layer',
          status: 'failed',
          message: '失败。',
        }],
      }),
    },
    {
      label: '中间 Artifact',
      source: 'artifact' as const,
      referenceId: 'artifact_intermediate',
      bundle: evidenceBundle({
        artifacts: [{ referenceId: 'artifact_intermediate', artifactId: 'artifact_intermediate', isIntermediate: true }],
      }),
    },
    {
      label: '未完成的 workflow',
      source: 'workflow' as const,
      referenceId: 'workflow_pending',
      bundle: evidenceBundle({
        workflow: workflowEvidence('workflow_pending', 'running', [
          workflowStepEvidence('step_pending', 'running'),
        ]),
      }),
    },
    {
      label: '失败的 workflow',
      source: 'workflow' as const,
      referenceId: 'workflow_failed',
      bundle: evidenceBundle({
        workflow: workflowEvidence('workflow_failed', 'failed', [
          workflowStepEvidence('step_failed', 'failed', { errorMessage: '失败。' }),
        ]),
      }),
    },
  ])('rejects $label as satisfied evidence', ({ source, referenceId, bundle }) => {
    expect(() => validateJudgeEvidence(goalDecision('satisfied', source, referenceId), bundle))
      .toThrow(source === 'workflow'
        ? 'workflow 整体完成'
        : `证据 '${referenceId}' 状态或来源不支持该结论`)
  })

  it.each([
    {
      label: '成功的 transcript 工具结果',
      source: 'transcript' as const,
      referenceId: 'entry_completed',
      bundle: evidenceBundle({
        transcript: [transcriptEvidence('entry_completed', 'tool_result', {
          name: 'query_layer',
          ledgerStatus: 'completed',
          summary: '成功。',
        })],
      }),
    },
    {
      label: '成功的 durable 工具结果',
      source: 'tool_result' as const,
      referenceId: 'result_completed',
      bundle: evidenceBundle({
        toolLedger: [{
          referenceId: 'result_completed',
          resultId: 'result_completed',
          tool: 'query_layer',
          status: 'completed',
          message: '成功。',
        }],
      }),
    },
    {
      label: '非中间 Artifact',
      source: 'artifact' as const,
      referenceId: 'artifact_completed',
      bundle: evidenceBundle({
        artifacts: [{ referenceId: 'artifact_completed', artifactId: 'artifact_completed', isIntermediate: false }],
      }),
    },
    {
      label: '完成的 workflow',
      source: 'workflow' as const,
      referenceId: 'workflow_completed',
      bundle: evidenceBundle({
        workflow: workflowEvidence('workflow_completed', 'completed', [
          workflowStepEvidence('step_completed', 'completed', { resultSummary: '查询返回 12 个要素。' }),
        ]),
      }),
    },
  ])('rejects $label as impossible evidence', ({ source, referenceId, bundle }) => {
    expect(() => validateJudgeEvidence(goalDecision('impossible', source, referenceId), bundle))
      .toThrow(`证据 '${referenceId}' 状态或来源不支持该结论`)
  })

  it('accepts completed durable outcomes for satisfied', () => {
    const bundle = evidenceBundle({
      toolLedger: [{
        referenceId: 'result_completed',
        resultId: 'result_completed',
        tool: 'query_layer',
        status: 'completed',
        message: '返回 12 个要素。',
      }],
      artifacts: [{
        referenceId: 'artifact_completed',
        artifactId: 'artifact_completed',
        isIntermediate: false,
      }],
      workflow: workflowEvidence('workflow_completed', 'completed', [
        workflowStepEvidence('step_completed', 'completed', { resultSummary: '返回 12 个要素。' }),
      ]),
    })
    const decision = goalJudgeDecisionSchema.parse({
      status: 'satisfied',
      reason: '已有客观结果。',
      evidence: [
        { source: 'tool_result', referenceId: 'result_completed', statement: '工具完成。' },
        { source: 'artifact', referenceId: 'artifact_completed', statement: '产物已发布。' },
        { source: 'workflow', referenceId: 'workflow_completed', statement: '工作流完成。' },
      ],
      missingCriteria: [],
    })

    expect(() => validateJudgeEvidence(decision, bundle)).not.toThrow()
  })

  it.each([
    'request_clarification',
    'enter_plan_mode',
    'submit_agent_workflow',
    'revise_agent_workflow',
    'todo_write',
  ])('does not treat completed control tool %s as completed objective work', tool => {
    const bundle = evidenceBundle({
      toolLedger: [{
        referenceId: `result_${tool}`,
        resultId: `result_${tool}`,
        tool,
        status: 'completed',
        message: '控制状态已更新。',
      }],
    })

    expect(() => validateJudgeEvidence(
      goalDecision('satisfied', 'tool_result', `result_${tool}`),
      bundle,
    )).toThrow('状态或来源不支持该结论')
  })

  it('does not finish a Goal from one completed step while its workflow is still running', () => {
    const bundle = evidenceBundle({
      toolLedger: [{
        referenceId: 'result_first_step',
        resultId: 'result_first_step',
        objectiveRevision: 1,
        tool: 'query_layer',
        status: 'completed',
        message: '第一步完成。',
      }],
      workflow: workflowEvidence('workflow_running', 'running', [
        workflowStepEvidence('step_completed', 'completed', { resultSummary: '第一步完成。' }),
        workflowStepEvidence('step_pending', 'pending'),
      ]),
    })

    expect(() => validateJudgeEvidence(
      goalDecision('satisfied', 'tool_result', 'result_first_step'),
      bundle,
    )).toThrow('workflow 整体完成')
  })

  it('does not turn a rejected tool or one failed path into Goal impossible', () => {
    const rejected = evidenceBundle({
      transcript: [transcriptEvidence('entry_rejected', 'tool_result', {
        name: 'query_layer',
        ledgerStatus: 'rejected',
        summary: '当前阶段未开放。',
      })],
    })
    expect(() => validateJudgeEvidence(
      goalDecision('impossible', 'transcript', 'entry_rejected'),
      rejected,
    )).toThrow('状态或来源不支持该结论')

    const failed = evidenceBundle({
      transcript: [transcriptEvidence('entry_failed_only', 'tool_result', {
        name: 'query_layer',
        objectiveRevision: 1,
        ledgerStatus: 'failed',
        summary: '临时查询失败。',
      })],
    })
    expect(() => validateJudgeEvidence(
      goalDecision('impossible', 'transcript', 'entry_failed_only'),
      failed,
    )).toThrow('终态 failed workflow')
  })

  it('does not treat a failed step in an adjustable workflow as Goal impossible', () => {
    const bundle = evidenceBundle({
      workflow: workflowEvidence('workflow_adjusting', 'adjusting', [
        workflowStepEvidence('step_failed', 'failed', { errorMessage: '临时查询失败。' }),
      ]),
    })

    expect(() => validateJudgeEvidence(
      goalDecision('impossible', 'workflow', 'step_failed'),
      bundle,
    )).toThrow('状态或来源不支持该结论')
  })

  it('requires at least one objective outcome from the current revision', () => {
    const bundle = evidenceBundle({
      objectiveRevision: 2,
      toolLedger: [{
        referenceId: 'result_revision_1',
        resultId: 'result_revision_1',
        objectiveRevision: 1,
        tool: 'query_layer',
        status: 'completed',
        message: '旧范围查询完成。',
      }],
      artifacts: [{
        referenceId: 'artifact_revision_1',
        artifactId: 'artifact_revision_1',
        objectiveRevision: 1,
        isIntermediate: false,
      }],
    })
    const decision = goalJudgeDecisionSchema.parse({
      status: 'satisfied',
      reason: '错误复用了旧 revision。',
      evidence: [
        { source: 'tool_result', referenceId: 'result_revision_1', statement: '旧结果。' },
        { source: 'artifact', referenceId: 'artifact_revision_1', statement: '旧产物。' },
      ],
      missingCriteria: [],
    })

    expect(() => validateJudgeEvidence(decision, bundle)).toThrow('objective revision 2')
  })

  it('accepts a completed objective outcome from the current revision without a workflow', () => {
    const bundle = evidenceBundle({
      objectiveRevision: 2,
      toolLedger: [{
        referenceId: 'result_revision_2',
        resultId: 'result_revision_2',
        objectiveRevision: 2,
        tool: 'query_layer',
        status: 'completed',
        message: '新范围查询完成。',
      }],
    })

    expect(() => validateJudgeEvidence(
      goalDecision('satisfied', 'tool_result', 'result_revision_2'),
      bundle,
    )).not.toThrow()
  })

  it('accepts explicit failed outcomes for impossible', () => {
    const bundle = evidenceBundle({
      transcript: [transcriptEvidence('entry_failed', 'tool_result', {
        name: 'query_layer',
        ledgerStatus: 'failed',
        summary: '必需数据集不存在。',
      })],
      workflow: workflowEvidence('workflow_failed', 'failed', [
        workflowStepEvidence('step_failed', 'failed', { errorMessage: '必需数据集不存在。' }),
      ]),
    })
    const decision = goalJudgeDecisionSchema.parse({
      status: 'impossible',
      reason: '必需数据已证实不可用。',
      evidence: [
        { source: 'transcript', referenceId: 'entry_failed', statement: '数据读取失败。' },
        { source: 'workflow', referenceId: 'step_failed', statement: '必需步骤失败。' },
      ],
      missingCriteria: [],
    })

    expect(() => validateJudgeEvidence(decision, bundle)).not.toThrow()
  })

  it('validates references but allows contextual evidence for incomplete', () => {
    const bundle = evidenceBundle({
      transcript: [transcriptEvidence('entry_user', 'message', { role: 'user', content: '请完成检查。' })],
    })

    expect(() => validateJudgeEvidence(goalDecision('incomplete', 'transcript', 'entry_user'), bundle)).not.toThrow()
  })
})

function goalInput() {
  return {
    condition: '图层已完成检查并有客观证据。',
    acceptanceCriteria: ['至少有一条工具或 Artifact 证据。'],
    maxRechecks: 2,
    deadlineAt: null,
    maxTokenBudget: 1000,
  }
}

function evidenceBundle(
  overrides: Partial<CanonicalGoalEvidenceBundle> = {},
): CanonicalGoalEvidenceBundle {
  return {
    objectiveRevision: 1,
    transcript: [],
    toolLedger: [],
    artifacts: [],
    workflow: null,
    ...overrides,
  }
}

function transcriptEvidence(
  entryId: string,
  kind: CanonicalGoalEvidenceBundle['transcript'][number]['kind'],
  payload: Record<string, unknown>,
): CanonicalGoalEvidenceBundle['transcript'][number] {
  return { entryId, kind, timestamp: '2026-08-09T00:00:00.000Z', payload }
}

function workflowEvidence(
  agentWorkflowId: string,
  status: string,
  steps: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    referenceId: agentWorkflowId,
    agentWorkflowId,
    objectiveRevision: 1,
    revision: 1,
    goal: '检查图层。',
    status,
    completedAt: status === 'completed' || status === 'failed'
      ? '2026-08-09T00:01:00.000Z'
      : null,
    steps,
  }
}

function workflowStepEvidence(
  stepId: string,
  status: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    referenceId: stepId,
    stepId,
    title: '检查数据',
    phase: 'analyze',
    toolName: 'query_layer',
    ownerAgentId: 'supervisor',
    status,
    resultSummary: null,
    errorMessage: null,
    completedAt: status === 'completed' || status === 'failed' || status === 'blocked'
      ? '2026-08-09T00:01:00.000Z'
      : null,
    ...overrides,
  }
}

function goalDecision(
  status: 'satisfied' | 'incomplete' | 'impossible',
  source: 'transcript' | 'tool_result' | 'artifact' | 'workflow',
  referenceId: string,
) {
  return goalJudgeDecisionSchema.parse({
    status,
    reason: '测试判定。',
    evidence: [{ source, referenceId, statement: '测试证据。' }],
    missingCriteria: status === 'incomplete' ? ['尚缺少客观结果。'] : [],
  })
}

function fakeCompletions(
  decision: Record<string, unknown>,
  capture?: (request: Record<string, unknown>) => void,
): Pick<ModelCompletionService, 'completeStructured'> {
  const completeStructured: ModelCompletionService['completeStructured'] = async (request, schema) => {
    capture?.(request as unknown as Record<string, unknown>)
    return {
      content: schema.parse(decision),
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cacheHitInputTokens: 0,
        cacheMissInputTokens: 10,
        cacheMeasuredInputTokens: 10,
        cacheDetailReported: 1,
      },
      resultCache: 'bypass',
    }
  }
  return { completeStructured }
}

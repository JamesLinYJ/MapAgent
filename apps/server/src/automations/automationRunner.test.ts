// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 执行器测试
//
//   文件:       automationRunner.test.ts
//
//   日期:       2026年07月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import type { AuthContext } from '../security/types.js'
import { AutomationRunner, type AutomationRunnerOptions } from './automationRunner.js'
import { createAutomationExecutionState, withExecutionState } from './automationExecutionState.js'
import { automationDefinitionSchema, automationRunRecordSchema, type AutomationRunRecord } from './schemas.js'

describe('AutomationRunner queue dispatch', () => {
  it('resumes the persisted scheduled run after approval instead of creating a new run', async () => {
    const getScheduledTask = vi.fn(() => {
      throw new Error('审批恢复不应重新进入定时触发创建路径。')
    })
    const record = automationRunRecordSchema.parse({
      automationRunId: 'automation_run_existing',
      automationId: 'automation_meteorology',
      automationRevision: 3,
      scheduledTaskId: 'scheduled_task_1',
      workspaceId: 'workspace_1',
      createdByUserId: 'user_1',
      runId: 'run_1',
      status: 'completed',
      currentStep: null,
      triggerKind: 'schedule',
      startedAt: '2026-07-18T00:00:00.000Z',
      completedAt: '2026-07-18T00:01:00.000Z',
    })
    const runner = new AutomationRunner({
      automations: {
        getAutomationRunRecord: vi.fn(async () => record),
        getScheduledTask,
      },
    } as unknown as AutomationRunnerOptions)

    await expect(runner.executeQueuedJob({
      automationRunId: record.automationRunId,
      scheduledTaskId: record.scheduledTaskId,
      automationId: record.automationId,
      workspaceId: record.workspaceId,
      triggeredByUserId: record.createdByUserId,
      triggerKind: 'schedule',
      dispatchId: 'approval_resume_1',
      prompt: '',
      parameters: {},
    }, 'queue_job_resume')).resolves.toBeUndefined()
    expect(getScheduledTask).not.toHaveBeenCalled()
  })

  it('rejects a queue payload whose ownership differs from the persisted run', async () => {
    const record = automationRunRecordSchema.parse({
      automationRunId: 'automation_run_existing',
      automationId: 'automation_meteorology',
      automationRevision: 3,
      scheduledTaskId: null,
      workspaceId: 'workspace_1',
      createdByUserId: 'user_1',
      runId: null,
      status: 'queued',
      currentStep: 'trigger',
      triggerKind: 'manual',
      startedAt: '2026-07-18T00:00:00.000Z',
    })
    const runner = new AutomationRunner({
      automations: { getAutomationRunRecord: vi.fn(async () => record) },
    } as unknown as AutomationRunnerOptions)

    await expect(runner.executeQueuedJob({
      automationRunId: record.automationRunId,
      scheduledTaskId: null,
      automationId: record.automationId,
      workspaceId: 'workspace_other',
      triggeredByUserId: record.createdByUserId,
      triggerKind: 'manual',
      dispatchId: 'manual_1',
      prompt: '',
      parameters: {},
    }, 'queue_job_manual')).rejects.toThrow('载荷与持久化运行归属不一致')
  })

  it('fails transparently instead of replaying a node interrupted in an unknown side-effect state', async () => {
    const definition = automationDefinitionSchema.parse({
      automationId: 'automation_interrupted',
      name: '中断恢复测试',
      description: '验证未知执行结果不会自动重放。',
      version: '1.0.0',
      revision: 1,
      lifecycle: 'published',
      enabled: true,
      parametersSchema: { type: 'object', additionalProperties: false },
      defaultParameters: {},
      graph: {
        entryNodeId: 'trigger',
        nodes: [
          { nodeId: 'trigger', type: 'trigger', label: '触发', description: '', position: { x: 0, y: 0 }, config: {} },
          { nodeId: 'output', type: 'output', label: '输出', description: '', position: { x: 200, y: 0 }, config: { outputs: {} } },
        ],
        edges: [{ edgeId: 'trigger-output', sourceNodeId: 'trigger', targetNodeId: 'output', sourcePort: 'default' }],
      },
    })
    const executionState = createAutomationExecutionState({
      definition,
      prompt: '执行测试',
      parameters: {},
      executionTarget: { sessionId: 'session_1', threadId: 'thread_1', runId: 'run_1' },
    })
    executionState.nodeRuns[0] = {
      ...executionState.nodeRuns[0]!,
      status: 'running',
      attempt: 1,
      startedAt: '2026-07-18T00:00:00.000Z',
    }
    let stored: AutomationRunRecord = automationRunRecordSchema.parse({
      automationRunId: 'automation_run_interrupted',
      automationId: definition.automationId,
      automationRevision: 1,
      scheduledTaskId: null,
      workspaceId: 'workspace_1',
      createdByUserId: 'user_1',
      runId: 'run_1',
      status: 'running',
      currentStep: 'trigger',
      triggerKind: 'agent',
      metadata: withExecutionState({}, executionState),
      nodeRuns: executionState.nodeRuns,
      startedAt: '2026-07-18T00:00:00.000Z',
    })
    const runner = new AutomationRunner({
      automations: {
        getAutomationRunRecord: vi.fn(async () => stored),
        updateAutomationRunRecord: vi.fn(async (_runId, input) => {
          const { expectedStatuses: _expectedStatuses, ...patch } = input
          stored = automationRunRecordSchema.parse({ ...stored, ...patch })
          return stored
        }),
      },
    } as unknown as AutomationRunnerOptions)

    await expect(runner.executeAttached(
      stored.automationRunId,
      testAuth(),
      new AbortController().signal,
    )).rejects.toThrow('结果状态不明确')
    expect(stored).toMatchObject({
      status: 'failed',
      currentStep: 'trigger',
      nodeRuns: expect.arrayContaining([
        expect.objectContaining({ nodeId: 'trigger', status: 'failed' }),
        expect.objectContaining({ nodeId: 'output', status: 'pending' }),
      ]),
    })
  })
})

function testAuth(): AuthContext {
  return {
    userId: 'user_1',
    subject: 'user_1',
    email: 'user@example.com',
    displayName: '测试用户',
    authSessionId: 'auth_session_1',
    authSessionExpiresAt: null,
    csrfToken: 'csrf',
    defaultWorkspaceId: 'workspace_1',
    roles: [{ workspaceId: 'workspace_1', role: 'analyst' }],
  }
}

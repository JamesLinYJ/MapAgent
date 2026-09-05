// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 持久分发测试
//
//   文件:       scheduledTaskService.test.ts
//
//   日期:       2026年07月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { AuthContext } from '../security/types.js'
import { createAutomationExecutionState, withExecutionState } from './automationExecutionState.js'
import { automationDefinitionSchema, automationRunRecordSchema, type AutomationRunRecord } from './schemas.js'
import { ScheduledTaskService } from './scheduledTaskService.js'

const definition = automationDefinitionSchema.parse({
  automationId: 'automation_dispatch_test',
  name: '持久分发测试',
  description: '验证 Automation 运行记录先于队列写入保存分发身份。',
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

describe('ScheduledTaskService Automation dispatch', () => {
  it('persists a stable queue identity before the manual run is enqueued', async () => {
    const fixture = createFixture()
    const result = await fixture.service.startAutomation(testAuth(), {
      automationId: definition.automationId,
      prompt: '执行持久分发测试',
    })

    const createInput = fixture.createAutomationRunRecord.mock.calls[0]?.[0]
    expect(createInput).toEqual(expect.objectContaining({
      status: 'queued',
      metadata: expect.objectContaining({
        dispatchId: expect.stringMatching(/^automation_dispatch_/u),
        queueJobId: result.jobId,
      }),
    }))
    expect(result.jobId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(fixture.enqueueAutomationRun).toHaveBeenCalledWith(
      expect.objectContaining({ automationRunId: result.automationRun.automationRunId }),
      result.jobId,
    )
    expect(result.automationRun.metadata.queueJobId).toBe(result.jobId)
  })

  it('marks a known enqueue failure as failed instead of leaving a false queued success', async () => {
    const fixture = createFixture()
    fixture.enqueueAutomationRun.mockRejectedValueOnce(new Error('queue unavailable'))

    await expect(fixture.service.startAutomation(testAuth(), {
      automationId: definition.automationId,
      prompt: '执行失败路径测试',
    })).rejects.toThrow('未能进入持久队列')

    expect(fixture.stored?.status).toBe('failed')
    expect(fixture.stored?.errorMessage).toContain('未能进入持久队列')
    expect(fixture.updateAutomationRunRecord).toHaveBeenCalledWith(
      fixture.stored?.automationRunId,
      expect.objectContaining({ status: 'failed', expectedStatuses: ['queued'] }),
    )
  })

  it('reuses the persisted queue id when recovering a run left queued by a process interruption', async () => {
    const fixture = createFixture()
    const queueJobId = '29d00b1b-d64f-4903-ae4a-b319d6baaf1d'
    const state = createAutomationExecutionState({
      definition,
      prompt: '恢复排队任务',
      parameters: {},
    })
    fixture.stored = automationRunRecordSchema.parse({
      automationRunId: 'automation_run_recover',
      automationId: definition.automationId,
      automationRevision: definition.revision,
      scheduledTaskId: null,
      workspaceId: 'workspace_1',
      createdByUserId: 'user_1',
      runId: null,
      status: 'queued',
      currentStep: definition.graph.entryNodeId,
      triggerKind: 'manual',
      metadata: withExecutionState({ dispatchId: 'automation_dispatch_recover', queueJobId }, state),
      nodeRuns: state.nodeRuns,
      startedAt: '2026-07-18T00:00:00.000Z',
    })
    fixture.listQueuedAutomationRuns.mockResolvedValueOnce([fixture.stored])

    await fixture.service.reconcileQueuedAutomationRuns()

    expect(fixture.enqueueAutomationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        automationRunId: 'automation_run_recover',
        dispatchId: 'automation_dispatch_recover',
        prompt: '恢复排队任务',
      }),
      queueJobId,
    )
    expect(fixture.updateAutomationRunRecord).not.toHaveBeenCalled()
  })

  it('enforces Automation read permission for a run in the active workspace', async () => {
    const fixture = createFixture()
    const started = await fixture.service.startAutomation(testAuth(), {
      automationId: definition.automationId,
      prompt: '读取运行记录',
    })
    fixture.authorizationEnforce.mockClear()

    await expect(fixture.service.getAutomationRun(testAuth(), started.automationRun.automationRunId))
      .resolves.toEqual(started.automationRun)
    expect(fixture.authorizationEnforce).toHaveBeenCalledWith(testAuth(), 'automation', 'read', {
      workspaceId: 'workspace_1',
      resourceId: definition.automationId,
    })
  })

  it('hides Automation runs owned by another workspace before authorization', async () => {
    const fixture = createFixture()
    const started = await fixture.service.startAutomation(testAuth(), {
      automationId: definition.automationId,
      prompt: '跨工作区读取运行记录',
    })
    fixture.authorizationEnforce.mockClear()

    await expect(fixture.service.getAutomationRun({
      ...testAuth(),
      defaultWorkspaceId: 'workspace_2',
      roles: [{ workspaceId: 'workspace_2', role: 'analyst' }],
    }, started.automationRun.automationRunId)).rejects.toThrow('不存在')
    expect(fixture.authorizationEnforce).not.toHaveBeenCalled()
  })
})

function createFixture() {
  let stored: AutomationRunRecord | null = null
  const createAutomationRunRecord = vi.fn(async (input: Record<string, unknown>) => {
    stored = automationRunRecordSchema.parse({
      ...input,
      startedAt: '2026-07-18T00:00:00.000Z',
    })
    return stored
  })
  const updateAutomationRunRecord = vi.fn(async (_automationRunId: string, input: Record<string, unknown>) => {
    if (!stored) throw new Error('测试 Automation 运行记录不存在。')
    const { expectedStatuses: _expectedStatuses, ...patch } = input
    stored = automationRunRecordSchema.parse({ ...stored, ...patch })
    return stored
  })
  const enqueueAutomationRun = vi.fn(async (_payload: Record<string, unknown>, queueJobId: string) => queueJobId)
  const listQueuedAutomationRuns = vi.fn(async (): Promise<AutomationRunRecord[]> => [])
  const authorizationEnforce = vi.fn(async () => undefined)
  const service = new ScheduledTaskService({
    automations: {
      createAutomationRunRecord,
      getAutomationRunRecord: vi.fn(async () => stored),
      updateAutomationRunRecord,
      listQueuedAutomationRuns,
    },
    conversations: {},
    definitions: { requirePublished: vi.fn(async () => definition) },
    compiler: {
      compile: vi.fn(() => ({ definition, validateParameters: vi.fn() })),
    },
    jobQueue: { enqueueAutomationRun },
    usageStats: { assertWorkspaceCanStartModelRun: vi.fn() },
    security: {
      authorization: {
        enforce: authorizationEnforce,
        audit: vi.fn(async () => undefined),
      },
    },
    backgroundTasks: {},
    runTasks: {},
  } as unknown as ConstructorParameters<typeof ScheduledTaskService>[0])
  return {
    service,
    createAutomationRunRecord,
    updateAutomationRunRecord,
    enqueueAutomationRun,
    listQueuedAutomationRuns,
    authorizationEnforce,
    get stored() { return stored },
    set stored(value: AutomationRunRecord | null) { stored = value },
  }
}

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

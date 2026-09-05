// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent Automation 调用服务测试
//
//   文件:       automationInvocationService.test.ts
//
//   日期:       2026年07月17日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import type { ToolDef } from '../framework/types.js'
import type { AuthContext } from '../security/types.js'
import { AutomationCompiler } from './automationCompiler.js'
import {
  automationDefinitionSchema,
  automationRunRecordSchema,
  type AutomationDefinition,
} from './schemas.js'
import {
  AutomationInvocationService,
  type AutomationInvocationDefinitions,
  type AutomationInvocationRunner,
  type AutomationInvocationStore,
} from './automationInvocationService.js'

describe('AutomationInvocationService', () => {
  it('lists only published automations explicitly exposed to Agent invocation', async () => {
    const visible = definition()
    const hidden = { ...definition(), automationId: 'hidden', agentInvocation: { enabled: false, description: '', examples: [] } }
    const service = createService({ definitions: [visible, hidden] }).service

    await expect(service.listAvailable(auth())).resolves.toEqual([expect.objectContaining({
      automationId: visible.automationId,
      invocationDescription: visible.agentInvocation.description,
    })])
  })

  it('keeps the published revision callable while a newer workspace draft is being edited', async () => {
    const published = { ...definition(), publishedRevision: 1 }
    const draftHead: AutomationDefinition = {
      ...published,
      revision: 2,
      lifecycle: 'draft',
      agentInvocation: { enabled: false, description: '', examples: [] },
    }
    const service = createService({ definitions: [draftHead], publishedDefinitions: [published] }).service

    await expect(service.listAvailable(auth())).resolves.toEqual([
      expect.objectContaining({
        automationId: published.automationId,
        invocationDescription: published.agentInvocation.description,
      }),
    ])
  })

  it('executes inside the current Agent run without creating a second orchestration run', async () => {
    const fixture = createService({ definitions: [definition()] })
    const result = await fixture.service.executeAttached(auth(), {
      automationId: 'automation_agent_test',
      prompt: '分析当前数据。',
      parameters: { horizonMinutes: 180 },
      sessionId: 'session_1',
      threadId: 'thread_1',
      runId: 'run_1',
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      automationId: 'automation_agent_test',
      answer: '未来三小时降水趋势稳定。',
      artifacts: [expect.objectContaining({ artifactId: 'artifact_map' })],
    })
    expect(fixture.created).toHaveLength(1)
    expect(fixture.created[0]).toMatchObject({
      runId: 'run_1',
      triggerKind: 'agent',
      scheduledTaskId: null,
    })
    expect(fixture.executeAttached).toHaveBeenCalledWith(
      expect.stringMatching(/^automation_run_/u),
      expect.objectContaining({ userId: 'user_1' }),
      expect.any(AbortSignal),
    )
  })

  it('rejects missing current-thread input before creating an automation run', async () => {
    const guardedDefinition = definition({
      requirements: [{
        resource: 'meteorological_files',
        scope: 'thread',
        minimumCount: 2,
        readyOnly: true,
      }],
    })
    const fixture = createService({
      definitions: [guardedDefinition],
      meteorologicalDatasets: [meteorologicalDataset('thread_other')],
    })

    await expect(fixture.service.executeAttached(auth(), {
      automationId: 'automation_agent_test',
      prompt: '分析当前数据。',
      parameters: { horizonMinutes: 180 },
      sessionId: 'session_1',
      threadId: 'thread_1',
      runId: 'run_1',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      name: 'AutomationInputRequirementError',
      failureSource: 'data',
      code: 'automation_input_requirement_failed',
      message: expect.stringContaining('当前对话至少 2 个可用气象文件'),
    })
    expect(fixture.created).toHaveLength(0)
    expect(fixture.executeAttached).not.toHaveBeenCalled()
    expect(fixture.countMeteorologicalDatasets).toHaveBeenCalledWith({
      workspaceId: 'workspace_1',
      sessionId: 'session_1',
      threadId: 'thread_1',
      status: 'ready',
    })
  })

  it('accepts an invocation only when the declared scoped input is ready', async () => {
    const guardedDefinition = definition({
      requirements: [{
        resource: 'meteorological_files',
        scope: 'thread',
        minimumCount: 2,
        readyOnly: true,
      }],
    })
    const fixture = createService({
      definitions: [guardedDefinition],
      meteorologicalDatasets: [
        meteorologicalDataset('thread_1'),
        meteorologicalDataset('thread_1', 'dataset_2'),
      ],
    })

    await expect(fixture.service.executeAttached(auth(), {
      automationId: 'automation_agent_test',
      prompt: '分析当前数据。',
      parameters: { horizonMinutes: 180 },
      sessionId: 'session_1',
      threadId: 'thread_1',
      runId: 'run_1',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ automationId: 'automation_agent_test' })
    expect(fixture.created).toHaveLength(1)
  })

  it('rejects an attachment that does not belong to the current session and thread', async () => {
    const fixture = createService({ definitions: [definition()] })

    await expect(fixture.service.executeAttached(auth(), {
      automationId: 'automation_agent_test',
      prompt: '分析当前数据。',
      sessionId: 'other_session',
      threadId: 'thread_1',
      runId: 'run_1',
      signal: new AbortController().signal,
    })).rejects.toThrow('附着目标与当前 Agent 运行不一致')
    expect(fixture.created).toHaveLength(0)
  })

  it('lists automation runs across the current session by default and reads their persisted facts', async () => {
    const fixture = createService({ definitions: [definition()] })
    const summaries = await fixture.service.listAttachedRuns(auth(), {
      sessionId: 'session_1',
      threadId: 'thread_1',
      runId: 'run_current',
      scope: 'session',
    })

    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ automationRunId: 'automation_run_visible', threadId: 'thread_1' }),
      expect.objectContaining({ automationRunId: 'automation_run_other_thread', threadId: 'thread_other' }),
    ]))
    await expect(fixture.service.readAttachedRun(auth(), {
      automationRunId: 'automation_run_visible',
      sessionId: 'session_1',
      threadId: 'thread_1',
      runId: 'run_current',
    })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ outputs: { answer: '未来三小时降水趋势稳定。' } }),
      artifacts: [expect.objectContaining({ artifactId: 'artifact_map' })],
    }))
  })

  it('can explicitly restrict automation run listing to the current thread', async () => {
    const fixture = createService({ definitions: [definition()] })

    await expect(fixture.service.listAttachedRuns(auth(), {
      sessionId: 'session_1',
      threadId: 'thread_1',
      runId: 'run_current',
      scope: 'thread',
    })).resolves.toEqual([
      expect.objectContaining({ automationRunId: 'automation_run_visible', threadId: 'thread_1' }),
    ])
  })

  it('rejects reading an automation run attached to another session', async () => {
    const fixture = createService({ definitions: [definition()] })

    await expect(fixture.service.readAttachedRun(auth(), {
      automationRunId: 'automation_run_other_session',
      sessionId: 'session_1',
      threadId: 'thread_1',
      runId: 'run_current',
    })).rejects.toThrow('不属于当前会话')
  })
})

function createService(input: {
  definitions: AutomationDefinition[]
  publishedDefinitions?: AutomationDefinition[]
  meteorologicalDatasets?: ReturnType<typeof meteorologicalDataset>[]
}) {
  const created: Parameters<AutomationInvocationStore['createAutomationRunRecord']>[0][] = []
  const completedRun = (automationRunId: string, runId: string) => automationRunRecordSchema.parse({
    automationRunId,
    automationId: 'automation_agent_test',
    automationRevision: 1,
    scheduledTaskId: null,
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    runId,
    status: 'completed',
    currentStep: 'output',
    triggerKind: 'agent',
    outputs: { answer: '未来三小时降水趋势稳定。' },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    nodeRuns: [{
      nodeId: 'answer',
      nodeType: 'tool',
      label: '生成回答',
      status: 'completed',
      attempt: 1,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      output: { artifacts: [{ artifactId: 'artifact_map' }] },
    }],
  })
  const storedRuns = [
    completedRun('automation_run_visible', 'run_1'),
    completedRun('automation_run_other_thread', 'run_other'),
    completedRun('automation_run_other_session', 'run_other_session'),
  ]
  const countMeteorologicalDatasets = vi.fn(async (filters: {
    workspaceId: string
    sessionId: string
    threadId: string | null
    status: string | null
  }) => (input.meteorologicalDatasets ?? [])
    .filter(dataset => dataset.workspaceId === filters.workspaceId)
    .filter(dataset => dataset.sessionId === filters.sessionId)
    .filter(dataset => filters.threadId === null || dataset.threadId === filters.threadId)
    .filter(dataset => filters.status === null || dataset.status === filters.status)
    .length)
  const store: AutomationInvocationStore = {
    getRun: runId => ({
      id: runId,
      sessionId: runId === 'run_other_session' ? 'session_other' : 'session_1',
      threadId: runId === 'run_other' ? 'thread_other' : runId === 'run_other_session' ? 'thread_other_session' : 'thread_1',
      workspaceId: 'workspace_1',
      state: {
        artifacts: runId === 'run_1' ? [{
          artifactId: 'artifact_map',
          artifactType: 'raster_cog',
          name: '短临地图',
          uri: '/api/v1/results/artifact_map/file',
          display: { surfaces: ['map', 'download'], primarySurface: 'map' },
        }, {
          artifactId: 'artifact_unrelated',
          artifactType: 'table',
          name: '其它流程产物',
          uri: '/api/v1/results/artifact_unrelated/file',
          display: { surfaces: ['download'], primarySurface: 'download' },
        }] : [],
      },
    }),
    createAutomationRunRecord: async record => {
      created.push(record)
      return automationRunRecordSchema.parse({ ...record, startedAt: new Date().toISOString() })
    },
    getAutomationRunRecord: async automationRunId => storedRuns.find(run => run.automationRunId === automationRunId) ?? null,
    listAutomationRuns: async () => storedRuns,
    countMeteorologicalDatasets,
  }
  const definitions: AutomationInvocationDefinitions = {
    list: async () => ({ definitions: input.definitions, diagnostics: [], validation: {} }),
    requirePublished: async (_workspaceId, automationId) => {
      const found = input.publishedDefinitions?.find(item => item.automationId === automationId)
        ?? input.definitions.find(item => item.automationId === automationId)
      if (!found) throw new Error('Automation 不存在。')
      return found
    },
    authorizeRead: async () => undefined,
    authorizeExecution: async () => undefined,
  }
  const compiler = new AutomationCompiler({ get: name => name === 'produce_answer' ? answerTool() : undefined })
  const executeAttached = vi.fn<AutomationInvocationRunner['executeAttached']>(async (automationRunId, _auth, _signal) => (
    automationRunRecordSchema.parse({
      automationRunId,
      automationId: 'automation_agent_test',
      automationRevision: 1,
      scheduledTaskId: null,
      workspaceId: 'workspace_1',
      createdByUserId: 'user_1',
      runId: 'run_1',
      status: 'completed',
      currentStep: 'output',
      triggerKind: 'agent',
      outputs: { answer: '未来三小时降水趋势稳定。' },
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      nodeRuns: [{
        nodeId: 'answer',
        nodeType: 'tool',
        label: '生成回答',
        status: 'completed',
        attempt: 1,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        output: { artifacts: [{ artifactId: 'artifact_map' }] },
      }],
    })
  ))
  const runner: AutomationInvocationRunner = { executeAttached }
  return {
    service: new AutomationInvocationService({ store, definitions, compiler, runner }),
    created,
    executeAttached,
    countMeteorologicalDatasets,
  }
}

function definition(
  invocation: Partial<AutomationDefinition['agentInvocation']> = {},
): AutomationDefinition {
  return automationDefinitionSchema.parse({
    automationId: 'automation_agent_test',
    name: '会话分析流程',
    description: '通过确定性工具生成回答。',
    version: '1.0.0',
    revision: 1,
    lifecycle: 'published',
    enabled: true,
    parametersSchema: {
      type: 'object',
      properties: { horizonMinutes: { type: 'number' } },
      required: ['horizonMinutes'],
      additionalProperties: false,
    },
    defaultParameters: { horizonMinutes: 180 },
    requiredTools: ['produce_answer'],
    outputType: 'conversation',
    agentInvocation: {
      enabled: true,
      description: '当用户要求分析当前连续时次数据时执行。',
      examples: ['分析当前数据。'],
      ...invocation,
    },
    graph: {
      schemaVersion: 1,
      entryNodeId: 'trigger',
      nodes: [
        { nodeId: 'trigger', type: 'trigger', label: '触发', description: '', position: { x: 0, y: 0 }, config: {} },
        {
          nodeId: 'answer', type: 'tool', label: '生成回答', description: '', position: { x: 200, y: 0 },
          config: {
            toolName: 'produce_answer',
            arguments: {
              prompt: { source: 'input', path: 'prompt' },
              horizon_minutes: { source: 'input', path: 'parameters.horizonMinutes' },
            },
            approvalMode: 'auto',
            retry: { maxAttempts: 1, backoffSeconds: 0 },
          },
        },
        {
          nodeId: 'output', type: 'output', label: '输出', description: '', position: { x: 400, y: 0 },
          config: { outputs: { answer: { source: 'node', nodeId: 'answer', path: 'payload.answer' } } },
        },
      ],
      edges: [
        { edgeId: 'trigger-answer', sourceNodeId: 'trigger', targetNodeId: 'answer', sourcePort: 'default' },
        { edgeId: 'answer-output', sourceNodeId: 'answer', targetNodeId: 'output', sourcePort: 'success' },
      ],
    },
  })
}

function meteorologicalDataset(threadId: string, datasetId = 'dataset_1') {
  const timestamp = new Date().toISOString()
  return {
    datasetId,
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'workspace' as const,
    sessionId: 'session_1',
    threadId,
    filename: `${datasetId}.nc`,
    originalFilename: `${datasetId}.nc`,
    fileId: `file_${datasetId}`,
    fileRelativePath: `sessions/session_1/threads/${threadId}/files/${datasetId}.nc`,
    sizeBytes: 1024,
    contentHash: null,
    mediaType: 'application/x-netcdf',
    status: 'ready',
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function answerTool(): ToolDef {
  return {
    name: 'produce_answer',
    label: '生成测试回答',
    description: '根据输入生成确定性回答。',
    prompt: '仅用于 Automation 调用服务测试。',
    group: '测试',
    tags: ['test'],
    isReadOnly: true,
    isDestructive: false,
    executionSurfaces: ['automation'],
    jsonSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' }, horizon_minutes: { type: 'number' } },
      required: ['prompt', 'horizon_minutes'],
      additionalProperties: false,
    },
    handler: async () => ({
      message: '完成',
      payload: { answer: '未来三小时降水趋势稳定。' },
      warnings: [],
      resultId: 'result_answer',
      source: 'test',
    }),
  }
}

function auth(): AuthContext {
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

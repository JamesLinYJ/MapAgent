// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具执行协调器测试
//
//   文件:       toolExecutionCoordinator.test.ts
//
//   日期:       2026年06月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import { agentStepContextSchema, type AgentStepContext } from '@geo-agent-platform/shared-types/agent-step-context'
import {
  toolInvocationRecordSchema,
  type AgentToolPlanEntry,
  type ToolInvocationRecord,
} from '@geo-agent-platform/shared-types/tool-runtime'
import { ItemSink } from '../conversation/itemSink.js'
import { ToolRegistry } from '../framework/registry.js'
import type { ToolProvider, ToolResult } from '../framework/types.js'
import type { AgentWorkflow, ConversationItem } from '../schemas/types.js'
import type { ConversationItemWrite } from '../conversation/itemUpdates.js'
import type { ToolExecutionStore } from '../store/runtimePorts.js'
import type {
  StartToolInvocationInput,
  TerminalToolInvocationInput,
  ToolInvocationEffectCommit,
} from '../store/postgres/conversationPersistencePorts.js'
import { ToolResultCommitService } from '../tools/resultPersistence.js'
import { formatToolResultForModel, ToolExecutionCoordinator, validateAgentWorkflowDraft } from './toolExecutionCoordinator.js'
import { RunEventSink } from './turnRunner.js'
import {
  advanceAgentWorkflowObjectiveRevision,
  completeAgentWorkflowStep,
  createAgentWorkflow,
  reviseAgentWorkflow,
  startAgentWorkflowStep,
} from './agentWorkflowState.js'
import { agentContextDigest } from '../agent-runtime/step/agentContextDigest.js'
import { ToolCatalog, sdkToolDescriptorSource } from '../agent-runtime/tools/ToolCatalog.js'
import { compileDirectToolPlan } from '../agent-runtime/tools/ToolPlanCompiler.js'
import { RuntimeHookRegistry } from '../agent-runtime/hooks/RuntimeHookRegistry.js'

describe('formatToolResultForModel', () => {
  it('keeps valueRefs visible while summarizing oversized payloads', () => {
    const result: ToolResult = {
      message: 'create_nowcast_sequence 执行完成',
      payload: {
        datasets: Array.from({ length: 60 }, (_, index) => ({
          filename: `lead_${String(index).padStart(3, '0')}.nc`,
          metadata: {
            variables: Array.from({ length: 20 }, (_item, variableIndex) => ({
              name: `QPF_${variableIndex}`,
              bounds: [115.5, 27, 124.5, 32],
            })),
          },
        })),
      },
      warnings: [],
      resultId: 'result_sequence',
      source: 'test',
      valueRefs: [
        { refId: 'ref_dataset', kind: 'meteorological_dataset', label: 'lead_000.nc', value: {} },
        { refId: 'ref_sequence', kind: 'nowcast_sequence', label: '短时临近预报（短临）气象序列', value: {} },
      ],
    }

    const formatted = JSON.parse(formatToolResultForModel(result, 1200)) as Record<string, unknown>

    expect(formatted.valueRefs).toEqual([
      { refId: 'ref_dataset', kind: 'meteorological_dataset', label: 'lead_000.nc', unit: null },
      { refId: 'ref_sequence', kind: 'nowcast_sequence', label: '短时临近预报（短临）气象序列', unit: null },
    ])
    expect(formatted.payloadSummary).toMatchObject({
      datasets: {
        type: 'array',
        length: 60,
      },
    })
    expect(JSON.stringify(formatted)).not.toContain('lead_059.nc')
  })

  it('keeps non-blocking planning guidance visible in summarized tool results', () => {
    const result: ToolResult = {
      message: '计划发现完成',
      payload: { rows: Array.from({ length: 100 }, (_, index) => ({ index, value: 'x'.repeat(50) })) },
      warnings: [],
      resultId: 'result_planning',
      source: 'test',
      valueRefs: [],
    }

    const formatted = JSON.parse(formatToolResultForModel(result, 400, true)) as Record<string, unknown>

    expect(formatted).toMatchObject({
      planningContext: {
        status: 'active',
        actions: ['继续无副作用读取', 'request_clarification', 'submit_agent_workflow', '直接说明计划'],
      },
    })
    expect(JSON.stringify(formatted)).toContain('计划本身不会替代有副作用工具各自的审批')
  })

  it('keeps GeoJSON feature properties while removing oversized coordinates', () => {
    const names = [
      '上城区', '拱墅区', '西湖区', '滨江区', '余杭区', '萧山区', '临平区',
      '钱塘区', '富阳区', '临安区', '桐庐县', '淳安县', '建德市',
    ]
    const result: ToolResult = {
      message: '读取 13 / 13 个要素',
      payload: {
        featureCollection: {
          type: 'FeatureCollection',
          features: names.map((name, index) => ({
            type: 'Feature',
            geometry: {
              type: 'MultiPolygon',
              coordinates: [[Array.from({ length: 400 }, (_, point) => [point, index])]],
            },
            properties: { name, adcode: 330100 + index },
          })),
        },
      },
      warnings: [],
      resultId: 'result_hangzhou',
      source: 'postgis',
    }

    const serialized = formatToolResultForModel(result, 1200)
    const formatted = JSON.parse(serialized) as {
      payloadSummary: {
        featureCollection: {
          featureCount: number
          propertyRowsComplete: boolean
          propertyRows: Array<{ properties: { name: string } }>
        }
      }
    }

    expect(formatted.payloadSummary.featureCollection).toMatchObject({
      featureCount: 13,
      propertyRowsComplete: true,
    })
    expect(formatted.payloadSummary.featureCollection.propertyRows.map(row => row.properties.name)).toEqual(names)
    expect(serialized).not.toContain('coordinates')
  })
})

describe('ToolExecutionCoordinator', () => {
  it('opens SDK extensions only for unstructured execution without an active workflow', () => {
    let planMode = false
    let agentWorkflow: Record<string, unknown> | null = null
    const store = {
      getRun: () => ({ state: { planMode, agentWorkflow } }),
    } as unknown as ToolExecutionStore
    const coordinator = new ToolExecutionCoordinator({
      store,
      resultCommitService: new ToolResultCommitService(store),
      registry: new ToolRegistry(),
      adapter: null,
      runId: 'run_extension_boundary',
      sessionId: 'session_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      inlineToolResultMaxChars: 4_000,
      eventSink: new RunEventSink(async () => undefined, 'run_extension_boundary', 'thread_1'),
      itemSink: new ItemSink(() => undefined, 'run_extension_boundary', 'thread_1', 'turn_1'),
      valueState: new Map(),
      signal: new AbortController().signal,
    })

    expect(coordinator.isSdkExtensionEnabled()).toBe(true)
    planMode = true
    expect(coordinator.isSdkExtensionEnabled()).toBe(false)
    planMode = false
    agentWorkflow = { status: 'running' }
    expect(coordinator.isSdkExtensionEnabled()).toBe(false)
  })

  it('binds one PreToolUse rewrite to the call and revalidates its schema', async () => {
    const store = {
      getRun: () => ({
        state: {
          objectiveRevision: 1,
          planMode: false,
          agentWorkflow: null,
          todos: [],
          artifacts: [],
          warnings: [],
          errors: [],
        },
      }),
    } as unknown as ToolExecutionStore
    const registry = new ToolRegistry()
    registry.register(testProvider())
    let calls = 0
    const runtimeHooks = new RuntimeHookRegistry([{
      hookId: 'rewrite-dataset',
      eventTypes: ['PreToolUse'],
      source: 'platform',
      execute: async () => {
        calls += 1
        return {
          decision: 'continue',
          updatedToolInput: { datasetId: 'dataset_2' },
        }
      },
    }]).bind([{
      hookId: 'rewrite-dataset',
      eventType: 'PreToolUse',
      enabled: true,
      matcher: { toolName: 'inspect_dataset' },
      priority: 0,
      description: '',
      timeoutMs: 1_000,
      failureMode: 'fail_closed',
    }])
    const coordinator = new ToolExecutionCoordinator({
      store,
      resultCommitService: new ToolResultCommitService(store),
      registry,
      adapter: null,
      runId: 'run_hook',
      sessionId: 'session_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      inlineToolResultMaxChars: 4_000,
      eventSink: new RunEventSink(async () => undefined, 'run_hook', 'thread_1'),
      itemSink: new ItemSink(() => undefined, 'run_hook', 'thread_1', 'turn_1'),
      valueState: new Map(),
      signal: new AbortController().signal,
      runtimeHooks,
    })
    bindTestStepContext(coordinator, registry, 'run_hook', 'turn_1')

    await expect(coordinator.canonicalizeToolCall(
      'inspect_dataset',
      { datasetId: 'dataset_1' },
      'call_hook',
    )).resolves.toEqual({ datasetId: 'dataset_2' })
    await expect(coordinator.canonicalizeToolCall(
      'inspect_dataset',
      { datasetId: 'dataset_1' },
      'call_hook',
    )).resolves.toEqual({ datasetId: 'dataset_2' })
    expect(calls).toBe(1)
  })

  it('rejects unknown tools and cyclic dependencies in workflow drafts', () => {
    const registry = new ToolRegistry()
    registry.register(testProvider())
    const step = (stepId: string, toolName: string, dependsOn: string[] = []) => ({
      stepId,
      title: stepId,
      kind: 'tool',
      toolName,
      ownerAgentId: 'supervisor',
      args: {},
      reason: '测试计划契约',
      dependsOn,
    })

    expect(validateAgentWorkflowDraft({
      workflow: { goal: '错误工具', steps: [step('step_1', 'render_map')] },
    }, registry, [])).toContain("未注册的 Agent 工具 'render_map'")
    expect(validateAgentWorkflowDraft({
      workflow: {
        goal: '循环依赖',
        steps: [
          step('step_1', 'inspect_dataset', ['step_2']),
          step('step_2', 'inspect_dataset', ['step_1']),
        ],
      },
    }, registry, [])).toContain('步骤依赖形成了循环')
  })

  it('validates planned argument shapes and subagent tool permissions before approval', () => {
    const registry = new ToolRegistry()
    registry.register(testProvider())
    const baseStep = {
      stepId: 'step_1',
      title: '检查数据集',
      kind: 'tool',
      toolName: 'inspect_dataset',
      ownerAgentId: 'supervisor',
      reason: '验证预计参数',
      dependsOn: [],
    }

    expect(validateAgentWorkflowDraft({
      workflow: { goal: '错误参数', steps: [{ ...baseStep, args: { unknown: true } }] },
    }, registry, [])).toContain('预计参数不符合')
    expect(validateAgentWorkflowDraft({
      workflow: { goal: '动态参数稍后补充', steps: [{ ...baseStep, args: {} }] },
    }, registry, [])).toBeNull()

    const agentStep = {
      ...baseStep,
      kind: 'agent',
      toolName: 'spatial_analyst',
      ownerAgentId: 'spatial_analyst',
      args: subAgentArgs('请调用 inspect_dataset 完成检查'),
    }
    expect(validateAgentWorkflowDraft({
      workflow: { goal: '越权委托', steps: [agentStep] },
    }, registry, [{ agentId: 'spatial_analyst', tools: [] }])).toContain("未授权工具 'inspect_dataset'")
    expect(validateAgentWorkflowDraft({
      workflow: { goal: '合法委托', steps: [agentStep] },
    }, registry, [{ agentId: 'spatial_analyst', tools: ['inspect_dataset'] }])).toBeNull()
    expect(validateAgentWorkflowDraft({
      workflow: { goal: '错误的终态转交', steps: [{ ...agentStep, toolName: 'terminal_specialist', ownerAgentId: 'terminal_specialist' }] },
    }, registry, [{ agentId: 'terminal_specialist', tools: [], delegationMode: 'handoff' }])).toContain(
      "Handoff 子智能体 'terminal_specialist' 会直接接管最终对话",
    )
  })

  it('persists the Chinese tool label with transcript and conversation items', async () => {
    const transcriptWrites: Array<Record<string, unknown>> = []
    const conversationItems: ConversationItem[] = []
    const invocations = testInvocationStore()
    const store = {
      ...invocations.methods,
      getRun: () => ({ state: { objectiveRevision: 1 } }),
      activeTranscript: vi.fn(async () => []),
      appendTranscript: vi.fn(async (input: Record<string, unknown>) => {
        transcriptWrites.push(input)
        return {
          schemaVersion: 2,
          seq: transcriptWrites.length,
          entryId: `entry_${transcriptWrites.length}`,
          parentEntryId: null,
          logicalParentEntryId: null,
          threadId: 'thread_1',
          runId: 'run_1',
          turnId: 'turn_1',
          kind: input.kind,
          timestamp: '2026-06-24T00:00:00.000Z',
          payload: input.payload ?? {},
        }
      }),
      saveRunCheckpoint: vi.fn(async () => undefined),
    } as unknown as ToolExecutionStore
    const registry = new ToolRegistry()
    registry.register(testProvider())
    const itemSink = new ItemSink(
      (update: ConversationItemWrite) => {
        if (update.updateType === 'replace_item') conversationItems.push(update.item)
      },
      'run_1',
      'thread_1',
      'turn_1',
    )
    const coordinator = new ToolExecutionCoordinator({
      store,
      resultCommitService: new ToolResultCommitService(store),
      registry,
      adapter: null,
      runId: 'run_1',
      sessionId: 'session_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      inlineToolResultMaxChars: 4_000,
      eventSink: new RunEventSink(async () => undefined, 'run_1', 'thread_1'),
      itemSink,
      valueState: new Map(),
      signal: new AbortController().signal,
    })
    bindTestStepContext(coordinator, registry, 'run_1', 'turn_1')

    await coordinator.prepare('inspect_dataset', { datasetId: 'dataset_1' }, 'call_1')
    await itemSink.flush()

    expect(transcriptWrites[0]).toMatchObject({
      kind: 'tool_call',
      payload: { name: 'inspect_dataset', label: '检查数据集' },
    })
    expect(conversationItems[0]?.metadata).toMatchObject({ toolLabel: '检查数据集' })
  })

  it('prepares one canonical tool call when Session and tool invoke race', async () => {
    const transcriptWrites: Array<Record<string, unknown>> = []
    const transcriptRead = deferredSignal()
    let reads = 0
    const invocations = testInvocationStore()
    const store = {
      ...invocations.methods,
      runtimeRoot: '/tmp/runtime',
      activeTranscript: vi.fn(async () => {
        reads += 1
        if (reads === 1) await transcriptRead.promise
        return []
      }),
      appendTranscript: vi.fn(async (input: Record<string, unknown>) => {
        transcriptWrites.push(input)
        return { entryId: `entry_${transcriptWrites.length}` }
      }),
      saveRunCheckpoint: vi.fn(async () => undefined),
      getRun: vi.fn(() => ({
        workspaceId: 'workspace_1',
        state: {
          objectiveRevision: 1,
          planMode: false,
          agentWorkflow: null,
          todos: [],
          artifacts: [],
          warnings: [],
          errors: [],
        },
      })),
    } as unknown as ToolExecutionStore
    const registry = new ToolRegistry()
    registry.register(testProvider())
    const coordinator = new ToolExecutionCoordinator({
      store,
      resultCommitService: new ToolResultCommitService(store),
      registry,
      adapter: null,
      runId: 'run_1',
      sessionId: 'session_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      inlineToolResultMaxChars: 4_000,
      eventSink: new RunEventSink(async () => undefined, 'run_1', 'thread_1'),
      itemSink: new ItemSink(() => undefined, 'run_1', 'thread_1', 'turn_1'),
      valueState: new Map(),
      signal: new AbortController().signal,
    })
    bindTestStepContext(coordinator, registry, 'run_1', 'turn_1')

    const sessionPreparation = coordinator.prepare(
      'inspect_dataset',
      { datasetId: 'dataset_1' },
      'call_race',
    )
    await Promise.resolve()
    const invokePreparation = coordinator.prepare(
      'inspect_dataset',
      { datasetId: 'dataset_1' },
      'call_race',
    )
    transcriptRead.resolve()
    await Promise.all([sessionPreparation, invokePreparation])

    expect(store.activeTranscript).toHaveBeenCalledTimes(1)
    expect(transcriptWrites).toHaveLength(1)
    expect(transcriptWrites[0]).toMatchObject({
      kind: 'tool_call',
      payload: { callId: 'call_race', name: 'inspect_dataset', ledgerStatus: 'prepared' },
    })
  })

  it('persists a failed platform tool result immediately with its real label', async () => {
    const transcriptWrites: Array<Record<string, unknown>> = []
    let warnings: string[] = []
    let errors: string[] = []
    let failedTool: string | null = null
    const invocations = testInvocationStore()
    const store = {
      ...invocations.methods,
      runtimeRoot: 'C:/runtime',
      activeTranscript: vi.fn(async () => []),
      appendTranscript: vi.fn(async (input: Record<string, unknown>) => {
        transcriptWrites.push(input)
        return { entryId: `entry_${transcriptWrites.length}` }
      }),
      saveRunCheckpoint: vi.fn(async () => undefined),
      getRun: vi.fn(() => ({
        workspaceId: 'workspace_1',
        state: { planMode: false, agentWorkflow: null, todos: [], artifacts: [], warnings, errors },
      })),
      mutateRunState: vi.fn(async (_runId: string, mutation: (state: {
        planMode: boolean
        agentWorkflow: null
        todos: never[]
        artifacts: never[]
        warnings: string[]
        errors: string[]
      }) => Record<string, unknown>) => {
        const state = { planMode: false, agentWorkflow: null, todos: [], artifacts: [], warnings, errors }
        const updates = mutation(state)
        warnings = Array.isArray(updates.warnings) ? updates.warnings as string[] : warnings
        errors = Array.isArray(updates.errors) ? updates.errors as string[] : errors
        failedTool = typeof updates.failedTool === 'string' ? updates.failedTool : failedTool
        return { workspaceId: 'workspace_1', state: { ...state, ...updates } }
      }),
      updateRunState: vi.fn(async (_runId: string, updates: {
        warnings?: string[]
        errors?: string[]
        failedTool?: string | null
      }) => {
        warnings = updates.warnings ?? warnings
        errors = updates.errors ?? errors
        failedTool = updates.failedTool ?? failedTool
        return undefined
      }),
    } as unknown as ToolExecutionStore
    const registry = new ToolRegistry()
    const provider = testProvider()
    const failingTool = provider.tools()[0]
    if (!failingTool) throw new Error('测试工具缺失')
    registry.register({
      ...provider,
      manifest: {
        ...provider.manifest,
        id: 'test-failing-inspection',
      },
      tools: () => [{
        ...failingTool,
        handler: async () => { throw new Error('数据集参数无效') },
      }],
    })
    const coordinator = new ToolExecutionCoordinator({
      store,
      resultCommitService: new ToolResultCommitService(store),
      registry,
      adapter: null,
      runId: 'run_1',
      sessionId: 'session_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      inlineToolResultMaxChars: 4_000,
      eventSink: new RunEventSink(async () => undefined, 'run_1', 'thread_1'),
      itemSink: new ItemSink(async () => undefined, 'run_1', 'thread_1', 'turn_1'),
      valueState: new Map(),
      signal: new AbortController().signal,
    })
    bindTestStepContext(coordinator, registry, 'run_1', 'turn_1')

    await expect(coordinator.executeDirect('inspect_dataset', { datasetId: 'bad' }))
      .rejects.toThrow('数据集参数无效')

    expect(transcriptWrites).toContainEqual(expect.objectContaining({
      kind: 'tool_result',
      payload: expect.objectContaining({
        name: 'inspect_dataset',
        label: '检查数据集',
        ledgerStatus: 'failed',
      }),
    }))
    expect(warnings).toContain('工具“检查数据集”调用失败：数据集参数无效')
    expect(errors).toContain('数据集参数无效')
    expect(failedTool).toBe('inspect_dataset')
  })

  it('keeps a delayed tool result bound to the model-input revision that started its call', async () => {
    let markStarted = (): void => {}
    const started = new Promise<void>(resolve => { markStarted = resolve })
    let release = (): void => {}
    const released = new Promise<void>(resolve => { release = resolve })
    const provider = testProvider()
    const definition = provider.tools()[0]
    if (!definition) throw new Error('测试工具缺失')
    const delayedProvider: ToolProvider = {
      ...provider,
      tools: () => [{
        ...definition,
        handler: async () => {
          markStarted()
          await released
          return {
            message: '旧 revision 调用完成',
            payload: {},
            warnings: [],
            resultId: 'result_delayed_revision',
            source: 'test',
          }
        },
      }],
    }
    const harness = coordinatorHarness(delayedProvider, false)
    harness.coordinator.bindModelInputObjectiveRevision(1)

    const executing = harness.coordinator.executeDirect('inspect_dataset', { datasetId: 'dataset_1' })
    await started
    harness.setObjectiveRevision(2)
    harness.coordinator.bindModelInputObjectiveRevision(2)
    release()
    await expect(executing).resolves.toMatchObject({ resultId: 'result_delayed_revision' })

    expect(harness.getState().toolResults).toContainEqual(expect.objectContaining({
      resultId: 'result_delayed_revision',
      objectiveRevision: 1,
    }))
    expect(harness.getTranscriptWrites()).toContainEqual(expect.objectContaining({
      kind: 'tool_call',
      payload: expect.objectContaining({ objectiveRevision: 1 }),
    }))
    expect(harness.getTranscriptWrites()).toContainEqual(expect.objectContaining({
      kind: 'tool_result',
      payload: expect.objectContaining({ objectiveRevision: 1 }),
    }))
  })

  it('keeps a late success from an advanced and revised workflow out of the new step attempt', async () => {
    const started = deferredSignal()
    const release = deferredSignal()
    let invocation = 0
    const provider = inspectionProvider(async () => {
      const currentInvocation = ++invocation
      if (currentInvocation === 1) {
        started.resolve()
        await release.promise
      }
      return inspectionResult(`result_revision_success_${currentInvocation}`)
    })
    const harness = coordinatorHarness(provider, false, [], inspectionWorkflow())

    const staleExecution = harness.coordinator.executeDirect('inspect_dataset', {
      datasetId: 'dataset_old',
      workflowStepId: 'inspect_scope',
    })
    await started.promise
    const running = harness.getState().agentWorkflow
    if (!running) throw new Error('测试工作流缺失')
    const revised = revisedInspectionWorkflow(running)
    harness.setWorkflow(revised)
    harness.coordinator.bindModelInputObjectiveRevision(2)

    expect(harness.getState().agentWorkflow).toEqual(revised)
    expect(harness.getState().agentWorkflow?.steps[0]).toMatchObject({
      stepId: 'inspect_scope',
      status: 'pending',
      attempt: 0,
      resultSummary: null,
    })

    await expect(harness.coordinator.executeDirect('inspect_dataset', {
      datasetId: 'dataset_new',
      workflowStepId: 'inspect_scope',
    })).resolves.toMatchObject({ resultId: 'result_revision_success_2' })

    release.resolve()
    await expect(staleExecution).resolves.toMatchObject({ resultId: 'result_revision_success_1' })
    await harness.flushEvents()

    expect(harness.getState().agentWorkflow).toMatchObject({
      objectiveRevision: 2,
      revision: 2,
      status: 'completed',
      steps: [expect.objectContaining({
        stepId: 'inspect_scope',
        status: 'completed',
        attempt: 1,
      })],
    })
    expect(harness.getEvents().filter(event => event.type === 'step.completed')).toHaveLength(1)
  })

  it('keeps a late failure from an advanced and revised workflow out of the new step attempt', async () => {
    const started = deferredSignal()
    const release = deferredSignal()
    let invocation = 0
    const provider = inspectionProvider(async () => {
      const currentInvocation = ++invocation
      if (currentInvocation === 1) {
        started.resolve()
        await release.promise
        throw new Error('旧 revision 调用失败')
      }
      return inspectionResult(`result_revision_recovery_${currentInvocation}`)
    })
    const harness = coordinatorHarness(provider, false, [], inspectionWorkflow())

    const staleExecution = harness.coordinator.executeDirect('inspect_dataset', {
      datasetId: 'dataset_old',
      workflowStepId: 'inspect_scope',
    })
    await started.promise
    const running = harness.getState().agentWorkflow
    if (!running) throw new Error('测试工作流缺失')
    const revised = revisedInspectionWorkflow(running)
    harness.setWorkflow(revised)
    harness.coordinator.bindModelInputObjectiveRevision(2)

    expect(harness.getState().agentWorkflow).toEqual(revised)
    expect(harness.getState().agentWorkflow?.steps[0]).toMatchObject({
      stepId: 'inspect_scope',
      status: 'pending',
      attempt: 0,
      errorMessage: null,
    })

    await expect(harness.coordinator.executeDirect('inspect_dataset', {
      datasetId: 'dataset_new',
      workflowStepId: 'inspect_scope',
    })).resolves.toMatchObject({ resultId: 'result_revision_recovery_2' })

    release.resolve()
    await expect(staleExecution).rejects.toThrow('旧 revision 调用失败')
    await harness.flushEvents()

    expect(harness.getState().agentWorkflow?.status).toBe('completed')
    expect(harness.getEvents().some(event => event.type === 'warning.raised')).toBe(false)
  })

  it('does not let an old claim complete a newer attempt with the same workflow and step ids', async () => {
    const started = deferredSignal()
    const release = deferredSignal()
    let invocation = 0
    const provider = inspectionProvider(async () => {
      const currentInvocation = ++invocation
      if (currentInvocation === 1) {
        started.resolve()
        await release.promise
      }
      return inspectionResult(`result_attempt_${currentInvocation}`)
    })
    const harness = coordinatorHarness(provider, false, [], inspectionWorkflow())

    const staleExecution = harness.coordinator.executeDirect('inspect_dataset', {
      datasetId: 'dataset_old',
      workflowStepId: 'inspect_scope',
    })
    await started.promise
    const running = harness.getState().agentWorkflow
    const runningStep = running?.steps[0]
    if (!running || !runningStep?.startedAt) throw new Error('测试运行步骤缺失')
    const retryable: AgentWorkflow = {
      ...running,
      steps: running.steps.map(step => step.stepId === runningStep.stepId
        ? {
            ...step,
            status: 'pending',
            startedAt: null,
          }
        : step),
    }
    harness.setWorkflow(retryable)

    await expect(harness.coordinator.executeDirect('inspect_dataset', {
      datasetId: 'dataset_retry',
      workflowStepId: 'inspect_scope',
    })).resolves.toMatchObject({ resultId: 'result_attempt_2' })

    release.resolve()
    await expect(staleExecution).resolves.toMatchObject({ resultId: 'result_attempt_1' })
    await harness.flushEvents()

    expect(harness.getState().agentWorkflow?.steps[0]).toMatchObject({
      status: 'completed',
      attempt: 2,
      resultSummary: '检查完成',
    })
    expect(harness.getEvents().filter(event => event.type === 'step.completed')).toHaveLength(1)
  })

  it('does not publish stale workflow control callbacks or events after the objective advances', async () => {
    let markStarted = (): void => {}
    const started = new Promise<void>(resolve => { markStarted = resolve })
    let release = (): void => {}
    const released = new Promise<void>(resolve => { release = resolve })
    const base = testProvider()
    const definition = base.tools()[0]
    const manifestDefinition = base.manifest.tools[0]
    if (!definition || !manifestDefinition) throw new Error('测试工具缺失')
    const provider: ToolProvider = {
      manifest: {
        ...base.manifest,
        id: 'test-stale-workflow-control',
        tools: [{
          ...manifestDefinition,
          name: 'submit_agent_workflow',
          label: '提交智能体工作流',
          jsonSchema: { type: 'object', properties: {} },
        }],
      },
      tools: () => [{
        ...definition,
        name: 'submit_agent_workflow',
        label: '提交智能体工作流',
        jsonSchema: { type: 'object', properties: {} },
        handler: async () => {
          markStarted()
          await released
          return {
            message: '旧 revision 工作流已生成',
            payload: {
              planMode: false,
              agentWorkflowDraft: {
                goal: '旧版本目标',
                steps: [{
                  stepId: 'old_step',
                  title: '执行旧版本工具',
                  kind: 'tool',
                  toolName: 'inspect_dataset',
                  ownerAgentId: 'supervisor',
                  args: {},
                  reason: '验证迟到控制结果',
                  dependsOn: [],
                }],
              },
            },
            warnings: [],
            resultId: 'result_stale_workflow_control',
            source: 'test',
          }
        },
      }],
    }
    const onPlanModeChanged = vi.fn()
    const harness = coordinatorHarness(provider, true, [], null, onPlanModeChanged)

    const executing = harness.coordinator.executeDirect('submit_agent_workflow', {})
    await started
    harness.setObjectiveRevision(2)
    harness.coordinator.bindModelInputObjectiveRevision(2)
    release()
    await expect(executing).resolves.toMatchObject({ resultId: 'result_stale_workflow_control' })
    await harness.flushEvents()

    expect(harness.getState()).toMatchObject({
      objectiveRevision: 2,
      planMode: true,
      agentWorkflow: null,
    })
    expect(onPlanModeChanged).not.toHaveBeenCalled()
    expect(harness.getEvents().some(event => event.type === 'agent_workflow.created')).toBe(false)
  })

  it('does not reinterpret an atomically committed tool effect as failed when a projection fails', async () => {
    const harness = coordinatorHarness(
      testProvider(),
      false,
      [],
      null,
      undefined,
      input => input.kind === 'tool_result'
        && isTestRecord(input.payload)
        && input.payload.ledgerStatus === 'completed',
    )

    await expect(harness.coordinator.executeDirect('inspect_dataset', { datasetId: 'dataset_1' }))
      .resolves.toMatchObject({ resultId: 'result_1' })

    await expect(harness.getInvocation('call_missing')).resolves.toBeNull()
    const invocations = await harness.listInvocations()
    expect(invocations).toHaveLength(1)
    expect(invocations[0]).toMatchObject({
      terminalOutcome: 'succeeded',
      resultId: 'result_1',
    })
    expect(harness.getState().toolResults).toContainEqual(expect.objectContaining({
      resultId: 'result_1',
    }))
    expect(harness.getState().failedTool).toBeNull()
    expect(harness.getState().warnings).toContainEqual(expect.stringContaining('后续投影失败'))
  })

  it('derives planning access from the tool read/write contract', async () => {
    const { coordinator } = coordinatorHarness(testProvider(), true)

    expect(coordinator.isToolEnabled('inspect_dataset')).toBe(true)
    await expect(coordinator.executeDirect('inspect_dataset', { datasetId: 'dataset_1' }))
      .resolves.toMatchObject({ message: '检查完成' })
  })

  it('blocks write tools while planning without a second allowlist', async () => {
    const provider = testProvider()
    const base = provider.tools()[0]
    if (!base) throw new Error('测试工具缺失')
    const writeTool = { ...base, isReadOnly: false }
    const { coordinator } = coordinatorHarness({
      ...provider,
      manifest: {
        ...provider.manifest,
        tools: [{
          ...provider.manifest.tools[0]!,
          isReadOnly: false,
        }],
      },
      tools: () => [writeTool],
    }, true)

    expect(coordinator.isToolEnabled('inspect_dataset')).toBe(false)
    await expect(coordinator.executeDirect('inspect_dataset', { datasetId: 'dataset_1' }))
      .rejects.toThrow("计划模式只允许无副作用的读取工具")
  })

  it('does not disable read-only discovery after an unrelated rejection', () => {
    const provider = testProvider()
    const base = provider.tools()[0]
    if (!base) throw new Error('测试工具缺失')
    const discoveryTool = { ...base }
    const clarificationTool = {
      ...base,
      name: 'request_clarification',
      label: '请求澄清',
    }
    const { coordinator } = coordinatorHarness({
      ...provider,
      manifest: {
        ...provider.manifest,
        tools: [
          { ...provider.manifest.tools[0]! },
          { ...provider.manifest.tools[0]!, name: 'request_clarification', label: '请求澄清' },
        ],
      },
      tools: () => [discoveryTool, clarificationTool],
    }, true, [{
      action: 'submit_agent_workflow',
      status: 'rejected',
      payload: { consumed: false },
    }])

    expect(coordinator.isToolEnabled('inspect_dataset')).toBe(true)
    expect(coordinator.isToolEnabled('request_clarification')).toBe(true)
  })

  it('exposes only ready workflow steps and recovery controls after approval', () => {
    const provider = testProvider()
    const base = provider.tools()[0]
    if (!base) throw new Error('测试工具缺失')
    const controls = [
      ['request_clarification', '请求澄清'],
      ['revise_agent_workflow', '调整智能体工作流'],
      ['todo_write', '更新任务清单'],
    ].map(([name, label]) => ({
      ...base,
      name: name!,
      label: label!,
    }))
    const workflow = createAgentWorkflow({
      goal: '检查数据集',
      steps: [{
        stepId: 'step_1',
        title: '检查数据集',
        kind: 'tool',
        toolName: 'inspect_dataset',
        ownerAgentId: 'supervisor',
        args: { datasetId: 'dataset_1' },
        reason: '验证运行边界',
        dependsOn: [],
      }],
    })
    const { coordinator } = coordinatorHarness({
      ...provider,
      manifest: {
        ...provider.manifest,
        tools: [
          provider.manifest.tools[0]!,
          ...controls.map(tool => ({
            name: tool.name,
            label: tool.label,
            description: tool.description,
            group: tool.group,
            tags: tool.tags,
            isReadOnly: tool.isReadOnly,
            isDestructive: tool.isDestructive,
            jsonSchema: tool.jsonSchema!,
          })),
        ],
      },
      tools: () => [base, ...controls],
    }, false, [], workflow)

    expect(coordinator.isToolEnabled('inspect_dataset')).toBe(true)
    expect(coordinator.isToolEnabled('request_clarification')).toBe(true)
    expect(coordinator.isToolEnabled('revise_agent_workflow')).toBe(true)
    expect(coordinator.isToolEnabled('todo_write')).toBe(false)
  })

  it('keeps read-only diagnostics available after a workflow step fails', async () => {
    const provider = testProvider()
    const base = provider.tools()[0]
    if (!base) throw new Error('测试工具缺失')
    const workflow = createAgentWorkflow({
      goal: '检查数据集',
      steps: [{
        stepId: 'step_1',
        title: '检查数据集',
        kind: 'tool',
        toolName: 'inspect_dataset',
        ownerAgentId: 'supervisor',
        args: { datasetId: 'broken' },
        reason: '验证失败后的恢复边界',
        dependsOn: [],
      }],
    })
    const { coordinator } = coordinatorHarness({
      ...provider,
      tools: () => [{
        ...base,
        handler: async () => { throw new Error('数据集缺少预报时效') },
      }],
    }, false, [], workflow)

    await expect(coordinator.executeDirect('inspect_dataset', { datasetId: 'broken' }))
      .rejects.toThrow('数据集缺少预报时效')

    expect(coordinator.isToolEnabled('inspect_dataset')).toBe(true)
    expect(coordinator.formatToolFailureForModel('inspect_dataset', '数据集缺少预报时效'))
      .toContain('可以调用已注册的无副作用读取工具诊断原因')
    expect(coordinator.formatUnavailableToolForModel('meteorological_inspect'))
      .toContain('只能使用已注册的无副作用读取工具诊断')
  })

  it('keeps a completed plan open for read-only delivery verification and explicit revision', async () => {
    const provider = testProvider()
    const inspect = provider.tools()[0]
    if (!inspect) throw new Error('测试工具缺失')
    const revise = {
      ...inspect,
      name: 'revise_agent_workflow',
      label: '调整智能体工作流',
    }
    const write = {
      ...inspect,
      name: 'publish_result',
      label: '发布结果',
      isReadOnly: false,
    }
    const planned = createAgentWorkflow({
      goal: '检查数据并交付',
      steps: [{
        stepId: 'step_1',
        title: '检查数据集',
        kind: 'tool',
        toolName: 'inspect_dataset',
        ownerAgentId: 'supervisor',
        args: { datasetId: 'dataset_1' },
        reason: '验证数据',
        dependsOn: [],
      }],
    })
    const completed = completeAgentWorkflowStep(
      startAgentWorkflowStep(planned, { stepId: 'step_1' }),
      { stepId: 'step_1', resultSummary: '检查完成' },
    )
    const definitions = [inspect, revise, write]
    const { coordinator, getState } = coordinatorHarness({
      ...provider,
      manifest: {
        ...provider.manifest,
        tools: definitions.map(tool => ({
          name: tool.name,
          label: tool.label,
          description: tool.description,
          group: tool.group,
          tags: tool.tags,
          isReadOnly: tool.isReadOnly,
          isDestructive: tool.isDestructive,
          jsonSchema: tool.jsonSchema!,
        })),
      },
      tools: () => definitions,
    }, false, [], completed)

    expect(coordinator.isToolEnabled('inspect_dataset')).toBe(true)
    expect(coordinator.isToolEnabled('revise_agent_workflow')).toBe(true)
    expect(coordinator.isToolEnabled('publish_result')).toBe(false)
    await expect(coordinator.executeDirect('inspect_dataset', { datasetId: 'dataset_1' }))
      .resolves.toMatchObject({ resultId: 'result_1' })
    expect(getState().agentWorkflow?.status).toBe('completed')
    await expect(coordinator.executeDirect('publish_result', { datasetId: 'dataset_1' }))
      .rejects.toThrow('请先调用 revise_agent_workflow')
    expect(coordinator.formatUnavailableToolForModel('publish_result'))
      .toContain('处于交付前验证阶段')
  })

  it('binds reverse and concurrent same-tool calls to explicit workflow step ids', async () => {
    const workflow = createAgentWorkflow({
      goal: '分别检查两个数据集',
      steps: [
        {
          stepId: 'inspect_a',
          title: '检查数据集 A',
          kind: 'tool',
          toolName: 'inspect_dataset',
          ownerAgentId: 'supervisor',
          args: { datasetId: 'dataset_a' },
          reason: '检查 A',
          dependsOn: [],
        },
        {
          stepId: 'inspect_b',
          title: '检查数据集 B',
          kind: 'tool',
          toolName: 'inspect_dataset',
          ownerAgentId: 'supervisor',
          args: { datasetId: 'dataset_b' },
          reason: '检查 B',
          dependsOn: [],
        },
      ],
    })
    const { coordinator, getState } = coordinatorHarness(testProvider(), false, [], workflow)

    await expect(coordinator.executeDirect('inspect_dataset', { datasetId: 'dataset_b' }))
      .rejects.toThrow('必须通过 workflowStepId 指定')

    await Promise.all([
      coordinator.executeDirect('inspect_dataset', {
        datasetId: 'dataset_b',
        workflowStepId: 'inspect_b',
      }),
      coordinator.executeDirect('inspect_dataset', {
        datasetId: 'dataset_a',
        workflowStepId: 'inspect_a',
      }),
    ])

    expect(getState().agentWorkflow?.steps.map(step => [step.stepId, step.status])).toEqual([
      ['inspect_a', 'completed'],
      ['inspect_b', 'completed'],
    ])
  })

  it('opens a subagent internal tool only while its approved agent step is running', async () => {
    const workflow = createAgentWorkflow({
      goal: '委托检查数据集',
      steps: [{
        stepId: 'step_agent',
        title: '委托空间智能体',
        kind: 'agent',
        toolName: 'spatial_analyst',
        ownerAgentId: 'spatial_analyst',
        args: subAgentArgs('检查数据集'),
        reason: '验证子智能体工具边界',
        dependsOn: [],
      }],
    })
    const { coordinator } = coordinatorHarness(testProvider(), false, [], workflow)
    bindTestStepContext(
      coordinator,
      (() => {
        const registry = new ToolRegistry()
        registry.register(testProvider())
        return registry
      })(),
      'run_plan_boundary',
      'turn_1',
      [testSdkToolEntry('spatial_analyst', 'subagent')],
    )

    expect(coordinator.isExternalAgentEnabled('spatial_analyst')).toBe(true)
    expect(coordinator.isToolEnabledForSubAgent('spatial_analyst', 'inspect_dataset')).toBe(false)
    await coordinator.prepareExternalAgentCall(
      'spatial_analyst',
      '空间智能体',
      subAgentArgs('检查数据集'),
      'call_subagent',
    )
    await coordinator.beginExternalAgentStep(
      'spatial_analyst',
      subAgentArgs('检查数据集'),
      'call_subagent',
    )
    expect(coordinator.isExternalAgentEnabled('spatial_analyst')).toBe(false)
    expect(coordinator.isToolEnabledForSubAgent('spatial_analyst', 'inspect_dataset')).toBe(true)
  })

  it('blocks subagents until the submitted workflow is approved', async () => {
    const { coordinator } = coordinatorHarness(testProvider(), true)

    expect(coordinator.isExecutionEnabled()).toBe(false)
    await expect(coordinator.beginExternalAgentStep(
      'spatial_analyst',
      subAgentArgs('分析当前图层'),
      'call_subagent',
    )).rejects.toThrow("计划模式禁止调用子智能体 'spatial_analyst'")
  })
})

function coordinatorHarness(
  provider: ToolProvider,
  planMode: boolean,
  approvals: Array<{ action: string; status: string; payload: Record<string, unknown> }> = [],
  agentWorkflow: AgentWorkflow | null = null,
  onPlanModeChanged?: (enabled: boolean) => void,
  failProjection?: (input: Record<string, unknown>) => boolean,
) {
  let state = {
    objectiveRevision: 1,
    planMode,
    agentWorkflow,
    todos: [],
    warnings: [],
    errors: [],
    failedTool: null as string | null,
    subAgents: [],
    toolValueRefs: [],
    artifacts: [],
    toolResults: [],
    decisions: [],
    approvals,
  }
  let transcriptSequence = 0
  const transcriptWrites: Array<Record<string, unknown>> = []
  const events: Array<{ type: string }> = []
  const eventSink = new RunEventSink(event => { events.push(event) }, 'run_plan_boundary', 'thread_1')
  const invocations = testInvocationStore()
  const store = {
    ...invocations.methods,
    runtimeRoot: 'C:/runtime',
    activeTranscript: vi.fn(async () => []),
    appendTranscript: vi.fn(async (input: Record<string, unknown>) => {
      if (failProjection?.(input)) throw new Error('注入投影写入失败')
      transcriptWrites.push(input)
      return { entryId: `entry_${++transcriptSequence}` }
    }),
    saveRunCheckpoint: vi.fn(async () => undefined),
    appendToolValue: vi.fn(async () => undefined),
    persistArtifact: vi.fn(async () => undefined),
    getRun: vi.fn(() => ({ workspaceId: 'workspace_1', state })),
    commitToolResult: vi.fn(async (
      _runId: string,
      _resultId: string,
      mutation: (current: typeof state) => Partial<typeof state>,
      invocation: ToolInvocationEffectCommit,
      _values: readonly unknown[],
      _artifacts: readonly unknown[],
    ) => {
      state = { ...state, ...mutation(state) }
      return {
        committed: true,
        invocation: invocations.commitSuccess(invocation, _resultId),
      }
    }),
    mutateRunState: vi.fn(async (_runId: string, mutation: (current: typeof state) => Partial<typeof state>) => {
      state = { ...state, ...mutation(state) }
      return { workspaceId: 'workspace_1', state }
    }),
    updateRunState: vi.fn(async (_runId: string, updates: Partial<typeof state>) => {
      state = { ...state, ...updates }
    }),
  } as unknown as ToolExecutionStore
  const registry = new ToolRegistry()
  registry.register(provider)
  const coordinator = new ToolExecutionCoordinator({
    store,
    resultCommitService: new ToolResultCommitService(store),
    registry,
    adapter: null,
    runId: 'run_plan_boundary',
    sessionId: 'session_1',
    threadId: 'thread_1',
    turnId: 'turn_1',
    inlineToolResultMaxChars: 4_000,
    eventSink,
    itemSink: new ItemSink(async () => undefined, 'run_plan_boundary', 'thread_1', 'turn_1'),
    valueState: new Map(),
    signal: new AbortController().signal,
    ...(onPlanModeChanged ? { onPlanModeChanged } : {}),
  })
  bindTestStepContext(coordinator, registry, 'run_plan_boundary', 'turn_1')
  return {
    coordinator,
    getState: () => state,
    setObjectiveRevision: (objectiveRevision: number) => { state = { ...state, objectiveRevision } },
    setWorkflow: (workflow: AgentWorkflow) => {
      state = {
        ...state,
        objectiveRevision: workflow.objectiveRevision,
        agentWorkflow: workflow,
      }
    },
    getTranscriptWrites: () => transcriptWrites,
    getEvents: () => events,
    flushEvents: () => eventSink.flush(),
    getInvocation: (callId: string) => invocations.methods.getToolInvocation('run_plan_boundary', callId),
    listInvocations: () => invocations.methods.listToolInvocations('run_plan_boundary'),
  }
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>(settle => { resolve = settle })
  return { promise, resolve }
}

function isTestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inspectionProvider(handler: () => Promise<ToolResult>): ToolProvider {
  const provider = testProvider()
  const definition = provider.tools()[0]
  if (!definition) throw new Error('测试工具缺失')
  return {
    ...provider,
    tools: () => [{ ...definition, handler }],
  }
}

function inspectionResult(resultId: string): ToolResult {
  return {
    message: '检查完成',
    payload: {},
    warnings: [],
    resultId,
    source: 'test',
  }
}

function inspectionWorkflow(): AgentWorkflow {
  return createAgentWorkflow({
    goal: '检查指定范围',
    steps: [inspectionWorkflowStep()],
  }, 1)
}

function revisedInspectionWorkflow(current: AgentWorkflow): AgentWorkflow {
  const advanced = advanceAgentWorkflowObjectiveRevision(current, 2)
  return reviseAgentWorkflow(advanced, {
    goal: '检查新的指定范围',
    changeReason: '用户修改了检查范围',
    steps: [inspectionWorkflowStep()],
  }, 2)
}

function inspectionWorkflowStep() {
  return {
    stepId: 'inspect_scope',
    title: '检查范围',
    kind: 'tool' as const,
    toolName: 'inspect_dataset',
    ownerAgentId: 'supervisor',
    args: { datasetId: 'dataset_scope' },
    reason: '验证工作流 claim 身份',
    dependsOn: [],
  }
}

function subAgentArgs(objective: string) {
  return {
    workflowStepId: 'step_agent',
    objective,
    expectedDeliverables: ['可核验分析结论'],
    contextRefs: [],
    constraints: [],
  }
}

function testProvider(): ToolProvider {
  const definition = {
    name: 'inspect_dataset',
    label: '检查数据集',
    description: '检查测试数据集。',
    prompt: '读取并检查测试数据集，不修改数据。',
    group: '测试',
    tags: ['test'],
    isReadOnly: true,
    isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: { datasetId: { type: 'string' } },
      required: ['datasetId'],
    },
  }
  return {
    manifest: {
      id: 'test-inspection',
      name: '测试检查工具',
      version: '1.0.0',
      author: 'test',
      language: 'typescript',
      description: '测试工具 Provider。',
      tools: [definition],
    },
    tools: () => [{
      ...definition,
      handler: async () => ({
        message: '检查完成',
        payload: {},
        warnings: [],
        resultId: 'result_1',
        source: 'test',
      }),
    }],
  }
}

function testInvocationStore(): {
  methods: Pick<ToolExecutionStore,
    | 'prepareToolInvocation'
    | 'getToolInvocation'
    | 'listToolInvocations'
    | 'startToolInvocation'
    | 'terminateToolInvocation'
  >
  commitSuccess(input: ToolInvocationEffectCommit, resultId: string): ToolInvocationRecord
} {
  const records = new Map<string, ToolInvocationRecord>()
  const key = (runId: string, callId: string): string => `${runId}\u0000${callId}`
  const byInvocationId = (runId: string, invocationId: string): ToolInvocationRecord => {
    const record = [...records.values()].find(candidate => (
      candidate.runId === runId && candidate.invocationId === invocationId
    ))
    if (!record) throw new Error(`测试工具调用 '${invocationId}' 不存在`)
    return record
  }
  const save = (record: ToolInvocationRecord): ToolInvocationRecord => {
    const parsed = toolInvocationRecordSchema.parse(record)
    records.set(key(parsed.runId, parsed.callId), structuredClone(parsed))
    return structuredClone(parsed)
  }
  const methods = {
    prepareToolInvocation: async (record: ToolInvocationRecord) => {
      const parsed = toolInvocationRecordSchema.parse(record)
      const existing = records.get(key(parsed.runId, parsed.callId))
      if (existing) {
        const immutable = (value: ToolInvocationRecord) => ({
          invocationId: value.invocationId,
          runId: value.runId,
          turnId: value.turnId,
          callId: value.callId,
          stepId: value.stepId,
          toolName: value.toolName,
          toolKind: value.toolKind,
          executionSurface: value.executionSurface,
          objectiveRevision: value.objectiveRevision,
          toolPlanDigest: value.toolPlanDigest,
          descriptorDigest: value.descriptorDigest,
          argsDigest: value.argsDigest,
          effect: value.effect,
          replayPolicy: value.replayPolicy,
          idempotencyKey: value.idempotencyKey,
          approvalAction: value.approvalAction,
        })
        if (JSON.stringify(immutable(existing)) !== JSON.stringify(immutable(parsed))) {
          throw new Error(`工具调用 '${parsed.callId}' 的持久身份冲突`)
        }
        return structuredClone(existing)
      }
      return save(parsed)
    },
    getToolInvocation: async (runId: string, callId: string) => {
      const record = records.get(key(runId, callId))
      return record ? structuredClone(record) : null
    },
    listToolInvocations: async (runId: string) => [...records.values()]
      .filter(record => record.runId === runId)
      .map(record => structuredClone(record)),
    startToolInvocation: async (input: StartToolInvocationInput) => {
      const current = byInvocationId(input.runId, input.invocationId)
      if (current.status === 'running') return structuredClone(current)
      if (current.status !== 'prepared' || current.version !== input.expectedVersion) {
        throw new Error(`测试工具调用 '${current.callId}' running CAS 失败`)
      }
      return save({
        ...current,
        status: 'running',
        approvalDecision: input.approvalDecision,
        runningAt: input.runningAt,
        version: current.version + 1,
      })
    },
    terminateToolInvocation: async (input: TerminalToolInvocationInput) => {
      const current = byInvocationId(input.runId, input.invocationId)
      if (current.terminalOutcome === input.outcome) return structuredClone(current)
      if (current.version !== input.expectedVersion) {
        throw new Error(`测试工具调用 '${current.callId}' terminal CAS 失败`)
      }
      return save({
        ...current,
        status: input.checkpointImmediately ? 'checkpointed' : input.outcome,
        terminalOutcome: input.outcome,
        resultId: input.resultId,
        error: input.error,
        terminalAt: input.terminalAt,
        checkpointedAt: input.checkpointImmediately ? input.terminalAt : null,
        ...(input.approvalDecision ? { approvalDecision: input.approvalDecision } : {}),
        version: current.version + 1,
      })
    },
  }
  return {
    methods,
    commitSuccess: (input, resultId) => {
      const current = [...records.values()].find(record => record.invocationId === input.invocationId)
      if (!current || current.status !== 'running' || current.version !== input.expectedVersion) {
        throw new Error(`测试工具结果 '${resultId}' invocation CAS 失败`)
      }
      return save({
        ...current,
        status: input.checkpointImmediately ? 'checkpointed' : 'succeeded',
        terminalOutcome: 'succeeded',
        resultId,
        error: null,
        terminalAt: input.terminalAt,
        checkpointedAt: input.checkpointImmediately ? input.terminalAt : null,
        version: current.version + 1,
      })
    },
  }
}

function bindTestStepContext(
  coordinator: ToolExecutionCoordinator,
  registry: ToolRegistry,
  runId: string,
  turnId: string,
  extraEntries: AgentToolPlanEntry[] = [],
): void {
  const catalog = new ToolCatalog(registry)
  const entries = [
    ...registry.list().map(definition => compileDirectToolPlan({
      definition,
      source: catalog.platformSource(definition.name),
      executionSurface: 'agent',
    }).entries[0]!),
    ...extraEntries,
  ].sort((left, right) => left.name.localeCompare(right.name))
  const planWithoutDigest = {
    entries,
    namespaces: [],
    deferredCatalogObjectHash: null,
    unavailableReasons: {},
  }
  const tools: AgentStepContext['tools'] = {
    ...planWithoutDigest,
    catalogDigest: agentContextDigest(planWithoutDigest),
  }
  coordinator.bindStepContext(agentStepContextSchema.parse({
    schemaVersion: 3,
    identity: { stepId: 'step_test', turnId, segmentId: 'segment_test', modelRequestIndex: 1 },
    runId,
    turnId,
    objectiveRevision: 1,
    inputCursor: 0,
    model: {
      provider: 'test',
      modelId: 'test-model',
      transport: 'responses',
      capabilities: {
        modelId: 'test-model',
        contextWindowTokens: 128_000,
        capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
        modalities: ['text'],
      },
      reasoningEffort: 'none',
      serviceTier: null,
      timeoutMs: 30_000,
    },
    runtimeConfigDigest: 'sha256:runtime',
    toolPlanDigest: tools.catalogDigest,
    worldRevision: 1,
    contextWindowId: 'context_window_test',
    permissions: {
      principalId: 'user_test',
      workspaceId: 'workspace_1',
      roles: ['member'],
      toolRules: [],
    },
    approvalPolicy: { interruptToolNames: [], destructiveToolsRequireApproval: true },
    sandbox: {
      backend: 'disabled',
      writableRoots: [],
      networkPolicy: 'provider_and_registered_tools',
    },
    mcp: emptyMcpSnapshot(),
    skills: { skillIds: [], invocations: [], catalogDigest: 'sha256:skills' },
    plugins: { pluginIds: [], bindings: [], catalogDigest: 'sha256:plugins' },
    tools,
    world: {
      revision: 1,
      stateDigest: 'sha256:world',
      layerIds: [],
      datasetIds: [],
      fileIds: [],
      artifactIds: [],
      valueRefIds: [],
      capabilities: {
        toolNames: entries.map(entry => entry.name),
        mcpServerNames: [],
        sandboxBackend: 'disabled',
        writableRoots: [],
        networkPolicy: 'provider_and_registered_tools',
      },
    },
    capturedAt: '2026-08-23T00:00:00.000Z',
    contextDigest: agentContextDigest({ runId, turnId, tools }),
  }))
}

function emptyMcpSnapshot() {
  return {
    bindingId: 'mcp_binding_none',
    catalogRevision: 0,
    configDigest: 'sha256:mcp-config',
    authDigest: 'sha256:mcp-auth',
    capabilityRootDigest: 'sha256:mcp-capabilities',
    toolCatalogDigest: 'sha256:mcp-tools',
    resourceCatalogDigest: 'sha256:mcp-resources',
    refreshReasons: ['initial'],
    servers: [],
  }
}

function testSdkToolEntry(
  name: string,
  kind: 'subagent' | 'handoff' | 'mcp' | 'hosted' | 'sandbox',
): AgentToolPlanEntry {
  const source = sdkToolDescriptorSource({ name, kind, executionSurfaces: ['agent'] })
  return {
    ...source,
    schemaDigest: agentContextDigest({ type: 'object' }),
    definitionDigest: agentContextDigest({ name, kind }),
    deferLoading: false,
  }
}

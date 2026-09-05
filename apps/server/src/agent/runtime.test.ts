// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 运行时契约测试
//
//   文件:       runtime.test.ts
//
//   日期:       2026年06月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  Usage,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ResponseStreamEvent,
} from '@openai/agents'
import { describe, expect, it } from 'vitest'
import type { Env } from '../framework/env.js'
import { ToolRegistry } from '../framework/registry.js'
import type { ToolDef, ToolProvider, ToolResult, ValueRef } from '../framework/types.js'
import { ModelAdapterRegistry, type ModelAdapter } from '../model/registry.js'
import {
  subAgentDeliverySchema,
  supervisorDeliverySchema,
  type ConversationItem,
  type ConversationItemTextDelta,
  type RunGoalInput,
} from '../schemas/types.js'
import { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import type { AuthContext } from '../security/types.js'
import {
  createTestPersistenceFacade,
  PersistenceFacadeTestHarness,
  testPlatformEventHub,
} from '../../test-support/persistenceFacadeHarness.js'
import planProvider from '../tools/plan/index.js'
import { defaultRuntimeConfig } from './defaultRuntimeConfig.js'
import type { GoalJudgePort } from './goalJudge.js'
import { OpenAIAgentsRuntime } from './runtime.js'
import { RunSteeringController } from './runSteeringController.js'
import { testSandboxClientFactory } from '../../test-support/agentsSandboxClient.js'
import type {
  AgentStepContextRecorder,
  CaptureAgentStepContextInput,
} from '../agent-runtime/step/AgentStepContextFactory.js'
import { AgentsSdkCheckpointCodec } from '../agent-runtime/sdk/AgentsSdkCheckpointCodec.js'
import { ModelRequestJournal } from '../agent-runtime/input/ModelRequestJournal.js'
import {
  createTestAgentStepContextRecorder,
} from '../../test-support/agentStepContextRecorder.js'
import type { RuntimeHookHandler } from '../agent-runtime/hooks/RuntimeHookRegistry.js'

async function removeTempRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function testRuntime(
  store: PlatformPersistenceFacade,
  tools: ToolRegistry,
  models: ModelAdapterRegistry,
  goalJudge?: GoalJudgePort,
  stepContexts?: AgentStepContextRecorder,
): OpenAIAgentsRuntime {
  return new OpenAIAgentsRuntime(store, tools, models, {
    stepContexts: stepContexts ?? testStepContextRecorder(store),
    createSandboxClient: testSandboxClientFactory,
    ...(goalJudge ? { goalJudge } : {}),
  })
}

const testStepContextRecorders = new WeakMap<PlatformPersistenceFacade, AgentStepContextRecorder>()

function testStepContextRecorder(store: PlatformPersistenceFacade): AgentStepContextRecorder {
  const existing = testStepContextRecorders.get(store)
  if (existing) return existing
  const created = createTestAgentStepContextRecorder()
  testStepContextRecorders.set(store, created)
  return created
}

describe('OpenAIAgentsRuntime delivery boundaries', () => {
  it('distinguishes platform artifact IDs from valueRef IDs at the structured-output schema boundary', () => {
    const supervisor = {
      markdown: '完成。',
      summary: '完成。',
      artifactIds: ['ref_not_an_artifact'],
      warnings: [],
    }
    const subAgent = {
      status: 'completed',
      summary: '完成。',
      evidence: [{ claim: '已查询', source: 'ref_query_result' }],
      artifactIds: ['ref_query_result'],
      warnings: [],
      error: null,
    }

    expect(supervisorDeliverySchema.safeParse(supervisor).success).toBe(false)
    expect(subAgentDeliverySchema.safeParse(subAgent).success).toBe(false)
    expect(supervisorDeliverySchema.safeParse({
      ...supervisor,
      artifactIds: ['artifact_query_result'],
    }).success).toBe(true)
    expect(subAgentDeliverySchema.safeParse({
      ...subAgent,
      artifactIds: ['artifact_query_result'],
    }).success).toBe(true)
  })

  it('captures the exact root StepContext before every provider model request', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-step-context-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '模型请求快照')
      const run = await store.createRun(session.id, '查询当前图层', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const tools = new ToolRegistry()
      tools.register(providerFromTools('step-context-test', [{
        ...toolDefinition('query_layer', ['query']),
        handler: async () => result('query_layer', [], { count: 1 }),
      }]))
      const captures: CaptureAgentStepContextInput[] = []
      const captureCountsAtProvider: number[] = []
      const model = scriptedModel(request => {
        captureCountsAtProvider.push(captures.length)
        return hasToolResult(request)
          ? { text: '已完成图层查询。' }
          : {
              toolCalls: [{
                id: 'call_step_context',
                name: 'query_layer',
                arguments: '{"query":"current"}',
              }],
            }
      })
      const completed = await testRuntime(
        store,
        tools,
        registryWith(fakeAdapter(model)),
        undefined,
        createTestAgentStepContextRecorder({
          onRecord: input => captures.push(input),
        }),
      ).run(runOptions(run, thread.id))

      expect(completed.status, completed.state.errors.join('\n')).toBe('completed')
      expect(captureCountsAtProvider).toEqual([1, 2])
      expect(captures).toHaveLength(2)
      expect(captures.map(capture => capture.toolPlan.entries.map(entry => entry.name)))
        .toEqual([['query_layer'], ['query_layer']])
      expect(captures.every(capture => capture.objectiveRevision === 1)).toBe(true)
      expect(captures.every(capture => capture.inputCursor === 0)).toBe(true)
      expect(captures[0]?.toolPlan.catalogDigest).toBe(captures[1]?.toolPlan.catalogDigest)
      expect(Object.isFrozen(captures[0]?.toolPlan)).toBe(true)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('includes steering queued after Run open in the very first provider request', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-first-request-steering-'))
    const releaseAuthorization = deferredSignal()
    const authorizationReached = deferredSignal()
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '首次模型请求输入')
      const run = await store.createRun(session.id, '先回答初始问题', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const requests: ModelRequest[] = []
      const model = scriptedModel(request => {
        requests.push(request)
        return { text: '已同时处理初始问题和补充要求。' }
      })
      let authorizationChecks = 0
      const runtime = new OpenAIAgentsRuntime(
        store,
        new ToolRegistry(),
        registryWith(fakeAdapter(model)),
        {
          stepContexts: testStepContextRecorder(store),
          createSandboxClient: testSandboxClientFactory,
          authorizationLease: async auth => {
            authorizationChecks += 1
            // 第二次授权检查发生在 steering.open 之后、assembly/provider 之前。
            if (authorizationChecks === 2) {
              authorizationReached.resolve()
              await releaseAuthorization.promise
            }
            return auth
          },
        },
      )
      const auth: AuthContext = {
        userId: 'user_first_input',
        subject: 'auth_user_first_input',
        email: 'first-input@example.com',
        displayName: '首次输入测试',
        authSessionId: 'auth_session_first_input',
        authSessionExpiresAt: null,
        csrfToken: 'csrf_first_input',
        defaultWorkspaceId: 'workspace_first_input',
        roles: [{ workspaceId: 'workspace_first_input', role: 'workspace_admin' }],
      }

      const running = runtime.run({ ...runOptions(run, thread.id), auth })
      await authorizationReached.promise
      const steering = await runtime.steer(
        run.id,
        'steer_before_first_request',
        '首次请求就必须包含这个补充要求。',
      )
      releaseAuthorization.resolve()
      const completed = await running

      expect(completed.status).toBe('completed')
      expect(requests).toHaveLength(1)
      expect(requestTexts(requests[0]!)).toEqual(expect.arrayContaining([
        run.userQuery,
        steering.content,
      ]))
      expect(requestTexts(requests[0]!).filter(text => text === steering.content)).toHaveLength(1)
      expect(JSON.stringify(requests[0])).not.toContain('geoAgentRunInput')
      expect((await store.listRunInputs(run.id))).toContainEqual(expect.objectContaining({
        steeringId: steering.steeringId,
        status: 'checkpointed',
        modelRequestId: expect.any(String),
      }))
      const [modelRequest] = await store.listModelRequests(run.id)
      expect(modelRequest?.inputEntryIds).toEqual([steering.entryId])
    } finally {
      releaseAuthorization.resolve()
      await removeTempRoot(root)
    }
  })

  it('recovers an included first request exactly when no earlier SDK checkpoint exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-first-request-recovery-'))
    const releaseAuthorization = deferredSignal()
    const authorizationReached = deferredSignal()
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '首次请求 included 恢复')
      const run = await store.createRun(session.id, '恢复首次请求', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const requests: ModelRequest[] = []
      const model = scriptedModel(request => {
        requests.push(request)
        if (requests.length === 1) throw new Error('模拟 provider 收到首次请求后进程中断')
        return { text: '恢复后完成。' }
      })
      let authorizationChecks = 0
      const stepContexts = testStepContextRecorder(store)
      const runtime = new OpenAIAgentsRuntime(
        store,
        new ToolRegistry(),
        registryWith(fakeAdapter(model)),
        {
          stepContexts,
          createSandboxClient: testSandboxClientFactory,
          authorizationLease: async auth => {
            authorizationChecks += 1
            if (authorizationChecks === 2) {
              authorizationReached.resolve()
              await releaseAuthorization.promise
            }
            return auth
          },
        },
      )
      const auth: AuthContext = {
        userId: 'user_first_recovery',
        subject: 'auth_user_first_recovery',
        email: 'first-recovery@example.com',
        displayName: '首次恢复测试',
        authSessionId: 'auth_session_first_recovery',
        authSessionExpiresAt: null,
        csrfToken: 'csrf_first_recovery',
        defaultWorkspaceId: 'workspace_first_recovery',
        roles: [{ workspaceId: 'workspace_first_recovery', role: 'workspace_admin' }],
      }

      const firstAttempt = runtime.run({ ...runOptions(run, thread.id), auth })
      await authorizationReached.promise
      const steering = await runtime.steer(
        run.id,
        'steer_first_request_crash',
        '该输入必须在崩溃恢复后仍出现一次。',
      )
      releaseAuthorization.resolve()
      const failed = await firstAttempt

      expect(failed.status).toBe('failed')
      expect((await store.listRunInputs(run.id))).toContainEqual(expect.objectContaining({
        steeringId: steering.steeringId,
        status: 'included',
      }))
      expect((await store.getRunCheckpoint(run.id))).toMatchObject({
        sdkStateContentHash: null,
        checkpointInputCursor: 0,
        activeInputLeaseId: expect.any(String),
      })

      const completed = await runtime.run({
        ...runOptions(run, thread.id),
        auth,
        resume: true,
      })

      expect(completed.status).toBe('completed')
      expect(requests).toHaveLength(2)
      const { signal: _firstSignal, ...firstPersistedRequest } = requests[0]!
      const { signal: _replayedSignal, ...replayedPersistedRequest } = requests[1]!
      expect(replayedPersistedRequest).toEqual(firstPersistedRequest)
      expect(JSON.stringify(replayedPersistedRequest)).toBe(JSON.stringify(firstPersistedRequest))
      expect(requestTexts(requests[1]!).filter(text => text === steering.content)).toHaveLength(1)
      expect((await store.listRunInputs(run.id))).toContainEqual(expect.objectContaining({
        steeringId: steering.steeringId,
        status: 'checkpointed',
      }))
      expect((await store.listModelRequests(run.id))).toHaveLength(1)
      expect((await store.activeTranscript(thread.id)).filter(entry => (
        entry.kind === 'message'
        && entry.payload.role === 'user'
        && entry.payload.content === run.userQuery
      ))).toHaveLength(1)
    } finally {
      releaseAuthorization.resolve()
      await removeTempRoot(root)
    }
  })

  it('recovers the same journaled request after restart when the run has no input lease', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-no-lease-request-recovery-'))
    try {
      const harness = new PersistenceFacadeTestHarness()
      const firstStore = harness.create(root)
      await firstStore.initialize()
      const session = await firstStore.createSession()
      const thread = await firstStore.createThread(session.id, '普通模型请求恢复')
      const run = await firstStore.createRun(session.id, '解释海陆风的日变化', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const requests: ModelRequest[] = []
      const model = scriptedModel(request => {
        requests.push(request)
        if (requests.length === 1) throw new Error('模拟普通模型请求发出后进程中断')
        return { text: '白天海风、夜间陆风，方向由海陆热力差异决定。' }
      })
      const models = registryWith(fakeAdapter(model))
      const captures: CaptureAgentStepContextInput[] = []
      const stepContexts = createTestAgentStepContextRecorder({
        onRecord: input => captures.push(input),
      })

      const failed = await testRuntime(
        firstStore,
        new ToolRegistry(),
        models,
        undefined,
        stepContexts,
      ).run(runOptions(run, thread.id))

      expect(failed.status).toBe('failed')
      expect(await firstStore.listRunInputs(run.id)).toEqual([])
      expect(await firstStore.getRunCheckpoint(run.id)).toMatchObject({
        sdkStateContentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        checkpointInputCursor: 0,
        activeInputLeaseId: null,
      })
      const activeBeforeRestart = await firstStore.getActiveModelRequest(run.id)
      expect(activeBeforeRestart).toMatchObject({
        runId: run.id,
        inputEntryIds: [],
      })
      await firstStore.flushConversationStore()

      const restoredStore = harness.create(root)
      await restoredStore.initialize()
      expect(await restoredStore.getActiveModelRequest(run.id)).toEqual(activeBeforeRestart)
      const completed = await testRuntime(
        restoredStore,
        new ToolRegistry(),
        models,
        undefined,
        stepContexts,
      ).run({ ...runOptions(run, thread.id), resume: true })

      expect(completed.status).toBe('completed')
      expect(requests).toHaveLength(2)
      expect(modelRequestWithoutTransientControls(requests[1]!))
        .toBe(modelRequestWithoutTransientControls(requests[0]!))
      expect(captures).toHaveLength(1)
      expect(await restoredStore.listModelRequests(run.id)).toEqual([activeBeforeRestart])
      expect(await restoredStore.getActiveModelRequest(run.id)).toBeNull()
    } finally {
      await removeTempRoot(root)
    }
  })

  it('releases the active-run lifecycle when the first persistence write fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-initialization-failure-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '初始化失败清理')
      const run = await store.createRun(session.id, '验证初始化失败后可以重试', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const originalUpdateRunStatus = store.updateRunStatus.bind(store)
      let failFirstWrite = true
      store.updateRunStatus = async (...args) => {
        if (failFirstWrite) {
          failFirstWrite = false
          throw new Error('注入的首次状态写入失败')
        }
        return originalUpdateRunStatus(...args)
      }
      const runtime = testRuntime(
        store,
        new ToolRegistry(),
        registryWith(fakeAdapter(scriptedModel(() => ({ text: '重试完成。' })))),
      )

      const failed = await runtime.run(runOptions(run, thread.id))
      expect(failed.status).toBe('failed')
      expect(failed.state.errors).toContain('注入的首次状态写入失败')

      const completed = await runtime.run(runOptions(run, thread.id))
      expect(completed.status).toBe('completed')
      expect(completed.state.errors).toContain('注入的首次状态写入失败')
    } finally {
      await removeTempRoot(root)
    }
  })

  it('rebuilds the visible transcript after restart and sends the current user message once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-continuation-'))
    try {
      const requests: ModelRequest[] = []
      let responseNumber = 0
      const model = scriptedModel(request => {
        requests.push(request)
        responseNumber += 1
        return { text: responseNumber === 1 ? '项目代号是西湖。' : '我记得，项目代号是西湖。' }
      })
      const models = registryWith(fakeAdapter(model))
      const harness = new PersistenceFacadeTestHarness()
      const firstStore = harness.create(root)
      await firstStore.initialize()
      const session = await firstStore.createSession()
      const thread = await firstStore.createThread(session.id, '连续对话')
      const firstRun = await firstStore.createRun(session.id, '记住项目代号是西湖', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      await testRuntime(firstStore, new ToolRegistry(), models).run(runOptions(firstRun, thread.id))
      await firstStore.flushConversationStore()

      const restoredStore = harness.create(root)
      await restoredStore.initialize()
      const secondRun = await restoredStore.createRun(session.id, '刚才的项目代号是什么？', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      await testRuntime(restoredStore, new ToolRegistry(), models).run(runOptions(secondRun, thread.id))

      const secondTexts = requestTexts(requests[1])
      expect(secondTexts).toContain('记住项目代号是西湖')
      expect(secondTexts).toContain('项目代号是西湖。')
      expect(secondTexts.filter(text => text === secondRun.userQuery)).toHaveLength(1)
      const transcript = await restoredStore.activeTranscript(thread.id)
      const assistantEntries = transcript.filter(entry => entry.kind === 'message' && entry.payload.role === 'assistant')
      expect(assistantEntries.map(entry => entry.payload.content)).toEqual([
        '项目代号是西湖。',
        '我记得，项目代号是西湖。',
      ])
      const secondItems = await restoredStore.listItems(secondRun.id)
      expect(secondItems.filter(item => item.role === 'assistant' && item.body === '我记得，项目代号是西湖。'))
        .toHaveLength(1)
      expect(secondItems.find(item => item.body === '我记得，项目代号是西湖。')?.metadata.transcriptEntryId)
        .toBe(assistantEntries[1].entryId)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('keeps an earlier identical question by excluding the current turn by run identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-identical-query-'))
    try {
      const requests: ModelRequest[] = []
      const models = registryWith(fakeAdapter(scriptedModel(request => {
        requests.push(request)
        return { text: '已记录。' }
      })))
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '重复问题身份测试')
      const query = '请记住项目代号是西湖'
      const firstRun = await store.createRun(session.id, query, {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      await testRuntime(store, new ToolRegistry(), models).run(runOptions(firstRun, thread.id))
      const secondRun = await store.createRun(session.id, query, {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })

      await testRuntime(store, new ToolRegistry(), models).run(runOptions(secondRun, thread.id))

      expect(requestTexts(requests[1]).filter(text => text === query)).toHaveLength(2)
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript.filter(entry => (
        entry.kind === 'message'
        && entry.payload.role === 'user'
        && entry.payload.content === query
      ))).toHaveLength(2)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('persists an SDK approval interruption and resumes it once after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-approval-'))
    try {
      const harness = new PersistenceFacadeTestHarness()
      const store = harness.create(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '审批测试')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['sensitive_tool']
      const run = await store.createRun(session.id, '执行敏感工具', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      let executions = 0
      const tools = new ToolRegistry()
      tools.register(approvalProvider(() => { executions += 1 }))
      const approvalUsage = {
        requests: 1,
        inputTokens: 11,
        outputTokens: 4,
        totalTokens: 15,
        inputTokensDetails: { cached_tokens: 7 },
      }
      const model = scriptedModel(request => hasToolResult(request)
        ? { text: '工具已执行。', usage: approvalUsage }
        : {
            toolCalls: [{ id: 'call_1', name: 'sensitive_tool', arguments: '{"value":1}' }],
            usage: approvalUsage,
          })
      const models = registryWith(fakeAdapter(model))
      const stepContexts = createTestAgentStepContextRecorder()

      const waiting = await testRuntime(store, tools, models, undefined, stepContexts).run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
      })
      expect(waiting.state.errors).toEqual([])
      expect(waiting.status).toBe('waiting_approval')
      expect(executions).toBe(0)
      expect(waiting.state.approvals).toHaveLength(1)
      expect(waiting.state.decisions).toContainEqual(expect.objectContaining({
        decisionId: waiting.state.approvals[0].approvalId,
        kind: 'approval',
        status: 'pending',
        title: '批准执行：执行敏感操作',
      }))
      expect(waiting.state.runtimeStats).toMatchObject({
        modelInputTokens: 11,
        modelOutputTokens: 4,
        modelTotalTokens: 15,
        modelCacheHitInputTokens: 7,
        modelUsageResponseCount: 1,
      })
      await store.flushConversationStore()

      const restoredStore = harness.create(root)
      await restoredStore.initialize()
      const completed = await testRuntime(restoredStore, tools, models, undefined, stepContexts)
        .resolveApproval(run.id, waiting.state.approvals[0].approvalId, true)

      expect(completed.status).toBe('completed')
      expect(executions).toBe(1)
      expect(completed.state.approvals[0].payload.consumed).toBe(true)
      expect(completed.state.decisions).toContainEqual(expect.objectContaining({
        decisionId: waiting.state.approvals[0].approvalId,
        kind: 'approval',
        status: 'approved',
        resolvedAt: expect.any(String),
      }))
      expect(completed.state.runtimeStats).toMatchObject({
        modelInputTokens: 22,
        modelOutputTokens: 8,
        modelTotalTokens: 30,
        modelCacheHitInputTokens: 14,
        modelUsageResponseCount: 2,
      })
      const transcript = await restoredStore.activeTranscript(thread.id)
      expect(transcript.filter(entry => entry.kind === 'message' && entry.payload.role === 'user')).toHaveLength(1)
      expect(transcript.filter(entry => entry.kind === 'tool_call')).toHaveLength(1)
      expect(transcript.filter(entry => entry.kind === 'tool_result')).toHaveLength(1)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('records a completed model response before a projection failure closes the run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-usage-projection-failure-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '投影失败用量测试')
      const config = testRuntimeConfig()
      const run = await store.createRun(session.id, '调用未开放工具', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const originalActiveTranscript = store.activeTranscript.bind(store)
      let failNextProjectionRead = false
      store.activeTranscript = async (...args) => {
        if (failNextProjectionRead) {
          failNextProjectionRead = false
          throw new Error('测试投影写入失败')
        }
        return originalActiveTranscript(...args)
      }
      const model = scriptedModel(() => {
        // 模型请求已经开始后，下一次 transcript 读取只会发生在
        // tool_called 投影路径；此时 SDK 已将完整响应放入 rawResponses。
        failNextProjectionRead = true
        return {
          toolCalls: [{
            id: 'call_unavailable_after_response',
            name: 'unavailable_after_response',
            arguments: '{}',
          }],
          usage: {
            requests: 1,
            inputTokens: 13,
            outputTokens: 5,
            totalTokens: 18,
            inputTokensDetails: { cached_tokens: 8 },
          },
        }
      })

      const failed = await testRuntime(
        store,
        new ToolRegistry(),
        registryWith(fakeAdapter(model)),
      ).run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
      })

      expect(failed.status).toBe('failed')
      expect(failed.state.errors).toContain('测试投影写入失败')
      expect(failed.state.runtimeStats).toMatchObject({
        modelInputTokens: 13,
        modelOutputTokens: 5,
        modelTotalTokens: 18,
        modelCacheHitInputTokens: 8,
        modelUsageResponseCount: 1,
      })
    } finally {
      await removeTempRoot(root)
    }
  })

  it('reuses a session approval for the same canonical action without a second interruption', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-session-approval-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '会话审批复用')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['sensitive_tool']
      const run = await store.createRun(session.id, '连续执行两次相同敏感动作', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      let executions = 0
      const tools = new ToolRegistry()
      tools.register(approvalProvider(() => { executions += 1 }))
      const model = scriptedModel(request => {
        const completedCalls = Array.isArray(request.input)
          ? request.input.filter(item => (
              item.type === 'function_call_result'
              && isRecord(item)
              && item.name === 'sensitive_tool'
            )).length
          : 0
        if (completedCalls >= 2) return { text: '两次敏感动作均已完成。' }
        return {
          toolCalls: [{
            id: `call_session_${completedCalls + 1}`,
            name: 'sensitive_tool',
            arguments: '{"value":1}',
          }],
        }
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))

      const waiting = await runtime.run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
      })
      const approvalId = waiting.state.approvals[0]?.approvalId
      if (!approvalId) throw new Error('测试没有生成首个精确调用审批')
      const completed = await runtime.resolveApproval(run.id, approvalId, {
        decision: 'approved',
        scope: 'session',
        reason: null,
      })

      expect(completed.status).toBe('completed')
      expect(completed.state.errors).toEqual([])
      expect(executions).toBe(2)
      expect(completed.state.approvals).toHaveLength(1)
      const durableApprovals = await store.listApprovalRecords(run.id)
      expect(durableApprovals).toHaveLength(2)
      expect(durableApprovals).toEqual(expect.arrayContaining([
        expect.objectContaining({
          callId: 'call_session_1',
          decisionScope: 'session',
          status: 'consumed',
        }),
        expect.objectContaining({
          callId: 'call_session_2',
          decisionScope: 'exact_call',
          status: 'consumed',
          sourceApprovalId: approvalId,
        }),
      ]))
    } finally {
      await removeTempRoot(root)
    }
  })

  it('exposes all read-only tools and hides write tools in explicit plan mode', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-boundary-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '计划模式写入边界')
      const run = await store.createRun(session.id, '先计划再写入', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      let executions = 0
      let visibleTools: string[] = []
      const tools = new ToolRegistry()
      tools.register(providerFromTools('plan-boundary-tools', [
        {
          ...toolDefinition('lookup_context', ['query']),
          handler: async () => result('lookup', [], { ok: true }),
        },
        {
          ...toolDefinition('query_layer', ['query']),
          handler: async () => {
            executions += 1
            return result('query', [], { ok: true })
          },
        },
        {
          ...toolDefinition('write_layer', ['value']),
          isReadOnly: false,
          handler: async () => {
            executions += 1
            return result('write', [], { ok: true })
          },
        },
      ]))
      const model = scriptedModel(request => {
        visibleTools = request.tools.map(tool => tool.name)
        return { text: '我会先整理计划。' }
      })

      const completed = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        executionMode: 'plan',
      })

      expect(completed.status).toBe('completed')
      expect(executions).toBe(0)
      expect(completed.state.planMode).toBe(true)
      expect(visibleTools).toContain('lookup_context')
      expect(visibleTools).toContain('query_layer')
      expect(visibleTools).not.toContain('write_layer')
    } finally {
      await removeTempRoot(root)
    }
  })

  it('keeps a geospatial Compose run in planning until a phased workflow is completed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-compose-contract-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '地理分析 Compose')
      const config = testRuntimeConfig()
      const run = await store.createRun(session.id, '完成区域风险分析并验证结果', {
        threadId: thread.id,
        modelProvider: 'fake',
        runProfile: 'geospatial_compose',
        runtimeConfigSnapshot: config,
      })
      const model = scriptedModel(() => ({ text: '我已经整理了一份分析计划。' }))

      const completed = await testRuntime(
        store,
        new ToolRegistry(),
        registryWith(fakeAdapter(model)),
      ).run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
        runProfile: 'geospatial_compose',
      })

      expect(completed.status).toBe('failed')
      expect(completed.state.runProfile).toBe('geospatial_compose')
      expect(completed.state.planMode).toBe(true)
      expect(completed.state.errors.at(-1)).toContain('必须提交并完成 discover、validate、analyze、verify')
    } finally {
      await removeTempRoot(root)
    }
  })

  it('executes and delivers a valid geospatial Compose phase chain in one SDK run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-compose-success-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '地理分析 Compose 完整链路')
      const config = testRuntimeConfig()
      const run = await store.createRun(session.id, '分析区域风险并复核结果', {
        threadId: thread.id,
        modelProvider: 'fake',
        runProfile: 'geospatial_compose',
        runtimeConfigSnapshot: config,
      })
      const executed: string[] = []
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(providerFromTools('compose-phase-tools', [
        phaseTool('query_layer', executed),
        phaseTool('lookup_context', executed),
        phaseTool('parallel_a', executed),
        phaseTool('parallel_b', executed),
      ]))
      const workflow = {
        goal: '完成区域风险分析并复核关键结论',
        steps: [
          { ...workflowStep('discover', '发现数据', 'query_layer'), phase: 'discover' },
          { ...workflowStep('validate', '核验数据', 'lookup_context', ['discover']), phase: 'validate' },
          { ...workflowStep('analyze', '执行分析', 'parallel_a', ['validate']), phase: 'analyze' },
          { ...workflowStep('verify', '复核结果', 'parallel_b', ['analyze']), phase: 'verify' },
        ],
      }
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'parallel_b')) return { text: '区域风险分析已完成，并由只读步骤复核。' }
        if (hasToolResultNamed(request, 'parallel_a')) {
          return { toolCalls: [{ id: 'call_verify', name: 'parallel_b', arguments: '{}' }] }
        }
        if (hasToolResultNamed(request, 'lookup_context')) {
          return { toolCalls: [{ id: 'call_analyze', name: 'parallel_a', arguments: '{}' }] }
        }
        if (hasToolResultNamed(request, 'query_layer')) {
          return { toolCalls: [{ id: 'call_validate', name: 'lookup_context', arguments: '{}' }] }
        }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return { toolCalls: [{ id: 'call_discover', name: 'query_layer', arguments: '{}' }] }
        }
        return {
          toolCalls: [{
            id: 'call_compose_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow }),
          }],
        }
      })

      const completed = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
        runProfile: 'geospatial_compose',
      })

      expect(completed.status).toBe('completed')
      expect(executed).toEqual(['query_layer', 'lookup_context', 'parallel_a', 'parallel_b'])
      expect(completed.state.agentWorkflow).toMatchObject({
        status: 'completed',
        steps: [
          expect.objectContaining({ phase: 'discover', status: 'completed' }),
          expect.objectContaining({ phase: 'validate', status: 'completed' }),
          expect.objectContaining({ phase: 'analyze', status: 'completed' }),
          expect.objectContaining({ phase: 'verify', status: 'completed' }),
        ],
      })
    } finally {
      await removeTempRoot(root)
    }
  })

  it('continues the same SDK run after an incomplete Goal verdict and completes only after independent satisfaction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-goal-recheck-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, 'Goal 独立验收续跑')
      const run = await store.createRun(session.id, '核验目标图层并给出结论', {
        threadId: thread.id,
        modelProvider: 'fake',
        goal: testGoalInput({ maxRechecks: 2, maxTokenBudget: 100 }),
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      let executions = 0
      let modelTurns = 0
      const tools = new ToolRegistry()
      tools.register(providerFromTools('goal-evidence-tools', [{
        ...toolDefinition('query_layer', ['query']),
        handler: async () => {
          executions += 1
          return result('query', [], { verified: true })
        },
      }]))
      const model = scriptedModel(() => {
        modelTurns += 1
        if (modelTurns === 1) {
          return { toolCalls: [{ id: 'call_goal_query', name: 'query_layer', arguments: '{"query":"目标图层"}' }] }
        }
        return { text: modelTurns === 2 ? '目标图层已完成初步核验。' : '已补充独立复核结论。' }
      })
      let judgement = 0
      const goalJudge: GoalJudgePort = {
        evaluate: async input => {
          judgement += 1
          if (judgement === 1) {
            return {
              status: 'incomplete',
              reason: '缺少复核结论。',
              evidence: [],
              missingCriteria: ['补充独立复核结论'],
              attempt: input.goal.recheckCount + 1,
              evaluatedAt: new Date().toISOString(),
              tokenUsage: 4,
            }
          }
          return {
            status: 'satisfied',
            reason: '工具结果与复核结论共同满足目标。',
            evidence: [{ source: 'tool_result', referenceId: 'result_query', statement: '目标图层查询成功。' }],
            missingCriteria: [],
            attempt: input.goal.recheckCount + 1,
            evaluatedAt: new Date().toISOString(),
            tokenUsage: 6,
          }
        },
      }

      const completed = await testRuntime(
        store,
        tools,
        registryWith(fakeAdapter(model)),
        goalJudge,
      ).run(runOptions(run, thread.id))

      expect(completed.status).toBe('completed')
      expect(executions).toBe(1)
      expect(judgement).toBe(2)
      expect(completed.state.goal).toMatchObject({
        status: 'satisfied',
        recheckCount: 1,
        lastVerdict: { status: 'satisfied', attempt: 2 },
      })
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'checkpoint',
        payload: expect.objectContaining({ type: 'goal_recheck', recheckCount: 1 }),
      }))
      expect(transcript.filter(entry => entry.kind === 'message' && entry.payload.role === 'assistant')).toHaveLength(2)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('discards a Goal verdict when steering advances the objective revision during Judge', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-goal-steering-race-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, 'Goal revision 终态竞态')
      const run = await store.createRun(session.id, '按当前输入交付结论', {
        threadId: thread.id,
        modelProvider: 'fake',
        goal: testGoalInput({ maxRechecks: 2, maxTokenBudget: 100 }),
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      let modelTurns = 0
      let steeringObserved = false
      const model = scriptedModel(request => {
        modelTurns += 1
        if (modelTurns === 1) return { text: '旧 revision 的候选结论。' }
        steeringObserved = requestTexts(request).some(text => text.includes('新增空间范围核验'))
        return { text: '新 revision 已覆盖新增空间范围并完成核验。' }
      })

      let releaseFirstJudge = (): void => {}
      const firstJudgeRelease = new Promise<void>(resolve => { releaseFirstJudge = resolve })
      let markFirstJudgeStarted = (): void => {}
      const firstJudgeStarted = new Promise<void>(resolve => { markFirstJudgeStarted = resolve })
      let judgements = 0
      const goalJudge: GoalJudgePort = {
        evaluate: async input => {
          judgements += 1
          if (judgements === 1) {
            markFirstJudgeStarted()
            await firstJudgeRelease
            return {
              status: 'satisfied',
              reason: '旧 revision verdict 不得提交。',
              evidence: [{ source: 'transcript', referenceId: 'entry_old', statement: '旧候选文本。' }],
              missingCriteria: [],
              attempt: input.goal.recheckCount + 1,
              evaluatedAt: new Date().toISOString(),
              tokenUsage: 2,
            }
          }
          return {
            status: 'satisfied',
            reason: '新 revision verdict 已绑定当前输入。',
            evidence: [{ source: 'transcript', referenceId: 'entry_new', statement: '新输入已被模型处理。' }],
            missingCriteria: [],
            attempt: input.goal.recheckCount + 1,
            evaluatedAt: new Date().toISOString(),
            tokenUsage: 3,
          }
        },
      }
      const runtime = testRuntime(store, new ToolRegistry(), registryWith(fakeAdapter(model)), goalJudge)

      const running = runtime.run(runOptions(run, thread.id))
      await firstJudgeStarted
      await runtime.steer(run.id, 'steer_during_judge', '新增空间范围核验。')
      releaseFirstJudge()
      const completed = await running

      expect(completed.status).toBe('completed')
      expect(modelTurns).toBe(2)
      expect(judgements).toBe(2)
      expect(steeringObserved).toBe(true)
      expect(completed.state.objectiveRevision).toBe(2)
      expect(completed.state.goal).toMatchObject({
        objectiveRevision: 2,
        status: 'satisfied',
        lastVerdict: { reason: '新 revision verdict 已绑定当前输入。' },
      })
      const events = await store.listEvents(run.id)
      expect(JSON.stringify(events)).not.toContain('旧 revision verdict 不得提交。')
      const items = await store.listItems(run.id)
      expect(items).toContainEqual(expect.objectContaining({
        metadata: expect.objectContaining({
          objectiveRevision: 1,
          supersededByNewObjectiveRevision: true,
        }),
      }))
      expect(items).toContainEqual(expect.objectContaining({
        metadata: expect.objectContaining({
          objectiveRevision: 2,
          goalStatus: 'satisfied',
        }),
      }))
    } finally {
      await removeTempRoot(root)
    }
  })

  it('marks only the current candidate superseded when steering queues before the model stream ends', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-stream-steering-race-'))
    const releaseTool = deferredSignal()
    let releaseOldCandidate = (): void => {}
    let releaseNewCandidate = (): void => {}
    let releaseNewResponseDone = (): void => {}
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '模型流结束前的 revision 竞态')
      const run = await store.createRun(session.id, '核验范围并交付', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const tools = new ToolRegistry()
      const toolStarted = deferredSignal()
      tools.register(providerFromTools('stream-revision-tool', [{
        ...toolDefinition('query_layer', ['query']),
        handler: async () => {
          toolStarted.resolve()
          await releaseTool.promise
          return result('inspect_scope', [], { inspected: true })
        },
      }]))

      const oldCandidateRelease = new Promise<void>(resolve => { releaseOldCandidate = resolve })
      let markOldCandidateStarted = (): void => {}
      const oldCandidateStarted = new Promise<void>(resolve => { markOldCandidateStarted = resolve })
      let markNewCandidateStarted = (): void => {}
      const newCandidateStarted = new Promise<void>(resolve => { markNewCandidateStarted = resolve })
      const newCandidateRelease = new Promise<void>(resolve => { releaseNewCandidate = resolve })
      let markNewResponseDone = (): void => {}
      const newResponseDone = new Promise<void>(resolve => { markNewResponseDone = resolve })
      const newResponseDoneRelease = new Promise<void>(resolve => { releaseNewResponseDone = resolve })
      let modelCalls = 0
      let firstSteeringOccurrencesInToolTurn = 0
      let firstSteeringOccurrencesAfterOuterContinue = 0
      let secondSteeringOccurrencesAfterOuterContinue = 0
      const baseModel = scriptedModel(() => ({ text: '未使用' }))
      const model: Model = {
        ...baseModel,
        async *getStreamedResponse(request): AsyncIterable<ResponseStreamEvent> {
          modelCalls += 1
          let scripted: ScriptedResponse
          if (modelCalls === 1) {
            scripted = {
              text: '先核验旧范围。',
              toolCalls: [{ id: 'call_inspect_scope', name: 'query_layer', arguments: '{"query":"old"}' }],
            }
          } else if (modelCalls === 2) {
            firstSteeringOccurrencesInToolTurn = requestTexts(request)
              .filter(text => text.includes('先扩展到浙江范围')).length
            scripted = { text: '旧 revision 候选结论。' }
          } else {
            const texts = requestTexts(request)
            firstSteeringOccurrencesAfterOuterContinue = texts
              .filter(text => text.includes('先扩展到浙江范围')).length
            secondSteeringOccurrencesAfterOuterContinue = texts
              .filter(text => text.includes('再扩展到新范围')).length
            expect(JSON.stringify(request.input)).not.toContain('geoAgentRunInput')
            expect(JSON.stringify(request.input)).not.toContain('geo_agent_run_input')
            scripted = { text: '新 revision 最终结论。' }
          }
          const response = structuredResponse(scripted, request)
          const responseId = makeIdForResponse()
          yield { type: 'response_started' }
          if (modelCalls === 3) {
            markNewCandidateStarted()
            await newCandidateRelease
          }
          // 首轮工具前文本形成 completedAssistantItems；第二轮故意
          // 不发 delta，模拟只在 message_output_created 产生 lastAssistantText 的 provider。
          if (modelCalls === 1 && response.text) {
            yield { type: 'output_text_delta', delta: response.text }
          }
          if (modelCalls === 2) {
            markOldCandidateStarted()
            await oldCandidateRelease
          }
          yield {
            type: 'response_done',
            response: {
              id: responseId,
              usage: {
                requests: 1,
                inputTokens: 5,
                outputTokens: 2,
                totalTokens: 7,
                inputTokensDetails: { cached_tokens: 3 },
              },
              output: outputItems(response, responseId),
            },
          }
          if (modelCalls === 3) {
            markNewResponseDone()
            await newResponseDoneRelease
          }
        },
      }
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))

      const running = runtime.run(runOptions(run, thread.id))
      await toolStarted.promise
      const firstSteering = await runtime.steer(
        run.id,
        'steer_during_tool',
        '先扩展到浙江范围。',
      )
      releaseTool.resolve()
      await oldCandidateStarted
      const secondSteering = await runtime.steer(
        run.id,
        'steer_before_stream_end',
        '再扩展到新范围。',
      )
      expect(await store.listRunInputs(run.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ inputSequence: 1, status: 'included' }),
        expect.objectContaining({ inputSequence: 2, status: 'queued' }),
      ]))
      expect(await store.getRunCheckpoint(run.id)).toMatchObject({
        checkpointInputCursor: 0,
        activeInputLeaseFrom: 1,
        activeInputLeaseTo: 1,
      })
      releaseOldCandidate()
      await newCandidateStarted
      expect(await store.listRunInputs(run.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ inputSequence: 1, status: 'checkpointed' }),
        expect.objectContaining({ inputSequence: 2, status: 'included' }),
      ]))
      expect(await store.getRunCheckpoint(run.id)).toMatchObject({
        checkpointInputCursor: 1,
        activeInputLeaseFrom: 2,
        activeInputLeaseTo: 2,
      })
      releaseNewCandidate()
      await newResponseDone
      expect((await store.listRunInputs(run.id))[1]).toMatchObject({
        inputSequence: 2,
        status: 'included',
      })
      expect((await store.getRunCheckpoint(run.id)).checkpointInputCursor).toBe(1)
      releaseNewResponseDone()
      const completed = await running

      expect(completed.status).toBe('completed')
      expect(modelCalls).toBe(3)
      expect(completed.state.runtimeStats).toMatchObject({
        modelInputTokens: 15,
        modelOutputTokens: 6,
        modelTotalTokens: 21,
        modelCacheHitInputTokens: 9,
        modelUsageResponseCount: 3,
      })
      expect(firstSteeringOccurrencesInToolTurn).toBe(1)
      expect(firstSteeringOccurrencesAfterOuterContinue).toBe(1)
      expect(secondSteeringOccurrencesAfterOuterContinue).toBe(1)
      expect(await store.listRunInputs(run.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ inputSequence: 1, status: 'checkpointed' }),
        expect.objectContaining({ inputSequence: 2, status: 'checkpointed' }),
      ]))
      expect(await store.getRunCheckpoint(run.id)).toMatchObject({
        checkpointInputCursor: 2,
        activeInputLeaseId: null,
      })
      const items = await store.listItems(run.id)
      const superseded = items.filter(item => item.metadata.supersededByNewObjectiveRevision === true)
      expect(superseded).toHaveLength(1)
      expect(superseded[0]).toMatchObject({
        role: 'assistant',
        body: '旧 revision 候选结论。',
        metadata: { objectiveRevision: 2 },
      })
      const earlierPreamble = items.find(item => item.body?.includes('先核验旧范围'))
      expect(earlierPreamble?.metadata).not.toHaveProperty('supersededByNewObjectiveRevision')
      const freshAnswer = items.find(item => item.body === '新 revision 最终结论。')
      expect(freshAnswer?.metadata).toMatchObject({ objectiveRevision: 3 })
      expect(freshAnswer?.metadata).not.toHaveProperty('supersededByNewObjectiveRevision')
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript.filter(entry => entry.payload.content === firstSteering.content)).toHaveLength(1)
      expect(transcript.filter(entry => entry.payload.content === secondSteering.content)).toHaveLength(1)
    } finally {
      releaseTool.resolve()
      releaseOldCandidate()
      releaseNewCandidate()
      releaseNewResponseDone()
      await removeTempRoot(root)
    }
  })

  it('keeps a model-visible input included when atomic checkpoint persistence fails and replays its exact request', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-input-ack-failure-'))
    const releaseTool = deferredSignal()
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '输入 checkpoint ack 失败')
      const run = await store.createRun(session.id, '检查后结合新范围回答', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const toolStarted = deferredSignal()
      const tools = new ToolRegistry()
      tools.register(providerFromTools('input-ack-failure', [{
        ...toolDefinition('query_layer', ['query']),
        handler: async () => {
          toolStarted.resolve()
          await releaseTool.promise
          return result('scope', [], { inspected: true })
        },
      }]))
      let steeringObserved = false
      let includedProviderRequest: ModelRequest | null = null
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'query_layer')) {
          steeringObserved = requestTexts(request).some(text => text.includes('新范围'))
          includedProviderRequest = request
          return { text: '已结合新范围完成。' }
        }
        return {
          toolCalls: [{ id: 'call_ack_failure_query', name: 'query_layer', arguments: '{"query":"old"}' }],
        }
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const originalSave = store.saveAgentsSdkCheckpointEnvelope.bind(store)
      store.saveAgentsSdkCheckpointEnvelope = async (...args) => {
        if (args[2].inputLeaseId) throw new Error('注入的 checkpoint/input ack 事务失败')
        return originalSave(...args)
      }

      const running = runtime.run(runOptions(run, thread.id))
      await toolStarted.promise
      await runtime.steer(run.id, 'steer_ack_failure', '请同时检查新范围。')
      releaseTool.resolve()
      const failed = await running
      expect(failed.status).toBe('failed')
      expect(failed.state.errors).toContain('注入的 checkpoint/input ack 事务失败')
      expect(steeringObserved).toBe(true)
      expect((await store.listRunInputs(run.id))).toContainEqual(expect.objectContaining({
        steeringId: 'steer_ack_failure',
        status: 'included',
      }))
      expect(await store.getRunCheckpoint(run.id)).toMatchObject({
        checkpointInputCursor: 0,
        activeInputLeaseFrom: 1,
        activeInputLeaseTo: 1,
      })

      store.saveAgentsSdkCheckpointEnvelope = originalSave
      await store.updateRunStatus(run.id, 'running')
      const recovery = new RunSteeringController(store)
      await recovery.open(run.id, { recoverLeased: true })
      expect((await store.listRunInputs(run.id))[0]).toMatchObject({
        status: 'included',
        inputSequence: 1,
      })
      const activeRequest = await store.getActiveModelRequest(run.id)
      expect(activeRequest).toMatchObject({
        runId: run.id,
        inputEntryIds: [expect.any(String)],
      })
      if (!activeRequest) throw new Error('included 输入缺少活动 ModelRequest')
      if (!includedProviderRequest) throw new Error('测试未捕获 included provider request')
      const persistedSnapshot = await store.readModelRequestSnapshot(activeRequest)
      expect(persistedSnapshot).toContain('请同时检查新范围')
      const replaySignal = new AbortController().signal
      const replayTracingParent = { source: 'current-runtime-span' }
      const currentRequestWithTransientControls = {
        ...includedProviderRequest,
        input: [{
          type: 'message' as const,
          role: 'user' as const,
          content: '不得使用的重建请求',
        }],
        signal: replaySignal,
        _internal: {
          runnerManagedRetry: true,
          tracingParent: replayTracingParent,
          forbiddenCurrentControl: true,
        },
        forbiddenCurrentField: true,
      }
      const replayed = await new ModelRequestJournal(store).replay(
        activeRequest,
        currentRequestWithTransientControls,
      )
      expect(replayed.signal).toBe(replaySignal)
      expect(modelRequestRunnerManagedRetry(replayed)).toBe(true)
      expect(modelRequestInternalValue(replayed, 'tracingParent')).toBe(replayTracingParent)
      expect(persistedSnapshot).not.toContain('current-runtime-span')
      expect(modelRequestInternalValue(replayed, 'forbiddenCurrentControl')).toBeUndefined()
      const replayedRecord: unknown = replayed
      expect(isRecord(replayedRecord) ? replayedRecord.forbiddenCurrentField : undefined).toBeUndefined()
      expect(modelRequestWithoutTransientControls(replayed))
        .toBe(modelRequestWithoutTransientControls(includedProviderRequest))
      expect(requestTexts(replayed)).toContain('请同时检查新范围。')
      expect(requestTexts(replayed)).not.toContain('不得使用的重建请求')
      const checkpoint = await store.getRunCheckpoint(run.id)
      const acked = await store.saveAgentsSdkCheckpointEnvelope(run.id, '{"response":"recovered"}', {
        agentsSdkVersion: 'test-sdk',
        runtimeConfigDigest: 'test-runtime',
        inputLeaseId: checkpoint.activeInputLeaseId,
        checkpointModelRequestStepId: activeRequest.stepId,
      })
      await recovery.recordCheckpointedInputs(run.id, acked)
      expect((await store.listRunInputs(run.id))[0]).toMatchObject({
        status: 'checkpointed',
        inputSequence: 1,
      })
      expect((await store.getRunCheckpoint(run.id)).checkpointInputCursor).toBe(1)
      await recovery.close(run.id)
    } finally {
      releaseTool.resolve()
      await removeTempRoot(root)
    }
  })

  it('fails hard with an exhausted Goal when the configured recheck limit is reached', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-goal-exhausted-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, 'Goal 复验次数边界')
      const run = await store.createRun(session.id, '验证一次后结束', {
        threadId: thread.id,
        modelProvider: 'fake',
        goal: testGoalInput({ maxRechecks: 0, maxTokenBudget: 100 }),
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const goalJudge: GoalJudgePort = {
        evaluate: async input => ({
          status: 'incomplete',
          reason: '证据仍不完整。',
          evidence: [],
          missingCriteria: ['缺少可复核证据'],
          attempt: input.goal.recheckCount + 1,
          evaluatedAt: new Date().toISOString(),
          tokenUsage: 2,
        }),
      }

      const completed = await testRuntime(
        store,
        new ToolRegistry(),
        registryWith(fakeAdapter(scriptedModel(() => ({ text: '当前只有初步结论。' })))),
        goalJudge,
      ).run(runOptions(run, thread.id))

      expect(completed.status).toBe('failed')
      expect(completed.state.goal).toMatchObject({
        status: 'exhausted',
        recheckCount: 0,
        lastVerdict: { status: 'incomplete' },
      })
      expect(completed.state.errors.at(-1)).toContain('0 次最大复验续跑')
    } finally {
      await removeTempRoot(root)
    }
  })

  it('fails hard when independent Goal judgement crosses the token budget', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-goal-token-budget-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, 'Goal 词元预算边界')
      const run = await store.createRun(session.id, '在预算内完成目标', {
        threadId: thread.id,
        modelProvider: 'fake',
        goal: testGoalInput({ maxRechecks: 2, maxTokenBudget: 5 }),
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const goalJudge: GoalJudgePort = {
        evaluate: async input => ({
          status: 'satisfied',
          reason: '证据满足目标，但验收调用已越过预算。',
          evidence: [{ source: 'transcript', referenceId: 'entry_test', statement: '测试证据。' }],
          missingCriteria: [],
          attempt: input.goal.recheckCount + 1,
          evaluatedAt: new Date().toISOString(),
          tokenUsage: 6,
        }),
      }

      const completed = await testRuntime(
        store,
        new ToolRegistry(),
        registryWith(fakeAdapter(scriptedModel(() => ({ text: '目标内容已完成。' })))),
        goalJudge,
      ).run(runOptions(run, thread.id))

      expect(completed.status).toBe('failed')
      expect(completed.state.goal).toMatchObject({ status: 'exhausted' })
      expect(completed.state.goal?.failureReason).toContain('6/5')
      expect(completed.state.errors.at(-1)).toContain('词元预算已用尽')
    } finally {
      await removeTempRoot(root)
    }
  })

  it('allows text-only planning discussion without representing it as approved execution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-text-only-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '文字计划禁止假成功')
      const run = await store.createRun(session.id, '先给我计划', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const model = scriptedModel(() => ({ text: '计划：第一步检查，第二步执行。' }))

      const completed = await testRuntime(store, new ToolRegistry(), registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        executionMode: 'plan',
      })

      expect(completed.status).toBe('completed')
      expect(completed.state.planMode).toBe(true)
      expect(completed.state.agentWorkflow).toBeNull()
      expect(completed.state.errors).toEqual([])
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'message',
        payload: expect.objectContaining({ role: 'assistant', content: '计划：第一步检查，第二步执行。' }),
      }))
    } finally {
      await removeTempRoot(root)
    }
  })

  it('executes a read-only platform tool in plan mode without a duplicate allowlist', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-tool-not-found-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '计划模式工具不可用恢复')
      const config = testRuntimeConfig()
      const run = await store.createRun(session.id, '先尝试查询再调整', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      let executions = 0
      const tools = new ToolRegistry()
      tools.register(providerFromTools('plan-tool-not-found', [{
        ...toolDefinition('query_layer', ['query']),
        handler: async () => {
          executions += 1
          return result('不应执行', [], {})
        },
      }]))
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'query_layer')) {
          return { text: '已核实图层事实，我会据此形成计划。' }
        }
        return {
          toolCalls: [{
            id: 'call_unavailable_query',
            name: 'query_layer',
            arguments: '{"query":"杭州"}',
          }],
        }
      })

      const completed = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
        executionMode: 'plan',
      })

      expect(completed.status, completed.state.errors.join('\n')).toBe('completed')
      expect(executions).toBe(1)
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'tool_call',
        payload: expect.objectContaining({
          callId: 'call_unavailable_query',
          name: 'query_layer',
          ledgerStatus: 'prepared',
        }),
      }))
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'tool_result',
        payload: expect.objectContaining({
          callId: 'call_unavailable_query',
          ledgerStatus: 'completed',
        }),
      }))
    } finally {
      await removeTempRoot(root)
    }
  })

  it('records a hallucinated unknown tool as an SDK rejection instead of a sandbox execution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-unknown-tool-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '未知工具投影')
      const config = testRuntimeConfig()
      const run = await store.createRun(session.id, '调用一个不存在的工具后恢复', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'invented_tool')) {
          return { text: '这个工具不存在，我不会伪造执行结果。' }
        }
        return {
          toolCalls: [{
            id: 'call_invented_tool',
            name: 'invented_tool',
            arguments: '{}',
          }],
        }
      })

      const completed = await testRuntime(store, new ToolRegistry(), registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
      })

      expect(completed.status).toBe('completed')
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'tool_call',
        payload: expect.objectContaining({
          callId: 'call_invented_tool',
          name: 'invented_tool',
          ledgerStatus: 'rejected',
          source: 'openai_agents_sdk',
        }),
      }))
      expect(transcript).not.toContainEqual(expect.objectContaining({
        payload: expect.objectContaining({
          callId: 'call_invented_tool',
          source: 'openai_agents_sandbox',
        }),
      }))
    } finally {
      await removeTempRoot(root)
    }
  })

  it('allows a plain-text plan after dynamically entering plan mode', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-dynamic-plan-terminal-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '动态计划模式终态边界')
      const run = await store.createRun(session.id, '帮我做一张风险区划图', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      const requests: ModelRequest[] = []
      let turns = 0
      const model = scriptedModel(request => {
        requests.push(request)
        turns += 1
        if (turns === 1) {
          return {
            toolCalls: [{
              id: 'call_enter_plan_mode',
              name: 'enter_plan_mode',
              arguments: JSON.stringify({ reason: '需要先规划' }),
            }],
          }
        }
        return { text: '请先上传数据，我再继续。' }
      })

      const completed = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run(runOptions(run, thread.id))

      expect(completed.status, completed.state.errors.join('\n')).toBe('completed')
      expect(completed.state.planMode).toBe(true)
      expect(completed.state.agentWorkflow).toBeNull()
      expect(completed.state.errors).toEqual([])
      expect(requests).toHaveLength(2)
      expect(requests[1]?.systemInstructions).toBe(requests[0]?.systemInstructions)
      const secondInput = JSON.stringify(requests[1]?.input)
      expect(secondInput).toContain('用户只要求计划时可以直接交付正文计划')
      expect(secondInput.match(/<runtime-context>/g)).toHaveLength(1)
      expect(JSON.stringify(requests[1])).toContain('planningContext')
    } finally {
      await removeTempRoot(root)
    }
  })

  it('keeps supervisor system instructions byte-identical across different Threads', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-stable-system-prompt-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const firstThread = await store.createThread(session.id, '普通问答任务')
      const secondThread = await store.createThread(session.id, '计划模式任务')
      const config = testRuntimeConfig()
      const firstRun = await store.createRun(session.id, '介绍平台能力', {
        threadId: firstThread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const secondRun = await store.createRun(session.id, '给出空间分析计划', {
        threadId: secondThread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      await store.updateRunState(secondRun.id, { planMode: true })

      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(directResponseProvider())
      const requests: ModelRequest[] = []
      const model = scriptedModel(request => {
        requests.push(request)
        return { text: '已完成。' }
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))

      const firstCompleted = await runtime.run(runOptions(firstRun, firstThread.id))
      const secondCompleted = await runtime.run(runOptions(secondRun, secondThread.id))

      expect(firstCompleted.status).toBe('completed')
      expect(secondCompleted.status).toBe('completed')
      expect(requests).toHaveLength(2)
      expect(requests[1]?.systemInstructions).toBe(requests[0]?.systemInstructions)
      expect(JSON.stringify(requests[0]?.input)).not.toContain('## 计划模式')
      expect(JSON.stringify(requests[1]?.input)).toContain('## 计划模式')
      for (const request of requests) {
        const toolNames = request.tools.map(tool => tool.name)
        expect(toolNames).toEqual([...toolNames].sort((left, right) => left.localeCompare(right)))
      }
    } finally {
      await removeTempRoot(root)
    }
  })

  it('rejects completion while a visible Todo is still pending or running', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-incomplete-todo-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, 'Todo 完成边界')
      const run = await store.createRun(session.id, '完成当前任务', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      await store.updateRunState(run.id, {
        todos: [{
          todoId: 'todo_1',
          title: '执行尚未完成的步骤',
          status: 'running',
          description: null,
          activeForm: '正在执行',
          ownerAgentId: 'supervisor',
          stepId: null,
        }],
      })
      const model = scriptedModel(() => ({ text: '任务已经完成。' }))

      const failed = await testRuntime(store, new ToolRegistry(), registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
      })

      expect(failed.status).toBe('failed')
      expect(failed.state.errors.at(-1)).toContain('运行仍有未完成 Todo')
    } finally {
      await removeTempRoot(root)
    }
  })

  it('answers a greeting directly in explicit plan mode without manufacturing a clarification', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-greeting-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '计划模式寒暄')
      const run = await store.createRun(session.id, '你好', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      const model = scriptedModel(() => ({ text: '你好！有什么可以帮你分析？' }))

      const completed = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        executionMode: 'plan',
      })

      expect(completed.status).toBe('completed')
      expect(completed.state.planMode).toBe(true)
      expect(completed.state.clarification).toBeNull()
      expect(completed.state.decisions).toEqual([])
      expect(completed.state.errors).toEqual([])
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'message',
        payload: expect.objectContaining({ role: 'assistant', content: '你好！有什么可以帮你分析？' }),
      }))
    } finally {
      await removeTempRoot(root)
    }
  })

  it('requires the clarification tool when the planning goal is underspecified', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-clarify-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '计划模式澄清')
      const run = await store.createRun(session.id, '生成一份计划', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      const model = scriptedModel(() => ({
        toolCalls: [{
          id: 'call_clarify_plan',
          name: 'request_clarification',
          arguments: JSON.stringify({
            question: '请告诉我这份计划要解决什么任务，以及需要使用哪些数据或输出什么结果？',
            reason: '用户要求生成计划，但没有提供可规划目标和输出边界。',
            options: [],
            allowFreeText: true,
          }),
        }],
      }))

      const waiting = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        executionMode: 'plan',
      })

      expect(waiting.status).toBe('clarification_needed')
      expect(waiting.state.planMode).toBe(true)
      expect(waiting.state.clarification).toMatchObject({
        kind: 'plan_requirement',
        question: '请告诉我这份计划要解决什么任务，以及需要使用哪些数据或输出什么结果？',
        reason: '用户要求生成计划，但没有提供可规划目标和输出边界。',
        allowFreeText: true,
      })
      expect(waiting.state.decisions).toContainEqual(expect.objectContaining({
        decisionId: waiting.state.clarification?.clarificationId,
        kind: 'clarification',
        status: 'pending',
        allowFreeText: true,
      }))
      expect(waiting.state.errors).toEqual([])
    } finally {
      await removeTempRoot(root)
    }
  })

  it('records and executes a workflow without a duplicate plan approval', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-approval-'))
    try {
      const harness = new PersistenceFacadeTestHarness()
      const store = harness.create(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '计划审批')
      const config = testRuntimeConfig()
      const run = await store.createRun(session.id, '给我做一个风险区划图', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(directResponseProvider())
      const workflow = {
        goal: '生成短时强降水风险区划图',
        steps: [
          {
            stepId: 'step_1',
            title: '交付风险区划说明',
            kind: 'delivery',
            toolName: 'deliver_test_response',
            ownerAgentId: 'supervisor',
            args: { question: '风险区划结果' },
            reason: '交付经过验证的最终回答',
            dependsOn: [],
          },
        ],
      }
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return {
            toolCalls: [{ id: 'call_delivery', name: 'deliver_test_response', arguments: '{"question":"风险区划结果"}' }],
          }
        }
        return {
          toolCalls: [{
            id: 'call_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow }),
          }],
        }
      })

      const completed = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
        executionMode: 'plan',
      })

      expect(completed.status).toBe('completed')
      expect(completed.state.planMode).toBe(false)
      expect(completed.state.agentWorkflow).toMatchObject({
        goal: workflow.goal,
        status: 'completed',
        revision: 1,
        steps: [expect.objectContaining({ stepId: 'step_1', status: 'completed' })],
      })
      expect(completed.state.todos).toEqual([
        expect.objectContaining({ stepId: 'step_1', status: 'completed' }),
      ])
      expect(completed.state.approvals).toEqual([])
      expect(completed.state.decisions).toEqual([])
      const items = await store.listItems(run.id)
      expect(items.some(item => item.itemType === 'result' && item.metadata?.resultType === 'waiting_approval')).toBe(false)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('preserves a replacement workflow approval after the previous plan is rejected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-reapproval-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '计划退回后重新审批')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['submit_agent_workflow', 'revise_agent_workflow']
      const run = await store.createRun(session.id, '生成杭州市行政区划地图', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(directResponseProvider())
      const workflow = (title: string) => ({
        goal: '生成杭州市行政区划地图',
        steps: [workflowStep('step_delivery', title, 'deliver_test_response')],
      })
      let modelTurn = 0
      const model = scriptedModel(() => {
        modelTurn += 1
        if (modelTurn === 1 || modelTurn === 2) {
          return {
            toolCalls: [{
              id: `call_plan_${modelTurn}`,
              name: 'submit_agent_workflow',
              arguments: JSON.stringify({
                workflow: workflow(modelTurn === 1 ? '交付初版地图' : '交付修订地图'),
              }),
            }],
          }
        }
        return {
          toolCalls: [{
            id: 'call_delivery_after_reapproval',
            name: 'deliver_test_response',
            arguments: '{"question":"行政区划地图"}',
          }],
        }
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const firstWaiting = await runtime.run({
        ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan',
      })
      const firstApprovalId = firstWaiting.state.approvals[0]?.approvalId
      if (!firstApprovalId) throw new Error('测试没有生成首个工作流审批。')

      const secondWaiting = await runtime.resolveApproval(run.id, firstApprovalId, false)
      const pendingApprovals = secondWaiting.state.approvals.filter(item => item.status === 'pending')

      expect(secondWaiting.status).toBe('waiting_approval')
      expect(secondWaiting.state.approvals).toHaveLength(2)
      expect(secondWaiting.state.approvals.find(item => item.approvalId === firstApprovalId)).toMatchObject({
        status: 'rejected',
        payload: { consumed: true },
      })
      expect(pendingApprovals).toHaveLength(1)
      expect(pendingApprovals[0]?.payload.args).toMatchObject({
        workflow: { steps: [expect.objectContaining({ title: '交付修订地图' })] },
      })

      const secondApprovalId = pendingApprovals[0]?.approvalId
      if (!secondApprovalId) throw new Error('测试没有保留替换后的工作流审批。')
      const completed = await runtime.resolveApproval(run.id, secondApprovalId, true)

      expect(completed.status).toBe('completed')
      expect(completed.state.approvals.find(item => item.approvalId === secondApprovalId)).toMatchObject({
        status: 'approved',
        payload: { consumed: true },
      })
      expect(completed.state.agentWorkflow?.steps).toContainEqual(expect.objectContaining({
        title: '交付修订地图',
        status: 'completed',
      }))
    } finally {
      await removeTempRoot(root)
    }
  })

  it('uses the SDK input guardrail to repair unknown workflow tools before requesting approval', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-plan-tool-guardrail-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '计划工具契约护栏')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['submit_agent_workflow', 'revise_agent_workflow']
      const run = await store.createRun(session.id, '生成可审批地图计划', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(directResponseProvider())
      let modelTurn = 0
      let firstRequest: ModelRequest | null = null
      const model = scriptedModel(request => {
        modelTurn += 1
        firstRequest ??= request
        const selectedTool = modelTurn === 1 ? 'render_map' : 'deliver_test_response'
        return {
          toolCalls: [{
            id: `guarded_plan_${modelTurn}`,
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({
              workflow: {
                goal: '交付地图',
                steps: [workflowStep('step_delivery', '交付地图', selectedTool)],
              },
            }),
          }],
        }
      })

      const waiting = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan',
      })

      expect(modelTurn).toBe(2)
      expect(waiting.status).toBe('waiting_approval')
      expect(waiting.state.approvals).toHaveLength(1)
      expect(waiting.state.approvals[0]?.payload.args).toMatchObject({
        workflow: { steps: [expect.objectContaining({ toolName: 'deliver_test_response' })] },
      })
      expect(firstRequest?.systemInstructions).not.toContain('deliver_test_response')
      expect(JSON.stringify(firstRequest?.input)).toContain('deliver_test_response')
      expect(firstRequest?.tools.map(tool => tool.name)).toContain('deliver_test_response')
      expect((await store.getRunCheckpoint(run.id)).pendingToolCallIds).toEqual([])
      expect(waiting.state.errors).toEqual([])
    } finally {
      await removeTempRoot(root)
    }
  })

  it.each([
    ['strict SDK null values', 'strict', {
      query: '杭州',
      category: null,
      sourceType: null,
      status: null,
      limit: 20,
    }],
    ['compatible Chat Completions omissions', 'compatible', {
      query: '杭州',
      limit: 20,
    }],
  ] as const)('restores internal optional arguments from %s', async (_case, schemaMode, toolArguments) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-optional-tool-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '可选参数工具')
      const run = await store.createRun(session.id, '查杭州图层', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      let executedArgs: Record<string, unknown> | null = null
      const tools = new ToolRegistry()
      tools.register(providerFromTools('optional-tool-provider', [{
        name: 'list_layers',
        label: '检索图层',
        description: '检索图层',
        prompt: '用于测试可选参数省略时的工具调用。',
        group: '测试',
        tags: [],
        isReadOnly: true,
        isDestructive: false,
        jsonSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            category: { type: 'string' },
            sourceType: { type: 'string' },
            status: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
        handler: async (args) => {
          executedArgs = args
          return result('layers', [], { count: 0, layers: [] })
        },
      }]))
      const model = scriptedModel(request => hasToolResultNamed(request, 'list_layers')
        ? { text: '没有找到匹配的已注册图层。' }
        : {
            toolCalls: [{
              id: 'call_layers',
              name: 'list_layers',
              arguments: JSON.stringify(toolArguments),
            }],
          })

      const completed = await testRuntime(store, tools, registryWith(fakeAdapter(model, schemaMode))).run(runOptions(run, thread.id))

      expect(completed.status).toBe('completed')
      expect(completed.state.errors).toEqual([])
      expect(executedArgs).toEqual({ query: '杭州', limit: 20 })
      const checkpoint = await store.getRunCheckpoint(run.id)
      expect(checkpoint.pendingToolCallIds).toEqual([])
    } finally {
      await removeTempRoot(root)
    }
  })

  it('executes independent agent workflow steps concurrently without losing persisted results', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-agent-workflow-parallel-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '并行智能体工作流')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['submit_agent_workflow', 'revise_agent_workflow']
      config.maxFunctionToolConcurrency = 4
      const run = await store.createRun(session.id, '并行检查两类数据', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      let active = 0
      let maxActive = 0
      const parallelTool = (name: 'parallel_a' | 'parallel_b'): ToolDef => ({
        ...toolDefinition(name, []),
        parallelSafe: true,
        handler: async () => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise(resolve => setTimeout(resolve, 40))
          active -= 1
          return result(name, [], { name })
        },
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(providerFromTools('parallel-agent-workflow', [parallelTool('parallel_a'), parallelTool('parallel_b')]))
      const workflow = {
        goal: '并行检查两类数据',
        steps: [
          workflowStep('step_a', '检查数据 A', 'parallel_a'),
          workflowStep('step_b', '检查数据 B', 'parallel_b'),
        ],
      }
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'parallel_a') && hasToolResultNamed(request, 'parallel_b')) {
          return { text: '两类数据均已检查完成。' }
        }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return {
            toolCalls: [
              { id: 'call_parallel_a', name: 'parallel_a', arguments: '{}' },
              { id: 'call_parallel_b', name: 'parallel_b', arguments: '{}' },
            ],
          }
        }
        return {
          toolCalls: [{
            id: 'call_parallel_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow }),
          }],
        }
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({ ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan' })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成智能体工作流审批。')
      const completed = await runtime.resolveApproval(run.id, approval.approvalId, true)

      expect(completed.status).toBe('completed')
      expect(completed.state.agentWorkflow?.status).toBe('completed')
      expect(completed.state.agentWorkflow?.steps.map(step => step.status)).toEqual(['completed', 'completed'])
      expect(completed.state.toolResults.filter(item => item.tool === 'parallel_a' || item.tool === 'parallel_b')).toHaveLength(2)
      expect(maxActive).toBe(2)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('requires a new approval before executing a revised failed workflow', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-agent-workflow-revision-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '失败后调整智能体工作流')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['submit_agent_workflow', 'revise_agent_workflow']
      const run = await store.createRun(session.id, '检查数据并交付结论', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(directResponseProvider())
      let recoveryExecutions = 0
      tools.register(providerFromTools('agent-workflow-revision', [
        {
          ...toolDefinition('unstable_inspect', []),
          handler: async () => {
            throw new Error('主数据源校验失败')
          },
        },
        {
          ...toolDefinition('verified_recovery', []),
          handler: async () => {
            recoveryExecutions += 1
            return result('verified-recovery', [], { validated: true })
          },
        },
      ]))
      const initialWorkflow = {
        goal: '检查数据并交付结论',
        steps: [
          workflowStep('step_inspect', '检查主数据源', 'unstable_inspect'),
          workflowStep('step_delivery', '交付检查结论', 'deliver_test_response', ['step_inspect']),
        ],
      }
      const revisedWorkflow = {
        goal: '使用已验证的恢复数据完成检查并交付结论',
        changeReason: '主数据源校验失败，必须显式改用已经验证的恢复数据。',
        steps: [
          workflowStep('step_recovery', '验证恢复数据', 'verified_recovery'),
          workflowStep('step_delivery', '交付检查结论', 'deliver_test_response', ['step_recovery']),
        ],
      }
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'verified_recovery')) {
          return {
            toolCalls: [{
              id: 'call_revised_delivery',
              name: 'deliver_test_response',
              arguments: '{"question":"恢复数据检查结论"}',
            }],
          }
        }
        if (hasToolResultNamed(request, 'revise_agent_workflow')) {
          return { toolCalls: [{ id: 'call_recovery', name: 'verified_recovery', arguments: '{}' }] }
        }
        if (hasToolResultNamed(request, 'unstable_inspect')) {
          return {
            toolCalls: [{
              id: 'call_revision',
              name: 'revise_agent_workflow',
              arguments: JSON.stringify({ workflow: revisedWorkflow }),
            }],
          }
        }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return { toolCalls: [{ id: 'call_unstable', name: 'unstable_inspect', arguments: '{}' }] }
        }
        return {
          toolCalls: [{
            id: 'call_initial_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow: initialWorkflow }),
          }],
        }
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({ ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan' })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成智能体工作流审批。')

      const revisionWaiting = await runtime.resolveApproval(run.id, approval.approvalId, true)
      const revisionApproval = revisionWaiting.state.approvals.find(candidate => (
        candidate.status === 'pending' && candidate.action === 'revise_agent_workflow'
      ))
      if (!revisionApproval) throw new Error('测试没有生成工作流修订审批。')

      expect(revisionWaiting.status).toBe('waiting_approval')
      expect(recoveryExecutions).toBe(0)
      expect(revisionWaiting.state.agentWorkflow).toMatchObject({ revision: 1, status: 'adjusting' })
      expect(revisionApproval.payload.args).toMatchObject({ workflow: revisedWorkflow })

      const completed = await runtime.resolveApproval(run.id, revisionApproval.approvalId, true)

      expect(completed.id).toBe(run.id)
      expect(completed.status).toBe('completed')
      expect(recoveryExecutions).toBe(1)
      expect(completed.state.agentWorkflow).toMatchObject({
        revision: 2,
        status: 'completed',
        goal: revisedWorkflow.goal,
        changeReason: revisedWorkflow.changeReason,
      })
      expect(completed.state.agentWorkflow?.steps.map(step => [step.stepId, step.status])).toEqual([
        ['step_recovery', 'completed'],
        ['step_delivery', 'completed'],
      ])
      const events = await store.listEvents(run.id)
      expect(events.some(event => event.type === 'agent_workflow.revised')).toBe(true)
      expect(events.some(event => event.type === 'warning.raised' && event.message.includes('主数据源校验失败'))).toBe(true)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('recovers from a model-invented tool after workflow failure without hiding the root cause', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-missing-tool-recovery-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '失败后未知工具恢复')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['submit_agent_workflow', 'revise_agent_workflow']
      const run = await store.createRun(session.id, '检查数据并在缺少输入时询问用户', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(providerFromTools('missing-tool-recovery', [{
        ...toolDefinition('unstable_inspect', []),
        handler: async () => { throw new Error('主数据源校验失败') },
      }]))
      const workflow = {
        goal: '检查主数据源',
        steps: [workflowStep('step_inspect', '检查主数据源', 'unstable_inspect')],
      }
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'meteorological_inspect')) {
          return {
            toolCalls: [{
              id: 'call_missing_input',
              name: 'request_clarification',
              arguments: JSON.stringify({
                question: '主数据源校验失败。请上传包含可解析预报时效的数据后再继续。',
                reason: '现有输入无法形成可靠的替代执行路径。',
                options: [],
                allowFreeText: true,
              }),
            }],
          }
        }
        if (hasToolResultNamed(request, 'unstable_inspect')) {
          return {
            toolCalls: [{
              id: 'call_invented_tool',
              name: 'meteorological_inspect',
              arguments: '{}',
            }],
          }
        }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return { toolCalls: [{ id: 'call_unstable', name: 'unstable_inspect', arguments: '{}' }] }
        }
        return {
          toolCalls: [{
            id: 'call_initial_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow }),
          }],
        }
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({ ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan' })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成智能体工作流审批。')

      const clarification = await runtime.resolveApproval(run.id, approval.approvalId, true)

      expect(clarification.status).toBe('clarification_needed')
      expect(clarification.state.clarification).toMatchObject({
        question: '主数据源校验失败。请上传包含可解析预报时效的数据后再继续。',
      })
      expect(clarification.state.agentWorkflow?.status).toBe('adjusting')
      expect(clarification.state.errors).toContain('主数据源校验失败')
      expect(clarification.state.errors.join('\n')).not.toContain('Tool meteorological_inspect not found')
    } finally {
      await removeTempRoot(root)
    }
  })

  it('injects user steering into the active run and revises the workflow before continuing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-agent-workflow-steering-'))
    const releaseCollection = deferredSignal()
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '运行中引导智能体工作流')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['submit_agent_workflow', 'revise_agent_workflow']
      const run = await store.createRun(session.id, '检查数据并给出结论', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const collectionStarted = deferredSignal()
      let collectionExecutions = 0
      let tableExecutions = 0
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(directResponseProvider())
      tools.register(providerFromTools('agent-workflow-steering', [
        {
          ...toolDefinition('collect_guidance_data', []),
          handler: async () => {
            collectionExecutions += 1
            collectionStarted.resolve()
            await releaseCollection.promise
            return result('guidance-data', [], { rows: 12 })
          },
        },
        {
          ...toolDefinition('build_guidance_table', []),
          handler: async () => {
            tableExecutions += 1
            return result('guidance-table', [], { tableCreated: true })
          },
        },
      ]))
      const initialWorkflow = {
        goal: '检查数据并给出结论',
        steps: [
          workflowStep('step_collect', '采集检查数据', 'collect_guidance_data'),
          workflowStep('step_delivery', '交付检查结论', 'deliver_test_response', ['step_collect']),
        ],
      }
      const revisedWorkflow = {
        goal: '检查数据、生成表格并给出结论',
        changeReason: '用户在运行中明确要求增加可核验表格。',
        steps: [
          workflowStep('step_collect', '采集检查数据', 'collect_guidance_data'),
          workflowStep('step_table', '生成检查表格', 'build_guidance_table', ['step_collect']),
          workflowStep('step_delivery', '交付检查结论', 'deliver_test_response', ['step_table']),
        ],
      }
      let steeringObserved = false
      const model = scriptedModel(request => {
        if (hasToolResultNamed(request, 'build_guidance_table')) {
          return {
            toolCalls: [{
              id: 'call_steered_delivery',
              name: 'deliver_test_response',
              arguments: '{"question":"包含表格的检查结论"}',
            }],
          }
        }
        if (hasToolResultNamed(request, 'revise_agent_workflow')) {
          if (collectionExecutions < 2) {
            return { toolCalls: [{ id: 'call_guidance_collection_rev2', name: 'collect_guidance_data', arguments: '{}' }] }
          }
          return { toolCalls: [{ id: 'call_guidance_table', name: 'build_guidance_table', arguments: '{}' }] }
        }
        if (hasToolResultNamed(request, 'collect_guidance_data')) {
          steeringObserved = requestTexts(request).some(text => text.includes('增加一张可核验的表格'))
          if (!steeringObserved) throw new Error('运行中的用户引导消息没有进入下一次模型调用。')
          return {
            toolCalls: [{
              id: 'call_steering_revision',
              name: 'revise_agent_workflow',
              arguments: JSON.stringify({ workflow: revisedWorkflow }),
            }],
          }
        }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return { toolCalls: [{ id: 'call_guidance_collection', name: 'collect_guidance_data', arguments: '{}' }] }
        }
        return {
          toolCalls: [{
            id: 'call_guidance_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow: initialWorkflow }),
          }],
        }
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({ ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan' })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成智能体工作流审批。')

      const firstContinuation = runtime.resolveApproval(run.id, approval.approvalId, true)
      await collectionStarted.promise
      const steering = await runtime.steer(run.id, 'steer_add_table', '请增加一张可核验的表格，再给出结论。')
      releaseCollection.resolve()
      const revisionWaiting = await firstContinuation
      const revisionApproval = revisionWaiting.state.approvals.find(candidate => (
        candidate.status === 'pending' && candidate.action === 'revise_agent_workflow'
      ))
      if (!revisionApproval) throw new Error('测试没有生成用户引导后的工作流修订审批。')

      expect(revisionWaiting.status).toBe('waiting_approval')
      expect(tableExecutions).toBe(0)
      const completed = await runtime.resolveApproval(run.id, revisionApproval.approvalId, true)

      expect(completed.id).toBe(run.id)
      expect(completed.status).toBe('completed')
      expect(collectionExecutions).toBe(2)
      expect(tableExecutions).toBe(1)
      expect(steeringObserved).toBe(true)
      expect(completed.state.agentWorkflow).toMatchObject({
        revision: 2,
        status: 'completed',
        goal: revisedWorkflow.goal,
        changeReason: revisedWorkflow.changeReason,
      })
      expect(completed.state.agentWorkflow?.steps.map(step => [step.stepId, step.status, step.attempt])).toEqual([
        ['step_collect', 'completed', 1],
        ['step_table', 'completed', 1],
        ['step_delivery', 'completed', 1],
      ])
      expect((await store.listRunInputs(run.id))).toContainEqual(expect.objectContaining({
        steeringId: steering.steeringId,
        content: steering.content,
        status: 'checkpointed',
      }))
    } finally {
      releaseCollection.resolve()
      await removeTempRoot(root)
    }
  })

  it('retries a replay-safe model disconnect before the first semantic event', async () => {
    let attempts = 0
    const result = await executeTextRun(scriptedModel(() => {
      attempts += 1
      if (attempts === 1) throw new ReplaySafeTestError('terminated')
      return { text: '连接恢复后的回答。' }
    }))
    expect(attempts).toBe(2)
    expect(result.run.status).toBe('completed')
    expect(result.items.some(item => item.body === '连接恢复后的回答。')).toBe(true)
  })

  it('reuses one committed request across a provider retry and opens a new attempt for the next model step', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-model-request-retry-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const config = testRuntimeConfig()
      config.hookConfigs = [{
        hookId: 'retry-context',
        eventType: 'StepContextCaptured',
        enabled: true,
        matcher: {},
        priority: 0,
        description: '',
        timeoutMs: 1_000,
        failureMode: 'fail_closed',
      }]
      const thread = await store.createThread(session.id, '供应商重试快照')
      const run = await store.createRun(session.id, '查询图层后回答', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const tools = new ToolRegistry()
      tools.register(providerFromTools('model-request-retry', [{
        ...toolDefinition('query_layer', ['query']),
        handler: async () => result('query_layer', [], { count: 1 }),
      }]))
      const recordedRequests: string[] = []
      const runnerManagedRetryFlags: boolean[] = []
      let firstStepAttempts = 0
      const model = scriptedModel(request => {
        recordedRequests.push(modelRequestWithoutTransientControls(request))
        runnerManagedRetryFlags.push(modelRequestRunnerManagedRetry(request))
        if (!hasToolResultNamed(request, 'query_layer')) {
          firstStepAttempts += 1
          if (firstStepAttempts === 1) throw new ReplaySafeTestError('terminated')
          return {
            toolCalls: [{
              id: 'call_retry_query',
              name: 'query_layer',
              arguments: '{"query":"current"}',
            }],
          }
        }
        return { text: '已用真实图层结果完成。' }
      })
      const captures: CaptureAgentStepContextInput[] = []
      let hookInvocations = 0
      let committedRequests = 0
      const originalPublish = store.publishModelRequestSnapshot.bind(store)
      store.publishModelRequestSnapshot = async (...args) => {
        committedRequests += 1
        return originalPublish(...args)
      }
      const hook: RuntimeHookHandler = {
        hookId: 'retry-context',
        eventTypes: ['StepContextCaptured'],
        source: 'platform',
        execute: async () => {
          hookInvocations += 1
          return { decision: 'continue', additionalContext: '使用当前已绑定世界。' }
        },
      }
      const runtime = new OpenAIAgentsRuntime(
        store,
        tools,
        registryWith(fakeAdapter(model)),
        {
          stepContexts: createTestAgentStepContextRecorder({
            onRecord: input => captures.push(input),
          }),
          createSandboxClient: testSandboxClientFactory,
          hookHandlers: [hook],
        },
      )

      const completed = await runtime.run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
      })

      expect(completed.status).toBe('completed')
      expect(await store.listRunInputs(run.id)).toEqual([])
      expect(recordedRequests).toHaveLength(3)
      expect(recordedRequests[1]).toBe(recordedRequests[0])
      expect(recordedRequests[2]).not.toBe(recordedRequests[1])
      expect(runnerManagedRetryFlags).toEqual([false, true, false])
      expect(firstStepAttempts).toBe(2)
      expect(captures).toHaveLength(2)
      expect(hookInvocations).toBe(2)
      expect(committedRequests).toBe(2)
      expect(await store.listModelRequests(run.id)).toHaveLength(2)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('persists the concrete model error after the only safe retry also fails', async () => {
    const result = await executeTextRun(scriptedModel(() => {
      throw new ReplaySafeTestError('terminated')
    }))
    expect(result.run.status).toBe('failed')
    expect(result.run.state.errors[0]).toBe('服务处理失败。请查看服务端日志。')
    expect(result.items.at(-1)?.metadata.message).toBe('服务处理失败。请查看服务端日志。')
  })

  it('keeps normal tool preambles out of reasoning and delivers terminal tool output', async () => {
    let turns = 0
    const tools = new ToolRegistry()
    tools.register(directResponseProvider())
    const model = scriptedModel(() => {
      turns += 1
      return {
        text: '我先分析一下。',
        toolCalls: [{ id: 'answer_call', name: 'deliver_test_response', arguments: '{"question":"测试直接交付"}' }],
      }
    })
    const result = await executeTextRun(model, tools)
    expect(turns).toBe(1)
    expect(result.run.status).toBe('completed')
    expect(result.items.some(item => item.itemType === 'reasoning' && item.body === '我先分析一下。')).toBe(false)
    expect(result.items.some(item => item.itemType === 'message' && item.body === '我先分析一下。')).toBe(true)
    expect(result.items.some(item => item.itemType === 'message' && item.body === '预报时段内未检出达到有效阈值的降雨。')).toBe(true)
    const preambleIndex = result.items.findIndex(item => item.itemType === 'message' && item.body === '我先分析一下。')
    const toolIndex = result.items.findIndex(item => item.itemType === 'function_call' && item.name === 'deliver_test_response')
    const finalIndex = result.items.findIndex(item => item.itemType === 'message' && item.body === '预报时段内未检出达到有效阈值的降雨。')
    expect(preambleIndex).toBeLessThan(toolIndex)
    expect(toolIndex).toBeLessThan(finalIndex)
    const transcriptToolIndex = result.transcript.findIndex(entry => entry.kind === 'tool_call' && entry.payload.name === 'deliver_test_response')
    const transcriptPreambleIndex = result.transcript.findIndex(entry => (
      entry.kind === 'checkpoint'
      && entry.payload.type === 'assistant_content_for_tool_call'
      && entry.payload.callId === 'answer_call'
    ))
    const transcriptResultIndex = result.transcript.findIndex(entry => entry.kind === 'tool_result' && entry.payload.name === 'deliver_test_response')
    const transcriptFinalIndex = result.transcript.findIndex(entry => entry.kind === 'message' && entry.payload.content === '预报时段内未检出达到有效阈值的降雨。')
    expect(result.transcript[transcriptPreambleIndex].payload.content).toBe('我先分析一下。')
    expect(transcriptToolIndex).toBeLessThan(transcriptResultIndex)
    expect(transcriptToolIndex).toBeLessThan(transcriptPreambleIndex)
    expect(transcriptResultIndex).toBeLessThan(transcriptFinalIndex)
  })

  it('publishes SDK text deltas on the same assistant item before completion', async () => {
    const responseId = 'response_streaming_text'
    const model: Model = {
      async getResponse(): Promise<ModelResponse> {
        throw new Error('流式运行不应调用 getResponse')
      },
      async *getStreamedResponse(): AsyncIterable<ResponseStreamEvent> {
        yield { type: 'response_started' }
        yield { type: 'output_text_delta', delta: '逐字' }
        yield { type: 'output_text_delta', delta: '显示。' }
        yield {
          type: 'response_done',
          response: {
            id: responseId,
            usage: { requests: 1, inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            output: outputItems({ text: '逐字显示。' }, responseId),
          },
        }
      },
    }

    const outcome = await executeTextRun(model)
    const assistantUpdates = outcome.liveItems.filter(item => (
      item.itemType === 'message' && item.role === 'assistant'
    ))
    const assistantItemId = assistantUpdates[0]?.itemId
    const assistantDeltas = outcome.liveItemDeltas.filter(delta => delta.itemId === assistantItemId)

    expect(assistantUpdates.map(item => [item.status, item.body])).toEqual([
      ['running', null],
      ['completed', '逐字显示。'],
    ])
    expect(new Set(assistantUpdates.map(item => item.itemId))).toHaveLength(1)
    expect(assistantDeltas.map(delta => ({
      sequence: delta.sequence,
      utf16Offset: delta.utf16Offset,
      text: delta.text,
    }))).toEqual([
      { sequence: 1, utf16Offset: 0, text: '逐字' },
      { sequence: 2, utf16Offset: 2, text: '显示。' },
    ])
  })

  it('negotiates native Responses web search only for a capable provider', async () => {
    let requestedTools: ModelRequest['tools'] = []
    const model = scriptedModel(request => {
      requestedTools = request.tools
      return { text: '已完成。' }
    })

    const outcome = await executeTextRun(model, new ToolRegistry(), '回答测试问题', true)

    expect(outcome.run.status).toBe('completed')
    expect(requestedTools).toContainEqual(expect.objectContaining({
      type: 'hosted_tool',
      name: 'web_search',
    }))
  })

  it('keeps provider reasoning in the SDK run while publishing it to the reasoning panel', async () => {
    const tools = new ToolRegistry()
    tools.register(providerFromTools('reasoning-replay-test', [{
      ...toolDefinition('lookup_context', ['query']),
      handler: async () => result('lookup', [], { ok: true }),
    }]))
    let turns = 0
    let secondTurnInput: unknown[] = []
    const model = scriptedModel(request => {
      turns += 1
      if (hasToolResult(request)) {
        secondTurnInput = Array.isArray(request.input) ? request.input : []
        return { text: '工具后总结。' }
      }
      return {
        reasoning: 'The provider may return an English chain of thought.',
        text: '我先查询上下文。',
        toolCalls: [{ id: 'call_lookup', name: 'lookup_context', arguments: '{"query":"杭州"}' }],
      }
    })

    const outcome = await executeTextRun(model, tools)

    expect(outcome.run.status).toBe('completed')
    expect(turns).toBe(2)
    // Agents SDK 会把 Responses reasoning item 原样带到同一 run 的下一次 Model 请求。
    expect(secondTurnInput.some(item => isRecord(item) && item.type === 'reasoning')).toBe(true)
    expect(outcome.items.some(item => (
      item.itemType === 'reasoning'
      && item.body?.includes('English chain of thought')
    ))).toBe(true)
    expect(outcome.items.some(item => item.itemType === 'message' && item.body === '工具后总结。')).toBe(true)
  })

  it('repairs a premature current-weather delivery until the required tool evidence exists', async () => {
    const tools = new ToolRegistry()
    tools.register(providerFromTools('terminal-weather-evidence-test', [{
      ...toolDefinition('query_public_weather', ['place']),
      handler: async () => result('Open-Meteo 公开天气已返回', [], {
        location: '浙江省杭州市西湖区',
        precipitationProbability: 72,
      }),
    }]))
    let turns = 0
    const model = scriptedModel(request => {
      turns += 1
      if (hasToolResultNamed(request, 'query_public_weather')) {
        return { text: '西湖附近明天下午降水概率最高为 72%，数据来自 Open-Meteo。' }
      }
      if (requestTexts(request).some(text => text.includes('<terminal_delivery_repair>'))) {
        return {
          reasoning: 'I should use the weather tool now.',
          toolCalls: [{
            id: 'call_public_weather',
            name: 'query_public_weather',
            arguments: '{"place":"浙江杭州西湖"}',
          }],
        }
      }
      return { text: '## 查询西湖位置\n我先查询西湖的精确位置，以便获取准确的天气预报。' }
    })

    const outcome = await executeTextRun(
      model,
      tools,
      '浙江杭州西湖附近明天会下雨吗？请告诉我最可能下雨的时段、概率和雨量。',
    )

    expect(outcome.run.status).toBe('completed')
    expect(turns).toBe(3)
    expect(outcome.transcript.filter(entry => (
      entry.kind === 'tool_result'
      && entry.payload.name === 'query_public_weather'
      && entry.payload.ledgerStatus === 'completed'
    ))).toHaveLength(1)
    expect(outcome.items.some(item => (
      item.itemType === 'message'
      && item.body === '西湖附近明天下午降水概率最高为 72%，数据来自 Open-Meteo。'
    ))).toBe(true)
    expect(outcome.items.some(item => item.body?.includes('我先查询西湖'))).toBe(false)
  })

  it('keeps the place context across natural-language weather follow-ups', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-weather-follow-up-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '天气连续追问')
      const config = testRuntimeConfig()
      const observedArgs: Record<string, unknown>[] = []
      const tools = new ToolRegistry()
      tools.register(providerFromTools('weather-follow-up-test', [{
        ...toolDefinition('query_public_weather', ['place']),
        jsonSchema: {
          type: 'object',
          properties: {
            place: { type: 'string' },
            date: { type: 'string', enum: ['today', 'tomorrow'] },
          },
          required: ['place', 'date'],
        },
        handler: async args => {
          observedArgs.push(args)
          return result('公开天气数据已返回', [], {
            place: args.place,
            precipitationProbability: args.date === 'tomorrow' ? 65 : 25,
          })
        },
      }]))
      const model = scriptedModel(request => {
        const input = Array.isArray(request.input) ? request.input : []
        const hasTomorrowResult = input.some(item => (
          item.type === 'function_call_result' && item.callId === 'call_weather_tomorrow'
        ))
        const hasTodayResult = input.some(item => (
          item.type === 'function_call_result' && item.callId === 'call_weather_today'
        ))
        const latestQuestion = requestTexts(request).at(-1) ?? ''
        if (hasTomorrowResult) {
          return { text: '根据 Open-Meteo 公开天气数据，杭州明天有 65% 的降水概率，建议出门带伞。' }
        }
        if (latestQuestion.includes('明天')) {
          return {
            toolCalls: [{
              id: 'call_weather_tomorrow',
              name: 'query_public_weather',
              arguments: '{"place":"杭州","date":"tomorrow"}',
            }],
          }
        }
        if (hasTodayResult) {
          return { text: '根据 Open-Meteo 公开天气数据，杭州今天降水概率为 25%，短时下雨可能性较低。' }
        }
        return {
          toolCalls: [{
            id: 'call_weather_today',
            name: 'query_public_weather',
            arguments: '{"place":"杭州","date":"today"}',
          }],
        }
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const firstRun = await store.createRun(session.id, '杭州今天会下雨吗？', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const first = await runtime.run({
        ...runOptions(firstRun, thread.id),
        runtimeConfig: config,
      })
      const secondRun = await store.createRun(session.id, '那明天呢？', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const second = await runtime.run({
        ...runOptions(secondRun, thread.id),
        runtimeConfig: config,
      })

      expect(first.state.errors, first.state.errors.join('\n')).toEqual([])
      expect(second.state.errors, second.state.errors.join('\n')).toEqual([])
      expect(first.status).toBe('completed')
      expect(second.status).toBe('completed')
      expect(observedArgs).toEqual([
        { place: '杭州', date: 'today' },
        { place: '杭州', date: 'tomorrow' },
      ])
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript.filter(entry => (
        entry.kind === 'message' && entry.payload.role === 'user'
      )).map(entry => entry.payload.content)).toEqual([
        '杭州今天会下雨吗？',
        '那明天呢？',
      ])
    } finally {
      await removeTempRoot(root)
    }
  })

  it('asks a natural clarification when a weather question has no place', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-weather-clarification-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '天气地点澄清')
      const config = testRuntimeConfig()
      const run = await store.createRun(session.id, '今天会下雨吗？', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const tools = new ToolRegistry()
      tools.register(planProvider)
      const model = scriptedModel(() => ({
        toolCalls: [{
          id: 'call_weather_place_clarification',
          name: 'request_clarification',
          arguments: JSON.stringify({
            question: '你想查询哪个城市或区县的天气？',
            reason: '天气预报需要明确地点。',
            options: [],
            allowFreeText: true,
          }),
        }],
      }))

      const waiting = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
      })

      expect(waiting.status).toBe('clarification_needed')
      expect(waiting.state.clarification).toMatchObject({
        question: '你想查询哪个城市或区县的天气？',
        allowFreeText: true,
      })
    } finally {
      await removeTempRoot(root)
    }
  })

  it('runs configured subagents as Agent tools with inherited model and persisted transcript', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-subagent-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '子 Agent 测试')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['submit_agent_workflow', 'revise_agent_workflow']
      config.subAgents = [{
        agentId: 'spatial_analyst',
        name: '空间分析助手',
        role: 'spatial_analyst',
        summary: '执行空间分析',
        systemPrompt: '你是空间子智能体。',
        model: null,
        tools: ['query_layer'],
        delegationMode: 'as_tool',
        parallelSafe: false,
        maxTurns: 12,
        timeoutMs: 120_000,
      }]
      const tools = new ToolRegistry()
      tools.register(planProvider)
      let subAgentToolCalls = 0
      tools.register(providerFromTools('subagent-tools', [{
        ...toolDefinition('query_layer', ['query']),
        handler: async () => {
          subAgentToolCalls += 1
          return result('query', [], { rows: [] })
        },
      }]))
      const workflow = {
        goal: '委托空间分析子智能体检查当前图层',
        steps: [{
          stepId: 'step_spatial_agent',
          title: '委托空间分析助手',
          kind: 'agent' as const,
          toolName: 'spatial_analyst',
          ownerAgentId: 'spatial_analyst',
          args: subAgentArgs('分析当前图层', ['图层分析摘要']),
          reason: '由具备空间分析工具权限的子智能体完成专业检查',
          dependsOn: [],
        }],
      }
      let subAgentTurns = 0
      let planningTools: string[] = []
      let executionTools: string[] = []
      const supervisorUsage = {
        requests: 1,
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        inputTokensDetails: { cached_tokens: 6 },
      }
      const nestedUsage = {
        requests: 1,
        inputTokens: 4,
        outputTokens: 1,
        totalTokens: 5,
        inputTokensDetails: { cached_tokens: 3 },
      }
      const model = scriptedModel(request => {
        if (request.systemInstructions?.includes('空间子智能体')) {
          subAgentTurns += 1
          if (hasToolResultNamed(request, 'query_layer')) {
            return { text: '子分析完成。', usage: nestedUsage }
          }
          return {
            toolCalls: [{
              id: 'subagent_query_call',
              name: 'query_layer',
              arguments: '{"query":"检查当前图层"}',
            }],
            usage: nestedUsage,
          }
        }
        if (hasToolResultNamed(request, 'spatial_analyst')) {
          return { text: '主智能体已汇总子分析。', usage: supervisorUsage }
        }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          executionTools = request.tools.map(tool => tool.name)
          return {
            toolCalls: [{ id: 'sub_call_1', name: 'spatial_analyst', arguments: JSON.stringify(subAgentArgs('分析当前图层', ['图层分析摘要'])) }],
            usage: supervisorUsage,
          }
        }
        planningTools = request.tools.map(tool => tool.name)
        return {
          toolCalls: [{
            id: 'subagent_plan_call',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow }),
          }],
          usage: supervisorUsage,
        }
      })
      const run = await store.createRun(session.id, '请分析当前图层', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const liveItems: ConversationItem[] = []
      testPlatformEventHub(store).conversationItems.subscribe(run.id, item => liveItems.push(item))
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({
        ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan',
      })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成智能体工作流审批。')
      const completed = await runtime.resolveApproval(run.id, approval.approvalId, true)
      await store.flushConversationStore()

      expect({ status: completed.status, errors: completed.state.errors }).toEqual({
        status: 'completed',
        errors: [],
      })
      expect(subAgentTurns).toBe(2)
      expect(subAgentToolCalls).toBe(1)
      // 3 次 Supervisor 响应由父 stream 记录，2 次 Agent-as-tool
      // 响应由嵌套模型边界记录，两者互斥且同属一个 Run。
      expect(completed.state.runtimeStats).toMatchObject({
        modelInputTokens: 38,
        modelOutputTokens: 8,
        modelTotalTokens: 46,
        modelCacheHitInputTokens: 24,
        modelUsageResponseCount: 5,
      })
      expect(planningTools).not.toContain('spatial_analyst')
      expect(executionTools).toContain('spatial_analyst')
      expect(executionTools).not.toContain('exec_command')
      expect(executionTools).not.toContain('read_file')
      expect(completed.state.subAgents).toContainEqual(expect.objectContaining({
        agentId: 'spatial_analyst',
        status: 'completed',
        stepIds: ['step_spatial_agent'],
        currentStepId: null,
      }))
      expect(completed.state.agentWorkflow).toMatchObject({
        status: 'completed',
        steps: [expect.objectContaining({
          stepId: 'step_spatial_agent',
          kind: 'agent',
          ownerAgentId: 'spatial_analyst',
          status: 'completed',
        })],
      })
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript.some(entry => entry.kind === 'tool_call' && entry.payload.name === 'spatial_analyst')).toBe(true)
      expect(transcript.some(entry => entry.kind === 'tool_result' && entry.payload.name === 'spatial_analyst')).toBe(true)
      const subAgentCallUpdates = liveItems.filter(item => (
        item.itemType === 'function_call' && item.name === 'spatial_analyst'
      ))
      expect(subAgentCallUpdates.map(item => item.status)).toEqual(['running', 'completed'])
      const queryCompletedIndex = liveItems.findIndex(item => (
        item.itemType === 'function_call_output'
        && item.name === 'query_layer'
        && item.status === 'completed'
      ))
      const subAgentCompletedIndex = liveItems.findIndex(item => (
        item.itemType === 'function_call'
        && item.name === 'spatial_analyst'
        && item.status === 'completed'
      ))
      expect(queryCompletedIndex).toBeGreaterThanOrEqual(0)
      expect(subAgentCompletedIndex).toBeGreaterThan(queryCompletedIndex)
      const agentLog = await readFile(path.join(
        root, 'sessions', session.id, 'threads', thread.id,
        'runs', run.id, 'agents', 'spatial_analyst', 'transcript.jsonl',
      ), 'utf8')
      expect(agentLog).toContain('completed_item')
    } finally {
      await removeTempRoot(root)
    }
  })

  it('restores a nested Agent-as-tool approval from the parent SDK RunState', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-subagent-approval-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '子智能体审批恢复')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['submit_agent_workflow', 'revise_agent_workflow', 'sensitive_tool']
      config.subAgents = [{
        agentId: 'sensitive_analyst',
        name: '敏感分析助手',
        role: 'analyst',
        summary: '执行需要审批的分析',
        systemPrompt: '你是敏感分析子智能体。',
        model: null,
        tools: ['sensitive_tool'],
        delegationMode: 'as_tool',
        parallelSafe: false,
        maxTurns: 12,
        timeoutMs: 120_000,
      }]
      let executions = 0
      const tools = new ToolRegistry()
      tools.register(planProvider)
      tools.register(approvalProvider(() => { executions += 1 }))
      const invocation = subAgentArgs('执行敏感分析', ['审批后的分析结论'])
      const workflow = {
        goal: '由子智能体执行需要审批的分析',
        steps: [{
          stepId: 'step_sensitive_agent',
          title: '委托敏感分析助手',
          kind: 'agent' as const,
          toolName: 'sensitive_analyst',
          ownerAgentId: 'sensitive_analyst',
          args: invocation,
          reason: '由受限子智能体完成',
          dependsOn: [],
        }],
      }
      const model = scriptedModel(request => {
        if (request.systemInstructions?.includes('敏感分析子智能体')) {
          if (hasToolResultNamed(request, 'sensitive_tool')) {
            return { text: '审批后的子分析已经完成。' }
          }
          return {
            toolCalls: [{
              id: 'call_nested_sensitive',
              name: 'sensitive_tool',
              arguments: '{"value":1}',
            }],
          }
        }
        if (hasToolResultNamed(request, 'sensitive_analyst')) {
          return { text: '主智能体已汇总审批后的子分析。' }
        }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return {
            toolCalls: [{
              id: 'call_sensitive_agent',
              name: 'sensitive_analyst',
              arguments: JSON.stringify(invocation),
            }],
          }
        }
        return {
          toolCalls: [{
            id: 'call_sensitive_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow }),
          }],
        }
      })
      const run = await store.createRun(session.id, '请执行一项需要审批的敏感分析', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const workflowWaiting = await runtime.run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
        executionMode: 'plan',
      })
      const workflowApproval = workflowWaiting.state.approvals.find(item => (
        item.action === 'submit_agent_workflow' && item.status === 'pending'
      ))
      if (!workflowApproval) throw new Error('测试没有生成工作流审批')

      const nestedWaiting = await runtime.resolveApproval(
        run.id,
        workflowApproval.approvalId,
        true,
      )
      expect(nestedWaiting.state.errors, nestedWaiting.state.errors.join('\n')).toEqual([])
      expect(nestedWaiting.status).toBe('waiting_approval')
      const nestedApproval = nestedWaiting.state.approvals.find(item => (
        item.action === 'sensitive_tool' && item.status === 'pending'
      ))
      if (!nestedApproval) throw new Error('测试没有生成子智能体内部审批')
      const checkpointEnvelope = new AgentsSdkCheckpointCodec().decode(
        await store.readAgentsSdkCheckpointEnvelope(run.id),
      )

      expect(nestedWaiting.status).toBe('waiting_approval')
      expect(executions).toBe(0)
      expect(checkpointEnvelope.publicSerializedState).not.toHaveLength(0)
      expect(checkpointEnvelope.segmentId).not.toHaveLength(0)

      const completed = await runtime.resolveApproval(
        run.id,
        nestedApproval.approvalId,
        true,
      )

      expect(completed.state.errors, completed.state.errors.join('\n')).toEqual([])
      expect(completed.status).toBe('completed')
      expect(executions).toBe(1)
      expect(completed.state.runtimeStats).toMatchObject({
        modelInputTokens: 5,
        modelOutputTokens: 5,
        modelTotalTokens: 10,
        modelUsageResponseCount: 5,
      })
      expect(completed.state.subAgents).toContainEqual(expect.objectContaining({
        agentId: 'sensitive_analyst',
        status: 'completed',
      }))
      expect(completed.state.agentWorkflow).toMatchObject({
        status: 'completed',
        steps: [expect.objectContaining({
          stepId: 'step_sensitive_agent',
          status: 'completed',
        })],
      })
    } finally {
      await removeTempRoot(root)
    }
  })

  it('runs two parallel-safe Agent-as-tool calls concurrently through the SDK Runner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-parallel-subagents-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '并行子智能体测试')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['submit_agent_workflow', 'revise_agent_workflow']
      config.subAgents = [
        {
          agentId: 'parallel_alpha',
          name: '并行甲助手',
          role: 'analyst',
          summary: '并行检查数据甲',
          systemPrompt: '你是并行甲子智能体。',
          model: null,
          tools: ['parallel_a'],
          delegationMode: 'as_tool',
          parallelSafe: true,
          maxTurns: 12,
          timeoutMs: 120_000,
        },
        {
          agentId: 'parallel_beta',
          name: '并行乙助手',
          role: 'analyst',
          summary: '并行检查数据乙',
          systemPrompt: '你是并行乙子智能体。',
          model: null,
          tools: ['parallel_b'],
          delegationMode: 'as_tool',
          parallelSafe: true,
          maxTurns: 12,
          timeoutMs: 120_000,
        },
      ]
      const tools = new ToolRegistry()
      tools.register(planProvider)
      const toolExecutions: string[] = []
      tools.register(providerFromTools('parallel-subagent-tools', [
        {
          ...toolDefinition('parallel_a', []),
          parallelSafe: true,
          handler: async () => {
            toolExecutions.push('parallel_a')
            return result('parallel_a', [], { checked: 'a' })
          },
        },
        {
          ...toolDefinition('parallel_b', []),
          parallelSafe: true,
          handler: async () => {
            toolExecutions.push('parallel_b')
            return result('parallel_b', [], { checked: 'b' })
          },
        },
      ]))
      const workflow = {
        goal: '并行完成两个彼此独立的只读检查',
        steps: [
          {
            stepId: 'step_parallel_alpha',
            title: '检查数据甲',
            kind: 'agent' as const,
            toolName: 'parallel_alpha',
            ownerAgentId: 'parallel_alpha',
            args: subAgentArgs('检查数据甲', ['甲检查结论']),
            reason: '两个数据源彼此独立，可以并发读取',
            dependsOn: [],
          },
          {
            stepId: 'step_parallel_beta',
            title: '检查数据乙',
            kind: 'agent' as const,
            toolName: 'parallel_beta',
            ownerAgentId: 'parallel_beta',
            args: subAgentArgs('检查数据乙', ['乙检查结论']),
            reason: '两个数据源彼此独立，可以并发读取',
            dependsOn: [],
          },
        ],
      }
      const baseModel = scriptedModel(request => {
        if (request.systemInstructions?.includes('并行甲子智能体')) {
          return hasToolResultNamed(request, 'parallel_a')
            ? { text: '数据甲检查完成。' }
            : { toolCalls: [{ id: 'call_parallel_a', name: 'parallel_a', arguments: '{}' }] }
        }
        if (request.systemInstructions?.includes('并行乙子智能体')) {
          return hasToolResultNamed(request, 'parallel_b')
            ? { text: '数据乙检查完成。' }
            : { toolCalls: [{ id: 'call_parallel_b', name: 'parallel_b', arguments: '{}' }] }
        }
        if (hasToolResultNamed(request, 'parallel_alpha') && hasToolResultNamed(request, 'parallel_beta')) {
          return { text: '两个只读检查都已汇总。' }
        }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return {
            toolCalls: [
              {
                id: 'call_parallel_alpha_agent',
                name: 'parallel_alpha',
                arguments: JSON.stringify(subAgentArgs('检查数据甲', ['甲检查结论'])),
              },
              {
                id: 'call_parallel_beta_agent',
                name: 'parallel_beta',
                arguments: JSON.stringify(subAgentArgs('检查数据乙', ['乙检查结论'])),
              },
            ],
          }
        }
        return {
          toolCalls: [{
            id: 'call_parallel_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow }),
          }],
        }
      })
      const firstChildRequests = deferredSignal()
      let firstChildArrivals = 0
      let activeChildRequests = 0
      let maxActiveChildRequests = 0
      const isFirstChildRequest = (request: ModelRequest) => (
        request.systemInstructions?.includes('并行甲子智能体')
          ? !hasToolResultNamed(request, 'parallel_a')
          : request.systemInstructions?.includes('并行乙子智能体')
            ? !hasToolResultNamed(request, 'parallel_b')
            : false
      )
      const waitForParallelChild = async () => {
        activeChildRequests += 1
        maxActiveChildRequests = Math.max(maxActiveChildRequests, activeChildRequests)
        firstChildArrivals += 1
        if (firstChildArrivals === 2) firstChildRequests.resolve()
        await firstChildRequests.promise
      }
      const model: Model = {
        async getResponse(request) {
          if (!isFirstChildRequest(request)) return baseModel.getResponse(request)
          try {
            await waitForParallelChild()
            return await baseModel.getResponse(request)
          } finally {
            activeChildRequests -= 1
          }
        },
        async *getStreamedResponse(request) {
          if (!isFirstChildRequest(request)) {
            yield* baseModel.getStreamedResponse(request)
            return
          }
          try {
            await waitForParallelChild()
            yield* baseModel.getStreamedResponse(request)
          } finally {
            activeChildRequests -= 1
          }
        },
      }
      const run = await store.createRun(session.id, '并行检查两份数据', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({
        ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan',
      })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成并行智能体工作流审批。')

      const completed = await runtime.resolveApproval(run.id, approval.approvalId, true)

      expect(completed.status).toBe('completed')
      expect(completed.state.errors).toEqual([])
      expect(maxActiveChildRequests).toBe(2)
      expect(toolExecutions.sort()).toEqual(['parallel_a', 'parallel_b'])
      expect(completed.state.runtimeStats).toMatchObject({
        modelInputTokens: 7,
        modelOutputTokens: 7,
        modelTotalTokens: 14,
        modelUsageResponseCount: 7,
      })
      expect(completed.state.subAgents).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentId: 'parallel_alpha', status: 'completed' }),
        expect.objectContaining({ agentId: 'parallel_beta', status: 'completed' }),
      ]))
      expect(completed.state.agentWorkflow).toMatchObject({
        status: 'completed',
        steps: [
          expect.objectContaining({ stepId: 'step_parallel_alpha', status: 'completed' }),
          expect.objectContaining({ stepId: 'step_parallel_beta', status: 'completed' }),
        ],
      })
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'tool_call',
        payload: expect.objectContaining({ name: 'parallel_alpha' }),
      }))
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'tool_result',
        payload: expect.objectContaining({ name: 'parallel_beta', ledgerStatus: 'completed' }),
      }))
      expect((await store.getRunCheckpoint(run.id)).pendingToolCallIds).toEqual([])
    } finally {
      await removeTempRoot(root)
    }
  })

  it('rejects parallel subagents with write-capable tools during runtime assembly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-parallel-safety-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '并行工具安全边界')
      const config = testRuntimeConfig()
      config.subAgents = [{
        agentId: 'unsafe_parallel_agent',
        name: '不安全并行助手',
        role: 'writer',
        summary: '尝试并行写入',
        systemPrompt: null,
        model: null,
        tools: ['write_layer'],
        delegationMode: 'as_tool',
        parallelSafe: true,
        maxTurns: 12,
        timeoutMs: 120_000,
      }]
      const tools = new ToolRegistry()
      tools.register(providerFromTools('unsafe-parallel-tool', [{
        ...toolDefinition('write_layer', ['value']),
        isReadOnly: false,
        isDestructive: true,
        handler: async () => result('write', [], { ok: true }),
      }]))
      const run = await store.createRun(session.id, '并行写入数据', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })

      const failed = await testRuntime(
        store,
        tools,
        registryWith(fakeAdapter(scriptedModel(() => ({ text: '不应调用模型' })))),
      ).run({ ...runOptions(run, thread.id), runtimeConfig: config })

      expect(failed.status).toBe('failed')
      expect(failed.state.errors.at(-1)).toContain(
        "只有在全部工具都显式 parallelSafe、只读、无破坏且免审批时才能共享并发；'write_layer' 不符合。",
      )
    } finally {
      await removeTempRoot(root)
    }
  })

  it('hands the live conversation to a configured specialist and records ownership lifecycle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-handoff-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, 'Handoff 子智能体测试')
      const config = testRuntimeConfig()
      config.subAgents = [{
        agentId: 'specialist',
        name: '专属分析助手',
        role: 'specialist',
        summary: '接管专属分析问题',
        systemPrompt: '你是专属 handoff 子智能体。',
        model: null,
        tools: [],
        delegationMode: 'handoff',
        parallelSafe: false,
        maxTurns: 12,
        timeoutMs: 120_000,
      }]
      let rootRequests = 0
      let specialistRequests = 0
      const model = scriptedModel(request => {
        if (request.systemInstructions?.includes('专属 handoff 子智能体')) {
          specialistRequests += 1
          return { text: '专属分析已经完成。' }
        }
        rootRequests += 1
        return {
          toolCalls: [{
            id: 'call_handoff_specialist',
            name: 'handoff_to_specialist',
            arguments: JSON.stringify(subAgentArgs('完成专属分析', ['专属分析结论'])),
          }],
        }
      })
      const run = await store.createRun(session.id, '把这个问题交给专属分析助手', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })

      const completed = await testRuntime(store, new ToolRegistry(), registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id), runtimeConfig: config,
      })

      expect(completed.status, completed.state.errors.join('\n')).toBe('completed')
      expect(completed.state.errors).toEqual([])
      expect(rootRequests).toBe(1)
      expect(specialistRequests).toBe(1)
      // Handoff 在父 Runner 内继续执行，两次响应均只应由父
      // rawResponses 记录，不能进入 Agent-as-tool 的嵌套记录器。
      expect(completed.state.runtimeStats).toMatchObject({
        modelInputTokens: 2,
        modelOutputTokens: 2,
        modelTotalTokens: 4,
        modelUsageResponseCount: 2,
      })
      expect(completed.state.subAgents).toContainEqual(expect.objectContaining({
        agentId: 'specialist',
        status: 'completed',
        latestMessage: '专属分析已经完成。',
      }))
      const transcript = await store.activeTranscript(thread.id)
      expect(transcript).toContainEqual(expect.objectContaining({
        kind: 'tool_call',
        payload: expect.objectContaining({
          name: 'handoff_to_specialist',
          label: 'Handoff 转交',
          source: 'openai_agents_handoff',
        }),
      }))
      const events = await store.listEvents(run.id)
      expect(events.some(event => (
        event.type === 'subagent.updated'
        && event.payload.delegationMode === 'handoff'
        && event.payload.status === 'completed'
      ))).toBe(true)
    } finally {
      await removeTempRoot(root)
    }
  })

  it('restores handoff ownership before continuing an approved nested tool call', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-handoff-approval-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, 'Handoff 审批恢复')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['sensitive_tool']
      config.subAgents = [{
        agentId: 'sensitive_specialist',
        name: '敏感专属助手',
        role: 'specialist',
        summary: '接管并执行需要审批的操作',
        systemPrompt: '你是需要审批的 handoff 子智能体。',
        model: null,
        tools: ['sensitive_tool'],
        delegationMode: 'handoff',
        parallelSafe: false,
        maxTurns: 12,
        timeoutMs: 120_000,
      }]
      let executions = 0
      const tools = new ToolRegistry()
      tools.register(approvalProvider(() => { executions += 1 }))
      const model = scriptedModel(request => {
        if (request.systemInstructions?.includes('需要审批的 handoff 子智能体')) {
          return hasToolResultNamed(request, 'sensitive_tool')
            ? { text: 'Handoff 审批操作已经完成。' }
            : {
                toolCalls: [{
                  id: 'call_handoff_sensitive_tool',
                  name: 'sensitive_tool',
                  arguments: '{"value":1}',
                }],
              }
        }
        return {
          toolCalls: [{
            id: 'call_handoff_sensitive_specialist',
            name: 'handoff_to_sensitive_specialist',
            arguments: JSON.stringify(subAgentArgs(
              '执行需要审批的操作',
              ['审批后的完成结论'],
            )),
          }],
        }
      })
      const run = await store.createRun(session.id, '交给专属助手执行敏感操作', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const waiting = await testRuntime(
        store,
        tools,
        registryWith(fakeAdapter(model)),
      ).run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
      })
      const approval = waiting.state.approvals.find(item => (
        item.action === 'sensitive_tool' && item.status === 'pending'
      ))
      if (!approval) {
        throw new Error(`测试没有生成 Handoff 内部审批：${waiting.state.errors.join('\n')}`)
      }

      expect(waiting.status).toBe('waiting_approval')
      expect(executions).toBe(0)
      expect(waiting.state.subAgents).toContainEqual(expect.objectContaining({
        agentId: 'sensitive_specialist',
        status: 'running',
      }))

      // 新建 Runtime 模拟服务进程重启；所有权必须从平台投影与 SDK RunState 恢复。
      const completed = await testRuntime(
        store,
        tools,
        registryWith(fakeAdapter(model)),
      ).resolveApproval(run.id, approval.approvalId, true)

      expect(completed.state.errors, completed.state.errors.join('\n')).toEqual([])
      expect(completed.status).toBe('completed')
      expect(executions).toBe(1)
      expect(completed.state.subAgents).toContainEqual(expect.objectContaining({
        agentId: 'sensitive_specialist',
        status: 'completed',
        latestMessage: 'Handoff 审批操作已经完成。',
      }))
    } finally {
      await removeTempRoot(root)
    }
  })

  it('uses the SDK tool timeout and persists a timed-out subagent as failed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-subagent-timeout-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '子智能体超时测试')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['submit_agent_workflow', 'revise_agent_workflow']
      config.subAgents = [{
        agentId: 'slow_analyst',
        name: '慢速分析助手',
        role: 'analyst',
        summary: '测试子智能体超时边界',
        systemPrompt: '你是超时测试子智能体。',
        model: null,
        tools: [],
        delegationMode: 'as_tool',
        parallelSafe: false,
        maxTurns: 12,
        // 留出 SDK 首个 function_call 事件的调度时间；超时边界本身仍由
        // 子智能体配置控制，不能用过短的值把“尚未投影调用”误判成失败。
        timeoutMs: 250,
      }]
      const workflow = {
        goal: '验证子智能体超时不会无限阻塞主运行',
        steps: [{
          stepId: 'step_slow_agent',
          title: '调用慢速分析助手',
          kind: 'agent' as const,
          toolName: 'slow_analyst',
          ownerAgentId: 'slow_analyst',
          args: subAgentArgs('等待外部数据', ['等待结果']),
          reason: '验证超时和失败状态投影',
          dependsOn: [],
        }],
      }
      const rootModel = scriptedModel(request => hasToolResultNamed(request, 'submit_agent_workflow')
        ? { toolCalls: [{ id: 'call_slow_agent', name: 'slow_analyst', arguments: JSON.stringify(subAgentArgs('等待外部数据', ['等待结果'])) }] }
        : {
            toolCalls: [{
              id: 'call_slow_plan',
              name: 'submit_agent_workflow',
              arguments: JSON.stringify({ workflow }),
            }],
          })
      const model: Model = {
        getResponse: request => request.systemInstructions?.includes('超时测试子智能体')
          ? rejectWhenAborted(request.signal)
          : rootModel.getResponse(request),
        async *getStreamedResponse(request) {
          if (request.systemInstructions?.includes('超时测试子智能体')) {
            await rejectWhenAborted(request.signal)
            return
          }
          yield* rootModel.getStreamedResponse(request)
        },
      }
      const tools = new ToolRegistry()
      tools.register(planProvider)
      const run = await store.createRun(session.id, '请验证子智能体超时', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const liveItems: ConversationItem[] = []
      testPlatformEventHub(store).conversationItems.subscribe(run.id, item => liveItems.push(item))
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({
        ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan',
      })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成智能体工作流审批。')

      const failed = await runtime.resolveApproval(run.id, approval.approvalId, true)

      expect(failed.status).toBe('failed')
      expect(failed.state.errors.join('\n')).toContain('慢速分析助手超过单次调用时限 250ms，已停止。')
      expect(failed.state.subAgents).toContainEqual(expect.objectContaining({
        agentId: 'slow_analyst',
        status: 'failed',
        currentStepId: null,
        latestMessage: '慢速分析助手超过单次调用时限 250ms，已停止。',
      }))
      expect(failed.state.agentWorkflow).toMatchObject({
        status: 'adjusting',
        steps: [expect.objectContaining({ stepId: 'step_slow_agent', status: 'failed' })],
      })
      const subAgentCallUpdates = liveItems.filter(item => (
        item.itemType === 'function_call' && item.name === 'slow_analyst'
      ))
      expect(subAgentCallUpdates.map(item => item.status)).toEqual(['running', 'failed'])
    } finally {
      await removeTempRoot(root)
    }
  })

  it('uses the SDK maxTurns boundary to stop a looping subagent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-subagent-max-turns-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '子 Agent 轮次上限测试')
      const config = testRuntimeConfig()
      config.supervisor.approvalInterruptTools = ['submit_agent_workflow', 'revise_agent_workflow']
      config.subAgents = [{
        agentId: 'looping_analyst',
        name: '循环分析助手',
        role: 'analyst',
        summary: '测试子智能体轮次硬边界',
        systemPrompt: '你是轮次上限测试子智能体。',
        model: null,
        tools: ['query_layer'],
        delegationMode: 'as_tool',
        parallelSafe: false,
        maxTurns: 2,
        timeoutMs: 120_000,
      }]
      const tools = new ToolRegistry()
      tools.register(planProvider)
      let queryCalls = 0
      tools.register(providerFromTools('subagent-max-turn-tools', [{
        ...toolDefinition('query_layer', ['query']),
        handler: async () => {
          queryCalls += 1
          return result('query', [], { rows: [] })
        },
      }]))
      const workflow = {
        goal: '验证循环子智能体会被 SDK 轮次边界停止',
        steps: [{
          stepId: 'step_looping_agent',
          title: '调用循环分析助手',
          kind: 'agent' as const,
          toolName: 'looping_analyst',
          ownerAgentId: 'looping_analyst',
          args: subAgentArgs('持续查询', ['查询结论']),
          reason: '验证最大运行轮次边界',
          dependsOn: [],
        }],
      }
      let subAgentCallId = 0
      const model = scriptedModel(request => {
        if (request.systemInstructions?.includes('轮次上限测试子智能体')) {
          subAgentCallId += 1
          return {
            toolCalls: [{
              id: `looping_query_${subAgentCallId}`,
              name: 'query_layer',
              arguments: '{"query":"继续查询"}',
            }],
          }
        }
        if (hasToolResultNamed(request, 'submit_agent_workflow')) {
          return { toolCalls: [{ id: 'call_looping_agent', name: 'looping_analyst', arguments: JSON.stringify(subAgentArgs('持续查询', ['查询结论'])) }] }
        }
        return {
          toolCalls: [{
            id: 'call_looping_plan',
            name: 'submit_agent_workflow',
            arguments: JSON.stringify({ workflow }),
          }],
        }
      })
      const run = await store.createRun(session.id, '请验证子智能体轮次边界', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const runtime = testRuntime(store, tools, registryWith(fakeAdapter(model)))
      const waiting = await runtime.run({
        ...runOptions(run, thread.id), runtimeConfig: config, executionMode: 'plan',
      })
      const approval = waiting.state.approvals[0]
      if (!approval) throw new Error('测试没有生成智能体工作流审批。')

      const failed = await runtime.resolveApproval(run.id, approval.approvalId, true)

      expect(failed.status).toBe('failed')
      expect(queryCalls).toBe(2)
      expect(failed.state.errors.join('\n')).toContain('循环分析助手已达到最大运行轮次 2，为避免循环调用已停止。')
      expect(failed.state.subAgents).toContainEqual(expect.objectContaining({
        agentId: 'looping_analyst',
        status: 'failed',
        currentStepId: null,
        latestMessage: '循环分析助手已达到最大运行轮次 2，为避免循环调用已停止。',
      }))
      expect(failed.state.agentWorkflow).toMatchObject({
        status: 'adjusting',
        steps: [expect.objectContaining({ stepId: 'step_looping_agent', status: 'failed' })],
      })
    } finally {
      await removeTempRoot(root)
    }
  })

  it('restores previous run valueRefs for continuous thread tool calls', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-thread-values-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '连续 valueRef 测试')
      const tools = new ToolRegistry()
      tools.register(providerFromTools('thread-value-test', [{
        ...toolDefinition('use_dataset_ref', ['dataset_ref']),
        jsonSchema: {
          type: 'object',
          properties: {
            dataset_ref: {
              type: 'string',
              description: '必须使用 valueRef ID',
              'x-source': 'value_ref',
              'x-value-ref-kinds': ['meteorological_dataset'],
            },
          },
          required: ['dataset_ref'],
        },
        handler: async (_args, context) => {
          const ref = context.resolveValueRef('ref_prior_dataset')
          return result('reuse', [], { reusedKind: ref.kind })
        },
      }]))
      const firstRun = await store.createRun(session.id, '先检查数据', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      await store.updateRunState(firstRun.id, {
        toolValueRefs: [{
          refId: 'ref_prior_dataset',
          kind: 'meteorological_dataset',
          label: '上一轮数据集',
          value: { name: 'rain.nc', relativePath: 'objects/sha256/aa/rain.nc' },
          metadata: {},
          sourceTool: 'meteorological_inspect',
          sourceResultId: 'result_prior',
          createdAt: new Date().toISOString(),
          unit: null,
        }],
      })
      await store.completeRun(firstRun.id, 'completed')
      const secondRun = await store.createRun(session.id, '继续使用上一轮数据集', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: testRuntimeConfig(),
      })
      let turns = 0
      const model = scriptedModel(request => {
        turns += 1
        if (hasToolResult(request)) return { text: '已经复用上一轮数据集。' }
        return { toolCalls: [{ id: 'call_reuse', name: 'use_dataset_ref', arguments: '{"dataset_ref":"ref_prior_dataset"}' }] }
      })

      const completed = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run(runOptions(secondRun, thread.id))

      expect(completed.status).toBe('completed')
      expect(turns).toBe(2)
      expect(completed.state.toolResults[0]).toMatchObject({
        tool: 'use_dataset_ref',
        status: 'completed',
      })
    } finally {
      await removeTempRoot(root)
    }
  })

  it('omits disabled developer tools from supervisor and subagent assembly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-no-developer-tools-'))
    try {
      const store = createTestPersistenceFacade(root)
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '地理分析不装配开发工具')
      const config = testRuntimeConfig()
      config.subAgents = [{
        agentId: 'maintenance_assistant',
        name: '维护助手',
        role: 'maintenance',
        summary: '仅用于验证工具装配边界。',
        systemPrompt: '测试。',
        model: null,
        tools: ['read_file'],
        delegationMode: 'as_tool',
        parallelSafe: false,
        maxTurns: 2,
        timeoutMs: 5_000,
      }]
      const run = await store.createRun(session.id, '回答一个 GIS 问题', {
        threadId: thread.id,
        modelProvider: 'fake',
        runtimeConfigSnapshot: config,
      })
      const tools = new ToolRegistry()
      tools.register(providerFromTools('geo-platform-developer-tools', [{
        name: 'read_file',
        label: '读取文件',
        description: '开发者文件读取。',
        prompt: '仅在维护模式使用。',
        group: '开发工具',
        tags: ['developer'],
        isReadOnly: true,
        isDestructive: false,
        jsonSchema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
        handler: async () => result('read_file', [], {}),
      }]))
      let exposedToolNames: string[] = []
      const model = scriptedModel(request => {
        exposedToolNames = request.tools.map(tool => tool.name)
        return { text: 'GIS 运行未装配开发者工具。' }
      })

      const completed = await testRuntime(store, tools, registryWith(fakeAdapter(model))).run({
        ...runOptions(run, thread.id),
        runtimeConfig: config,
      })

      expect(completed.status).toBe('completed')
      expect(exposedToolNames).not.toContain('read_file')
      expect(completed.state.subAgents[0]?.tools).toEqual([])
    } finally {
      await removeTempRoot(root)
    }
  })

})

interface ScriptedResponse {
  text?: string
  reasoning?: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  usage?: {
    requests: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
    inputTokensDetails?: Record<string, number>
  }
}

function scriptedModel(script: (request: ModelRequest) => ScriptedResponse): Model {
  return {
    getRetryAdvice: ({ error }) => error instanceof ReplaySafeTestError
      ? { suggested: true, replaySafety: 'safe', normalized: { isNetworkError: true } }
      : undefined,
    async getResponse(request): Promise<ModelResponse> {
      const response = structuredResponse(script(request), request)
      return {
        usage: new Usage(response.usage),
        output: outputItems(response, makeIdForResponse()),
        responseId: makeIdForResponse(),
      }
    },
    async *getStreamedResponse(request): AsyncIterable<ResponseStreamEvent> {
      const response = structuredResponse(script(request), request)
      const responseId = makeIdForResponse()
      yield { type: 'response_started' }
      if (response.reasoning) {
        yield {
          type: 'model',
          event: { choices: [{ index: 0, delta: { reasoning_content: response.reasoning } }] },
        }
      }
      if (response.text) yield { type: 'output_text_delta', delta: response.text }
      yield {
        type: 'response_done',
        response: {
          id: responseId,
          usage: response.usage
            ?? { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: outputItems(response, responseId),
        },
      }
    },
  }
}

class ReplaySafeTestError extends Error {}

function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) {
      reject(new Error('子智能体模型请求缺少 SDK abort signal'))
      return
    }
    const rejectAbort = () => reject(signal.reason instanceof Error
      ? signal.reason
      : new Error('子智能体模型请求已中止'))
    if (signal.aborted) {
      rejectAbort()
      return
    }
    signal.addEventListener('abort', rejectAbort, { once: true })
  })
}

let responseSequence = 0
function makeIdForResponse(): string {
  responseSequence += 1
  return `response_${responseSequence}`
}

function outputItems(response: ScriptedResponse, responseId: string): AgentOutputItem[] {
  const output: AgentOutputItem[] = []
  if (response.reasoning) output.push({ type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: response.reasoning }] })
  if (response.text) {
    output.push({
      id: responseId, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: response.text }],
    })
  }
  for (const call of response.toolCalls ?? []) {
    output.push({
      id: responseId, type: 'function_call', status: 'completed',
      callId: call.id, name: call.name, arguments: call.arguments,
    })
  }
  return output
}

function structuredResponse(response: ScriptedResponse, request: ModelRequest): ScriptedResponse {
  const normalized = withStrictWorkflowStepIdentity(response, request)
  if (!normalized.text || normalized.toolCalls?.length || request.outputType === 'text') return normalized
  const properties = request.outputType.schema.properties
  if ('markdown' in properties) {
    return {
      ...normalized,
      text: JSON.stringify({ markdown: normalized.text, summary: normalized.text, artifactIds: [], warnings: [] }),
    }
  }
  if ('evidence' in properties) {
    return {
      ...normalized,
      text: JSON.stringify({ status: 'completed', summary: normalized.text, evidence: [], artifactIds: [], warnings: [], error: null }),
    }
  }
  return normalized
}

function withStrictWorkflowStepIdentity(response: ScriptedResponse, request: ModelRequest): ScriptedResponse {
  if (!response.toolCalls?.length) return response
  return {
    ...response,
    toolCalls: response.toolCalls.map(call => {
      const definition = request.tools.find(tool => tool.name === call.name)
      const properties = definition && isRecord(definition.parameters)
        && isRecord(definition.parameters.properties)
        ? definition.parameters.properties
        : {}
      if (!('workflowStepId' in properties)) return call
      const parsed: unknown = JSON.parse(call.arguments)
      if (!isRecord(parsed) || 'workflowStepId' in parsed) return call
      return { ...call, arguments: JSON.stringify({ ...parsed, workflowStepId: null }) }
    }),
  }
}

async function executeTextRun(
  model: Model,
  tools = new ToolRegistry(),
  query = '回答测试问题',
  hostedTools = false,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-runtime-stream-'))
  try {
    const store = createTestPersistenceFacade(root)
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '模型流测试')
    const run = await store.createRun(session.id, query, {
      threadId: thread.id,
      modelProvider: 'fake',
      runtimeConfigSnapshot: testRuntimeConfig(),
    })
    const liveItems: ConversationItem[] = []
    const liveItemDeltas: ConversationItemTextDelta[] = []
    const eventHub = testPlatformEventHub(store)
    eventHub.conversationItems.subscribe(run.id, item => liveItems.push(structuredClone(item)))
    eventHub.conversationItemDeltas.subscribe(
      run.id,
      delta => liveItemDeltas.push(structuredClone(delta)),
    )
    const completed = await testRuntime(
      store,
      tools,
      registryWith(fakeAdapter(model, 'strict', hostedTools)),
    ).run(runOptions(run, thread.id))
    await store.flushConversationStore()
    return {
      run: structuredClone(completed),
      items: structuredClone(await store.listItems(run.id)),
      liveItems,
      liveItemDeltas,
      transcript: structuredClone(await store.activeTranscript(thread.id)),
    }
  } finally {
    await removeTempRoot(root)
  }
}

function fakeAdapter(
  model: Model,
  agentToolSchemaMode: ModelAdapter['agentToolSchemaMode'] = 'strict',
  hostedTools = false,
): ModelAdapter {
  return {
    provider: 'fake',
    displayName: 'Fake',
    defaultModel: 'fake-model',
    contextWindowTokens: 128_000,
    agentToolSchemaMode,
    agentRuntimeCapabilities: {
      structuredOutput: 'json_schema',
      functionTools: true,
      localMcp: true,
      hostedTools,
      handoffs: true,
      remoteConversation: false,
      serverCompaction: false,
    },
    isConfigured: () => true,
    capabilities: () => ['chat', 'stream'],
    createAgentModel: () => model,
    chat: async () => ({ content: '{}' }),
  }
}

function registryWith(adapter: ModelAdapter): ModelAdapterRegistry {
  const registry = new ModelAdapterRegistry(testEnv())
  registry.register(adapter)
  return registry
}

function runOptions(run: { id: string; sessionId: string; userQuery: string }, threadId: string) {
  return {
    runId: run.id,
    threadId,
    sessionId: run.sessionId,
    query: run.userQuery,
    provider: 'fake',
    runtimeConfig: testRuntimeConfig(),
  }
}

function requestTexts(request: ModelRequest): string[] {
  if (typeof request.input === 'string') return [request.input]
  return request.input.flatMap(item => {
    if (!('role' in item)) return []
    if (typeof item.content === 'string') return [item.content]
    return item.content.flatMap(part => 'text' in part && typeof part.text === 'string' ? [part.text] : [])
  })
}

function hasToolResult(request: ModelRequest): boolean {
  return Array.isArray(request.input) && request.input.some(item => item.type === 'function_call_result')
}

function hasToolResultNamed(request: ModelRequest, name: string): boolean {
  return Array.isArray(request.input) && request.input.some(item => (
    item.type === 'function_call_result'
    && isRecord(item)
    && item.name === name
  ))
}

function subAgentArgs(objective: string, expectedDeliverables: string[]) {
  return { objective, expectedDeliverables, contextRefs: [], constraints: [] }
}

function approvalProvider(onExecute: () => void): ToolProvider {
  const definition = toolDefinition('sensitive_tool', ['value'])
  return providerFromTools('approval-test-provider', [{
    ...definition,
    jsonSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    handler: async () => {
      onExecute()
      return result('sensitive', [], { ok: true })
    },
  }])
}

function directResponseProvider(): ToolProvider {
  const definition = toolDefinition('deliver_test_response', ['question'])
  return providerFromTools('nowcast-answer-test', [{
    ...definition,
    agentResultMode: 'return_direct',
    handler: async () => ({
      ...result('answer', [], { answer: '预报时段内未检出达到有效阈值的降雨。' }),
      modelOutput: '预报时段内未检出达到有效阈值的降雨。',
    }),
  }])
}

function toolDefinition(name: string, required: string[]): Omit<ToolDef, 'handler'> {
  const labels: Record<string, string> = {
    sensitive_tool: '执行敏感操作',
    write_layer: '写入图层',
    deliver_test_response: '交付测试回答',
    lookup_context: '查询上下文',
    query_layer: '查询图层',
    use_dataset_ref: '使用数据集引用',
    list_meteorological_files: '列出气象文件',
    create_nowcast_sequence: '创建短时临近预报序列',
    meteorological_precipitation_nowcast: '分析短时临近预报降水',
    parallel_a: '并行检查数据甲',
    parallel_b: '并行检查数据乙',
    unstable_inspect: '检查主数据源',
    verified_recovery: '验证恢复数据',
    collect_guidance_data: '采集引导测试数据',
    build_guidance_table: '生成引导测试表格',
    query_public_weather: '查询公开天气',
  }
  const label = labels[name]
  if (!label) throw new Error(`测试工具 '${name}' 缺少中文展示名称`)
  return {
    name,
    label,
    description: `${name} test tool`,
    prompt: `用于测试 ${name} 工具调用边界。`,
    group: '测试',
    tags: ['test'],
    isReadOnly: true,
    isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: Object.fromEntries(required.map(key => [key, { type: 'string' }])),
      required,
    },
  }
}

function phaseTool(name: string, executed: string[]): ToolDef {
  return {
    ...toolDefinition(name, []),
    handler: async () => {
      executed.push(name)
      return result(name, [], { verified: true })
    },
  }
}

function workflowStep(stepId: string, title: string, toolName: string, dependsOn: string[] = []) {
  return {
    stepId,
    title,
    kind: 'tool' as const,
    toolName,
    ownerAgentId: 'supervisor',
    args: {},
    reason: title,
    dependsOn,
  }
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let complete!: () => void
  const promise = new Promise<void>(resolve => {
    complete = resolve
  })
  return { promise, resolve: complete }
}

function providerFromTools(id: string, tools: ToolDef[]): ToolProvider {
  return {
    manifest: {
      id, name: id, version: '1.0.0', author: 'test', language: 'typescript', description: id,
      tools: tools.map(({ handler: _handler, ...definition }) => definition),
    },
    tools: () => tools,
  }
}

function result(name: string, valueRefs: ValueRef[], payload: Record<string, unknown> = {}): ToolResult {
  return {
    message: `${name} completed`, payload, warnings: [], resultId: `result_${name}`, source: 'test', valueRefs,
  }
}

function testEnv(): Env {
  return {
    API_HOST: '127.0.0.1', API_PORT: 0, DATABASE_URL: 'postgres://unused',
    RUNTIME_ROOT: 'runtime', ENABLED_TOOL_PROVIDERS: '',
  }
}

function testRuntimeConfig() {
  const config = defaultRuntimeConfig()
  config.subAgents = []
  return config
}

function testGoalInput(overrides: Partial<RunGoalInput> = {}): RunGoalInput {
  return {
    condition: '工具执行结果与最终结论必须共同满足目标。',
    acceptanceCriteria: ['存在可复核的客观证据', '最终回答覆盖目标条件'],
    maxRechecks: 2,
    deadlineAt: null,
    maxTokenBudget: null,
    ...overrides,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function modelRequestRunnerManagedRetry(request: ModelRequest): boolean {
  const candidate: unknown = request
  return isRecord(candidate)
    && isRecord(candidate._internal)
    && candidate._internal.runnerManagedRetry === true
}

function modelRequestInternalValue(request: ModelRequest, key: string): unknown {
  const candidate: unknown = request
  return isRecord(candidate) && isRecord(candidate._internal)
    ? candidate._internal[key]
    : undefined
}

function modelRequestWithoutTransientControls(request: ModelRequest): string {
  const { signal: _signal, ...persistedRequest } = request
  const normalized: unknown = structuredClone(persistedRequest)
  if (isRecord(normalized) && isRecord(normalized._internal)) {
    delete normalized._internal.runnerManagedRetry
    delete normalized._internal.tracingParent
    if (Object.keys(normalized._internal).length === 0) delete normalized._internal
  }
  return JSON.stringify(normalized)
}

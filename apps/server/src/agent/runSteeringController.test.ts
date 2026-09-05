// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行引导控制器测试
//
//   文件:       runSteeringController.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_STEP_CONTEXT_SCHEMA_VERSION } from '@geo-agent-platform/shared-types/agent-step-context'
import { MODEL_REQUEST_RECORD_SCHEMA_VERSION } from '@geo-agent-platform/shared-types/model-request'

import { PersistenceFacadeTestHarness } from '../../test-support/persistenceFacadeHarness.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import {
  completeAgentWorkflowStep,
  createAgentWorkflow,
  startAgentWorkflowStep,
} from './agentWorkflowState.js'
import { RunSteeringController } from './runSteeringController.js'

describe('RunSteeringController', () => {
  it('queues idempotently, leases in sequence, and only advances the cursor with the SDK checkpoint', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-steering-'))
    const store = new PersistenceFacadeTestHarness().create(root)
    try {
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '运行中引导')
      const run = await store.createRun(session.id, '先分析数据', { threadId: thread.id })
      await establishRunTurn(store, thread.id, run.id, 'sequence')
      await store.updateRunStatus(run.id, 'running')
      const controller = new RunSteeringController(store)

      await controller.open(run.id)
      const first = await controller.enqueue(run.id, 'steer_1', '重点检查最近三十分钟')
      const retry = await controller.enqueue(run.id, 'steer_1', '重点检查最近三十分钟')
      expect(retry).toEqual(first)
      expect((await store.listRunInputs(run.id))).toHaveLength(1)

      const delivery = await controller.consumePendingWithRevision(run.id)
      expect(delivery.items).toEqual([{
        type: 'message',
        role: 'user',
        content: '重点检查最近三十分钟',
        providerData: {
          geoAgentRunInput: {
            runId: run.id,
            inputId: first.steeringId,
            inputSequence: 1,
          },
        },
      }])
      expect(delivery).toMatchObject({ objectiveRevision: 2 })
      expect(delivery.leaseId).toBeTruthy()
      expect((await store.listRunInputs(run.id))[0]?.status).toBe('leased')

      await expect(store.saveAgentsSdkCheckpointEnvelope(run.id, '{"unsafe":"checkpoint"}', {
        agentsSdkVersion: 'test-sdk',
        runtimeConfigDigest: 'test-runtime',
      })).rejects.toThrow(/input|lease/u)
      await includeActiveLeaseInModelRequest(store, run.id, 'first')
      expect((await controller.modelInputRevisionSnapshot(run.id))).toMatchObject({
        objectiveRevision: 2,
        inputCursor: 1,
        state: null,
      })
      const acked = await store.saveAgentsSdkCheckpointEnvelope(run.id, '{"response":"durable"}', {
        agentsSdkVersion: 'test-sdk',
        runtimeConfigDigest: 'test-runtime',
        inputLeaseId: delivery.leaseId,
      })
      await controller.recordCheckpointedInputs(run.id, acked)
      expect((await store.listRunInputs(run.id))[0]?.status).toBe('checkpointed')
      expect((await controller.modelInputRevisionSnapshot(run.id))).toMatchObject({
        objectiveRevision: 2,
        inputCursor: 1,
        state: { objectiveRevision: 2 },
      })
      expect((await store.activeTranscript(thread.id)).at(-1)?.payload.content).toBe('重点检查最近三十分钟')
      const steeringItem = (await store.listItems(run.id)).find(item => item.itemId === first.itemId)
      expect(steeringItem?.metadata).toMatchObject({
        steeringId: first.steeringId,
        transcriptEntryId: first.entryId,
      })
      expect(steeringItem?.metadata).not.toHaveProperty('steeringEntryId')

      await controller.close(run.id)
      await expect(controller.enqueue(run.id, 'steer_1', '重点检查最近三十分钟'))
        .resolves.toMatchObject({ steeringId: 'steer_1', status: 'checkpointed' })
      await expect(controller.enqueue(run.id, 'steer_2', '再检查空间范围'))
        .rejects.toThrow('已结束接收引导消息')
    } finally {
      await store.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses steeringId as the idempotency key and never deduplicates distinct inputs by text', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-steering-identity-'))
    const store = new PersistenceFacadeTestHarness().create(root)
    try {
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '运行输入身份')
      const run = await store.createRun(session.id, '保留相同文本的独立输入', { threadId: thread.id })
      await establishRunTurn(store, thread.id, run.id, 'identity')
      await store.updateRunStatus(run.id, 'running')
      const controller = new RunSteeringController(store)
      await controller.open(run.id)

      const first = await controller.enqueue(run.id, 'steer_same_1', '请检查相同范围')
      const second = await controller.enqueue(run.id, 'steer_same_2', '请检查相同范围')
      expect(first.inputSequence).toBe(1)
      expect(second.inputSequence).toBe(2)
      await expect(controller.enqueue(run.id, 'steer_same_1', '篡改后的不同内容'))
        .rejects.toThrow(/内容.*不一致|幂等键.*其它内容/u)

      const delivery = await controller.consumePendingWithRevision(run.id)
      expect(delivery.objectiveRevision).toBe(3)
      expect(delivery.items).toEqual([
        expect.objectContaining({ role: 'user', content: '请检查相同范围' }),
        expect.objectContaining({ role: 'user', content: '请检查相同范围' }),
      ])
      expect((await store.listRunInputs(run.id)).map(record => ({
        steeringId: record.steeringId,
        inputSequence: record.inputSequence,
        status: record.status,
      }))).toEqual([
        { steeringId: first.steeringId, inputSequence: 1, status: 'leased' },
        { steeringId: second.steeringId, inputSequence: 2, status: 'leased' },
      ])

      await includeActiveLeaseInModelRequest(store, run.id, 'same-text')
      const activeRequest = await store.getActiveModelRequest(run.id)
      expect(activeRequest?.inputEntryIds).toEqual([first.entryId, second.entryId])
      const checkpointed = await store.saveAgentsSdkCheckpointEnvelope(run.id, '{"response":"same-text"}', {
        agentsSdkVersion: 'test-sdk',
        runtimeConfigDigest: 'test-runtime',
        inputLeaseId: delivery.leaseId,
      })
      await controller.recordCheckpointedInputs(run.id, checkpointed)
      expect((await store.listRunInputs(run.id)).map(record => record.status))
        .toEqual(['checkpointed', 'checkpointed'])
      expect((await store.activeTranscript(thread.id)).filter(entry => (
        entry.kind === 'message'
        && entry.payload.role === 'user'
        && entry.payload.content === '请检查相同范围'
      ))).toHaveLength(2)
      await controller.close(run.id)
    } finally {
      await store.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('advances one durable objective revision per unique input and invalidates completed workflow evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-steering-revision-'))
    const store = new PersistenceFacadeTestHarness().create(root)
    try {
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '运行输入 revision')
      const run = await store.createRun(session.id, '先完成旧目标', {
        threadId: thread.id,
        goal: {
          condition: '交付当前输入对应的结论',
          acceptanceCriteria: ['结论覆盖当前输入'],
          maxRechecks: 2,
          deadlineAt: null,
          maxTokenBudget: null,
        },
      })
      await establishRunTurn(store, thread.id, run.id, 'revision')
      const draft = {
        goal: '交付旧输入结论',
        steps: [{
          stepId: 'deliver',
          title: '交付结论',
          kind: 'delivery' as const,
          phase: 'deliver' as const,
          toolName: 'deliver_result',
          ownerAgentId: 'supervisor',
          args: {},
          reason: '完成旧输入',
          dependsOn: [],
        }],
      }
      const runningWorkflow = startAgentWorkflowStep(
        createAgentWorkflow(draft, 1),
        { stepId: 'deliver' },
      )
      const completedWorkflow = completeAgentWorkflowStep(
        runningWorkflow,
        { stepId: 'deliver', resultSummary: '旧输入已完成' },
      )
      await store.updateRunState(run.id, {
        agentWorkflow: completedWorkflow,
        goal: run.state.goal && {
          ...run.state.goal,
          status: 'satisfied',
          lastVerdict: {
            status: 'satisfied',
            reason: '旧输入已满足',
            evidence: [{ source: 'workflow', referenceId: completedWorkflow.agentWorkflowId, statement: '旧工作流完成' }],
            missingCriteria: [],
            attempt: 1,
            evaluatedAt: new Date().toISOString(),
            tokenUsage: 1,
          },
        },
      })
      await store.updateRunStatus(run.id, 'running')
      const controller = new RunSteeringController(store)
      await controller.open(run.id)

      await controller.enqueue(run.id, 'steer_revision', '新增核验范围')
      await controller.enqueue(run.id, 'steer_revision', '新增核验范围')

      const advanced = store.getRun(run.id).state
      expect(advanced.objectiveRevision).toBe(2)
      expect(advanced.goal).toMatchObject({
        objectiveRevision: 2,
        status: 'active',
        recheckCount: 0,
        lastVerdict: null,
        completedAt: null,
      })
      expect(advanced.agentWorkflow).toMatchObject({
        objectiveRevision: 2,
        revision: 1,
        status: 'adjusting',
        completedAt: null,
      })

      let staleCommitRan = false
      expect(await controller.commitRevision(run.id, 1, async () => {
        staleCommitRan = true
      })).toBe(false)
      expect(staleCommitRan).toBe(false)
      expect(await controller.tryClaimTerminal(run.id, {
        objectiveRevision: 1,
        inputCursor: 0,
      })).toBe(false)

      const delivery = await controller.consumePendingWithRevision(run.id)
      await includeActiveLeaseInModelRequest(store, run.id, 'revision')
      const acked = await store.saveAgentsSdkCheckpointEnvelope(run.id, '{"response":"revision-2"}', {
        agentsSdkVersion: 'test-sdk',
        runtimeConfigDigest: 'test-runtime',
        inputLeaseId: delivery.leaseId,
      })
      await controller.recordCheckpointedInputs(run.id, acked)
      expect(await controller.stateForRevision(run.id, 2)).toMatchObject({ objectiveRevision: 2 })
      expect(await controller.tryClaimTerminal(run.id, {
        objectiveRevision: 2,
        inputCursor: 1,
      })).toBe(true)
      expect(await store.getRunCheckpoint(run.id)).toMatchObject({
        terminalObjectiveRevision: 2,
      })
      await expect(controller.enqueue(run.id, 'steer_after_claim', '终态 flush 期间的新输入'))
        .rejects.toThrow('已结束接收引导消息')
      await controller.close(run.id)
      const reopened = new RunSteeringController(store)
      await reopened.open(run.id)
      await expect(reopened.tryClaimTerminal(run.id, {
        objectiveRevision: 2,
        inputCursor: 1,
      })).resolves.toBe(true)
      await expect(reopened.tryClaimTerminal(run.id, {
        objectiveRevision: 1,
        inputCursor: 0,
      })).resolves.toBe(false)
      await expect(reopened.enqueue(run.id, 'steer_after_restart', '重启后的新输入'))
        .rejects.toThrow('已结束接收引导消息')
      await reopened.close(run.id)
    } finally {
      await store.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('replays an uncheckpointed lease only after explicit recovery ownership and preserves later queued input', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-steering-recovery-'))
    const harness = new PersistenceFacadeTestHarness()
    const store = harness.create(root)
    try {
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '运行输入恢复')
      const run = await store.createRun(session.id, '先租约再模拟崩溃', { threadId: thread.id })
      await establishRunTurn(store, thread.id, run.id, 'recovery')
      await store.updateRunStatus(run.id, 'running')

      const firstController = new RunSteeringController(store)
      await firstController.open(run.id)
      const first = await firstController.enqueue(run.id, 'steer_crash_1', '未进入 checkpoint 的输入')
      const firstDelivery = await firstController.consumePendingWithRevision(run.id)
      expect(firstDelivery.leaseId).toBeTruthy()
      expect((await store.getRunCheckpoint(run.id))).toMatchObject({
        checkpointInputCursor: 0,
        activeInputLeaseId: firstDelivery.leaseId,
        activeInputLeaseFrom: 1,
        activeInputLeaseTo: 1,
      })

      const second = await firstController.enqueue(run.id, 'steer_crash_2', '租约后并发入队')
      expect(second.inputSequence).toBe(2)
      await firstController.close(run.id)

      const recoveredController = new RunSteeringController(store)
      await expect(recoveredController.open(run.id)).rejects.toThrow(/普通 open 不得窃取恢复权/u)
      await recoveredController.open(run.id, { recoverLeased: true })
      const recoveredRecords = await store.listRunInputs(run.id)
      expect(recoveredRecords.map(record => ({
        steeringId: record.steeringId,
        inputSequence: record.inputSequence,
        status: record.status,
      }))).toEqual([
        { steeringId: first.steeringId, inputSequence: 1, status: 'queued' },
        { steeringId: second.steeringId, inputSequence: 2, status: 'queued' },
      ])

      const replay = await recoveredController.consumePendingWithRevision(run.id)
      expect(replay.leaseId).not.toBe(firstDelivery.leaseId)
      expect(replay.items.map(item => 'content' in item ? item.content : null)).toEqual([
        '未进入 checkpoint 的输入',
        '租约后并发入队',
      ])
      expect(replay.objectiveRevision).toBe(3)
      const idempotentLease = await store.leaseRunInputs(run.id, replay.leaseId!)
      expect(idempotentLease.map(record => record.inputSequence)).toEqual([1, 2])

      await includeActiveLeaseInModelRequest(store, run.id, 'replay')
      const acked = await store.saveAgentsSdkCheckpointEnvelope(run.id, '{"response":"replayed"}', {
        agentsSdkVersion: 'test-sdk',
        runtimeConfigDigest: 'test-runtime',
        inputLeaseId: replay.leaseId,
      })
      // 模拟 DB 事务已提交、但 item 投影前进程崩溃。新恢复所有者
      // 必须保留 checkpointed 事实，不能再次交付该输入。
      await recoveredController.close(run.id)
      await store.flushConversationStore()
      // 共用结构化持久化替身，但创建全新 Facade/RunStore，丢弃旧进程的
      // item stream、controller 和 acknowledgement 局部数组。
      const restoredStore = harness.create(root)
      await restoredStore.initialize()
      await restoredStore.updateRunStatus(run.id, 'running')
      expect((await restoredStore.listItems(run.id)).filter(item => (
        item.itemId === first.itemId || item.itemId === second.itemId
      )).map(item => item.status)).toEqual(['checkpointed', 'checkpointed'])
      const postAckRecovery = new RunSteeringController(restoredStore)
      await postAckRecovery.open(run.id, { recoverLeased: true })
      expect((await restoredStore.listRunInputs(run.id)).map(record => record.status)).toEqual([
        'checkpointed',
        'checkpointed',
      ])
      expect((await restoredStore.getRunCheckpoint(run.id))).toMatchObject({
        nextInputSequence: 3,
        checkpointInputCursor: 2,
        activeInputLeaseId: null,
      })
      expect(await postAckRecovery.stateForRevision(run.id, 3)).toMatchObject({ objectiveRevision: 3 })

      await expect(restoredStore.saveAgentsSdkCheckpointEnvelope(run.id, '{"response":"replayed"}', {
        agentsSdkVersion: 'test-sdk',
        runtimeConfigDigest: 'test-runtime',
        inputLeaseId: replay.leaseId,
      })).resolves.toHaveLength(2)

      await expect(restoredStore.saveAgentsSdkCheckpointEnvelope(run.id, '{"response":"stale-overwrite"}', {
        agentsSdkVersion: 'test-sdk',
        runtimeConfigDigest: 'test-runtime',
        inputLeaseId: replay.leaseId,
      })).rejects.toThrow(/不能覆盖更新/u)
      await postAckRecovery.close(run.id)
    } finally {
      await store.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function includeActiveLeaseInModelRequest(
  store: PlatformPersistenceFacade,
  runId: string,
  suffix: string,
): Promise<void> {
  const digest = `sha256:${'1'.repeat(64)}`
  const inputs = await store.listRunInputs(runId)
  const checkpoint = await store.getRunCheckpoint(runId)
  const turnId = inputs.find(record => record.status === 'leased')?.turnId
  if (!turnId) throw new Error(`测试运行 '${runId}' 缺少已租约输入的 turnId`)
  const inputCursor = checkpoint.activeInputLeaseTo ?? checkpoint.checkpointInputCursor
  await store.publishModelRequestSnapshot('{"input":[]}', {
    schemaVersion: MODEL_REQUEST_RECORD_SCHEMA_VERSION,
    requestId: `model_request_${suffix}`,
    runId,
    turnId,
    stepId: `step_${suffix}`,
    segmentId: `segment_${suffix}`,
    objectiveRevision: store.getRun(runId).state.objectiveRevision,
    inputCursor,
    contextWindowId: `context_window_${suffix}`,
    contextDigest: digest,
    agentStepContextSchemaVersion: AGENT_STEP_CONTEXT_SCHEMA_VERSION,
    provider: 'test',
    modelId: 'test-model',
    inputDigest: digest,
    instructionsDigest: digest,
    toolPlanDigest: digest,
    worldRevision: 1,
    summaryObjectHashes: [],
    createdAt: '2026-08-23T00:00:00.000Z',
  })
}

async function establishRunTurn(
  store: PlatformPersistenceFacade,
  threadId: string,
  runId: string,
  suffix: string,
): Promise<void> {
  await store.appendTranscript({
    threadId,
    runId,
    turnId: `turn_${suffix}`,
    kind: 'message',
    payload: { role: 'user', content: '初始问题' },
  })
}

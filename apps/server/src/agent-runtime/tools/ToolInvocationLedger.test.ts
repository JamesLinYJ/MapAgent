// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具调用账本与副作用提交测试
//
//   文件:       ToolInvocationLedger.test.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PersistenceFacadeTestHarness } from '../../../test-support/persistenceFacadeHarness.js'
import type { PlatformPersistenceFacade } from '../../store/platformPersistenceFacade.js'
import { ToolResultCommitService } from '../../tools/resultPersistence.js'
import { agentContextDigest } from '../step/agentContextDigest.js'
import { ToolEffectCommitter } from './ToolEffectCommitter.js'
import { ToolInvocationLedger } from './ToolInvocationLedger.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('ToolInvocationLedger', () => {
  it('keeps prepare idempotent and rejects a changed immutable identity', async () => {
    const { store, runId } = await fixture()
    const ledger = new ToolInvocationLedger(store, runId)
    const input = invocationInput(runId, 'call_identity', { datasetId: 'dataset_1' })

    const first = await ledger.prepare(input)
    const replay = await ledger.prepare(input)

    expect(replay).toEqual(first)
    await expect(ledger.prepare({
      ...input,
      args: { datasetId: 'dataset_2' },
    })).rejects.toThrow(/持久身份/u)
  })

  it('keeps a terminal call pending until the exact SDK checkpoint acknowledges it', async () => {
    const { harness, store, runId } = await fixture()
    const ledger = new ToolInvocationLedger(store, runId)
    await ledger.prepare(invocationInput(runId, 'call_checkpoint', {}))
    await ledger.start('call_checkpoint', 'not_required')
    await ledger.fail('call_checkpoint', '上游执行失败', false)

    expect((await store.getRunCheckpoint(runId)).pendingToolCallIds).toEqual(['call_checkpoint'])
    expect(await ledger.checkpointTerminalCallIds()).toEqual(['call_checkpoint'])

    await harness.conversationPersistence.saveAgentsSdkCheckpoint(runId, {
      contentHash: 'a'.repeat(64),
      agentsSdkVersion: '0.17.0',
      runtimeConfigDigest: 'runtime_test',
      sdkStateSchemaVersion: 5,
      terminalToolCallIds: ['call_checkpoint'],
    })

    expect(await ledger.require('call_checkpoint')).toMatchObject({
      status: 'checkpointed',
      terminalOutcome: 'failed',
      error: '上游执行失败',
    })
    expect((await harness.conversationPersistence.getRunCheckpoint(runId)).pendingToolCallIds)
      .toEqual([])
  })

  it('commits result, invocation terminal and immediate recovery checkpoint once', async () => {
    const { store, runId } = await fixture()
    const ledger = new ToolInvocationLedger(store, runId)
    await ledger.prepare(invocationInput(runId, 'call_effect', { layerId: 'layer_1' }))
    await ledger.start('call_effect', 'not_required')
    const committer = new ToolEffectCommitter(ledger, new ToolResultCommitService(store))
    const input = {
      runId,
      callId: 'call_effect',
      toolName: 'query_layer',
      toolLabel: '查询图层',
      args: { layerId: 'layer_1' },
      result: {
        message: '查询完成',
        payload: { count: 1 },
        warnings: [],
        resultId: 'result_effect',
        source: 'test',
      },
      objectiveRevision: 1,
      checkpointImmediately: true,
    } as const

    expect(await committer.commit(input)).toEqual({ controlsApplied: true })
    expect(await committer.commit(input)).toEqual({ controlsApplied: false })
    expect(await ledger.require('call_effect')).toMatchObject({
      status: 'checkpointed',
      terminalOutcome: 'succeeded',
      resultId: 'result_effect',
    })
    expect(store.getRun(runId).state.toolResults).toEqual([
      expect.objectContaining({ resultId: 'result_effect', objectiveRevision: 1 }),
    ])
    expect((await store.getRunCheckpoint(runId)).pendingToolCallIds).toEqual([])
  })

  it('commits two distinct invocations even when a read result reuses the same result id', async () => {
    const { store, runId } = await fixture()
    const ledger = new ToolInvocationLedger(store, runId)
    const committer = new ToolEffectCommitter(ledger, new ToolResultCommitService(store))
    const result = {
      message: '同一读取结果',
      payload: { count: 1 },
      warnings: [],
      resultId: 'result_shared_read',
      source: 'test',
    }

    for (const callId of ['call_read_1', 'call_read_2']) {
      await ledger.prepare(invocationInput(runId, callId, { layerId: 'layer_1' }))
      await ledger.start(callId, 'not_required')
      await expect(committer.commit({
        runId,
        callId,
        toolName: 'query_layer',
        toolLabel: '查询图层',
        args: { layerId: 'layer_1' },
        result,
        objectiveRevision: 1,
        checkpointImmediately: true,
      })).resolves.toEqual({ controlsApplied: true })
    }

    await expect(ledger.require('call_read_1')).resolves.toMatchObject({
      terminalOutcome: 'succeeded',
      resultId: result.resultId,
    })
    await expect(ledger.require('call_read_2')).resolves.toMatchObject({
      terminalOutcome: 'succeeded',
      resultId: result.resultId,
    })
  })

  it('records an unplanned SDK call as an explicit rejected fact', async () => {
    const { store, runId } = await fixture()
    const ledger = new ToolInvocationLedger(store, runId)

    const rejected = await ledger.rejectUnplanned({
      runId,
      turnId: 'turn_1',
      callId: 'call_unknown',
      toolName: 'invented_tool',
      objectiveRevision: 1,
      toolPlanDigest: agentContextDigest({ tools: [] }),
      args: { value: 1 },
      error: '工具不在本次计划中',
    })

    expect(rejected).toMatchObject({
      toolKind: 'unavailable',
      status: 'rejected',
      terminalOutcome: 'rejected',
      error: '工具不在本次计划中',
    })
    expect((await store.getRunCheckpoint(runId)).pendingToolCallIds).toEqual([])
  })
})

async function fixture(): Promise<{
  harness: PersistenceFacadeTestHarness
  store: PlatformPersistenceFacade
  runId: string
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tool-invocation-ledger-'))
  roots.push(root)
  const harness = new PersistenceFacadeTestHarness()
  const store = harness.create(path.join(root, 'sessions'))
  await store.initialize()
  const session = await store.createSession()
  const thread = await store.createThread(session.id, '工具账本测试')
  const run = await store.createRun(session.id, '执行工具', { threadId: thread.id })
  await store.updateRunStatus(run.id, 'running')
  return { harness, store, runId: run.id }
}

function invocationInput(
  runId: string,
  callId: string,
  args: Record<string, unknown>,
) {
  return {
    runId,
    turnId: 'turn_1',
    callId,
    stepId: 'step_1',
    objectiveRevision: 1,
    toolPlanDigest: agentContextDigest({ tools: ['query_layer'] }),
    descriptor: {
      name: 'query_layer',
      namespace: 'layers',
      providerId: 'layers',
      kind: 'platform' as const,
      exposure: 'immediate' as const,
      effect: 'read' as const,
      parallelism: 'shared' as const,
      approvalAction: null,
      replayPolicy: 'safe' as const,
      requiredCapabilities: ['world.layers.read'],
      requiredValueRefKinds: [],
      executionSurfaces: ['agent' as const],
    },
    args,
    executionSurface: 'agent' as const,
  }
}

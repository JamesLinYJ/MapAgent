// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行权威快照读取测试
//
//   文件:       conversationSnapshotRepository.test.ts
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { agentStateSchema, runDomainSnapshotSchema } from '../../schemas/types.js'
import { mapAuthoritativeRunRows } from './conversationSnapshotRepository.js'

describe('mapAuthoritativeRunRows', () => {
  it('ignores the mutable Run query projection for status, state, and update time', () => {
    const runRow = queryProjectionRow()
    const snapshotRow = authoritativeSnapshotRow()

    const [run] = mapAuthoritativeRunRows([runRow as never], [snapshotRow as never])

    expect(run).toMatchObject({
      id: 'run_authority',
      status: 'running',
      updatedAt: '2026-08-31T00:00:02.000Z',
      state: { warnings: ['来自权威 snapshot'] },
    })
  })

  it('fails closed when an identity row has no authoritative snapshot', () => {
    expect(() => mapAuthoritativeRunRows([queryProjectionRow() as never], []))
      .toThrow(/缺少权威 platform_run_snapshots/u)
  })
})

function queryProjectionRow() {
  const timestamp = new Date('2026-08-31T00:00:01.000Z')
  return {
    runId: 'run_authority',
    runKind: 'root',
    rootRunId: 'run_authority',
    parentRunId: null,
    parentTurnId: null,
    rootTurnId: null,
    spawnCallId: null,
    agentPath: '/root',
    taskName: null,
    agentRole: null,
    spawnDepth: 0,
    forkMode: 'none',
    forkTurnCount: null,
    modelOverride: null,
    reasoningOverride: null,
    maxModelTokens: null,
    maxWallClockMs: null,
    usedModelTokens: 0,
    nextAgentMessageSequence: 1,
    sessionId: 'session_authority',
    threadId: 'thread_authority',
    workspaceId: null,
    createdByUserId: null,
    visibility: 'private',
    userQuery: '验证权威读取',
    modelProvider: null,
    modelName: null,
    status: 'failed',
    runtimeConfigJson: null,
    activeEntryId: null,
    pendingToolCallIds: ['tampered'],
    recoveryStatus: 'requires_action',
    orchestrationEngine: null,
    sdkStateContentHash: null,
    sdkVersion: null,
    runtimeConfigDigest: null,
    sdkStateSchemaVersion: null,
    sdkStateUpdatedAt: null,
    nextRecordSequence: 1,
    nextInputSequence: 1,
    checkpointInputCursor: 0,
    activeInputLeaseId: null,
    activeInputLeaseFrom: null,
    activeInputLeaseTo: null,
    terminalInputClaimId: null,
    terminalObjectiveRevision: null,
    terminalInputCursor: null,
    terminalClaimedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function authoritativeSnapshotRow() {
  const updatedAt = '2026-08-31T00:00:02.000Z'
  const snapshot = runDomainSnapshotSchema.parse({
    schemaVersion: 1,
    runId: 'run_authority',
    sequence: 2,
    status: 'running',
    state: agentStateSchema.parse({
      sessionId: 'session_authority',
      threadId: 'thread_authority',
      userQuery: '验证权威读取',
      warnings: ['来自权威 snapshot'],
    }),
    inputDeliveries: {},
    activeModelRequestId: null,
    contextWindowId: null,
    contextWindowGeneration: 0,
    checkpoint: {
      activeEntryId: null,
      pendingToolCallIds: [],
      recoveryStatus: 'clean',
      orchestrationEngine: null,
      sdkStateContentHash: null,
      agentsSdkVersion: null,
      runtimeConfigDigest: null,
      sdkStateSchemaVersion: null,
      sdkStateUpdatedAt: null,
      nextInputSequence: 1,
      checkpointInputCursor: 0,
      activeInputLeaseId: null,
      activeInputLeaseFrom: null,
      activeInputLeaseTo: null,
      terminalInputClaimId: null,
      terminalObjectiveRevision: null,
      terminalInputCursor: null,
      terminalClaimedAt: null,
    },
    updatedAt,
  })
  return {
    runId: snapshot.runId,
    sequence: snapshot.sequence,
    snapshotSchemaVersion: snapshot.schemaVersion,
    stateJson: snapshot,
    updatedAt: new Date(updatedAt),
  }
}

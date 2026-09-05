// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行审批契约测试
//
//   文件:       approvalRuntime.test.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  approvalDecisionInputSchema,
  approvalRecordSchema,
  type ApprovalRecord,
} from './approvalRuntime.js'

describe('approval runtime contract', () => {
  it('accepts a canonical consumed session approval', () => {
    expect(approvalRecordSchema.parse(record({
      status: 'consumed',
      decision: 'approved',
      decisionScope: 'session',
      resolvedAt: '2026-08-24T00:00:01.000Z',
      consumedAt: '2026-08-24T00:00:02.000Z',
    })).decisionScope).toBe('session')
  })

  it('requires an exact-call rejection reason', () => {
    expect(() => approvalDecisionInputSchema.parse({
      decision: 'rejected',
      scope: 'session',
      reason: null,
    })).toThrow(/精确调用|理由/u)
  })

  it('rejects non-canonical resource and denied-read identities', () => {
    expect(() => approvalRecordSchema.parse(record({
      action: {
        ...record().action,
        resourceIds: ['layer_b', 'layer_a'],
        permissionScope: {
          requiredCapabilities: [],
          deniedReadResourceIds: ['file_b', 'file_a'],
        },
      },
    }))).toThrow(/canonical/u)
  })
})

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    approvalId: 'approval_1',
    runId: 'run_1',
    threadId: 'thread_1',
    sessionId: 'session_1',
    workspaceId: 'workspace_1',
    invocationId: 'invocation_1',
    callId: 'call_1',
    stepId: 'step_1',
    contextDigest: 'sha256:context',
    actionKey: 'sha256:action',
    action: {
      kind: 'world_write',
      workspaceId: 'workspace_1',
      toolName: 'create_layer',
      toolKind: 'platform',
      effect: 'world_write',
      resourceIds: ['layer_1'],
      permissionScope: {
        requiredCapabilities: [],
        deniedReadResourceIds: [],
      },
      argsDigest: 'sha256:args',
      contextDigest: 'sha256:context',
    },
    status: 'pending',
    decision: null,
    decisionScope: null,
    decisionReason: null,
    decidedByUserId: null,
    sourceApprovalId: null,
    createdAt: '2026-08-24T00:00:00.000Z',
    resolvedAt: null,
    consumedAt: null,
    version: 1,
    ...overrides,
  }
}

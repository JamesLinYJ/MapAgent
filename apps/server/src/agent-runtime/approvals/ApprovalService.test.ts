// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行审批服务测试
//
//   文件:       ApprovalService.test.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { ApprovalRecord } from '@geo-agent-platform/shared-types/approval-runtime'

import type {
  ApprovalRepository,
  ConsumeApprovalRecordInput,
  ResolveApprovalRecordInput,
} from '../../store/postgres/conversationPersistencePorts.js'
import {
  ApprovalForbiddenError,
  ApprovalRejectedError,
  ApprovalService,
  type ApprovalCallInput,
} from './ApprovalService.js'
import { stepContext, toolDescriptor } from './approvalTestFixtures.js'

describe('ApprovalService', () => {
  it('keeps exact-call approval idempotent through resolve, consume, and retry', async () => {
    const store = new MemoryApprovalRepository()
    const service = approvalService(store)
    const call = approvalCall('call_exact')

    const first = await service.requirement(call)
    const retry = await service.requirement(call)
    expect(first.requiresApproval).toBe(true)
    expect(retry.record?.approvalId).toBe(first.record?.approvalId)
    expect(store.records).toHaveLength(1)

    await service.resolveCall(call.callId, {
      decision: 'approved', scope: 'exact_call', reason: null,
    }, 'user_1')
    await expect(service.executionDecision(call)).resolves.toBe('approved')
    await expect(service.executionDecision(call)).resolves.toBe('approved')
    expect((await service.getForCall(call.callId))?.status).toBe('consumed')
  })

  it('derives a call-bound approval from a session decision without a second interruption', async () => {
    const store = new MemoryApprovalRepository()
    const service = approvalService(store)
    const firstCall = approvalCall('call_session_1')
    const first = await service.requirement(firstCall)
    await service.resolveCall(firstCall.callId, {
      decision: 'approved', scope: 'session', reason: null,
    }, 'user_1')
    await service.executionDecision(firstCall)

    const secondCall = approvalCall('call_session_2', {
      context: stepContext({ stepId: 'step_2', contextDigest: 'sha256:next-context' }),
    })
    const inherited = await service.requirement(secondCall)
    expect(inherited.requiresApproval).toBe(false)
    expect(inherited.record).toMatchObject({
      status: 'resolved',
      decision: 'approved',
      decisionScope: 'exact_call',
      sourceApprovalId: first.record?.approvalId,
    })
    await expect(service.executionDecision(secondCall)).resolves.toBe('approved')
  })

  it('preserves rejection as a durable call fact and consumes it explicitly', async () => {
    const store = new MemoryApprovalRepository()
    const service = approvalService(store)
    const call = approvalCall('call_rejected')
    await service.requirement(call)
    await service.resolveCall(call.callId, {
      decision: 'rejected', scope: 'exact_call', reason: '用户拒绝删除图层',
    }, 'user_1')

    await expect(service.requirement(call)).rejects.toBeInstanceOf(ApprovalRejectedError)
    await expect(service.consumeRejectedCall(call.callId)).resolves.toMatchObject({ status: 'consumed' })
    await expect(service.requirement(call)).rejects.toBeInstanceOf(ApprovalRejectedError)
  })

  it('does not create an approval record when ToolPolicy forbids the call', async () => {
    const store = new MemoryApprovalRepository()
    const service = approvalService(store)
    const call = approvalCall('call_forbidden', {
      context: stepContext({
        toolRules: [{ toolPattern: 'create_*', decision: 'always_deny', priority: 100 }],
      }),
    })
    await expect(service.requirement(call)).rejects.toBeInstanceOf(ApprovalForbiddenError)
    expect(store.records).toHaveLength(0)
  })
})

function approvalService(store: ApprovalRepository): ApprovalService {
  return new ApprovalService({
    store,
    runId: 'run_1',
    threadId: 'thread_1',
    sessionId: 'session_1',
  })
}

function approvalCall(
  callId: string,
  overrides: Partial<ApprovalCallInput> = {},
): ApprovalCallInput {
  const context = overrides.context ?? stepContext()
  return {
    context,
    descriptor: toolDescriptor(),
    args: { layerId: 'layer_1' },
    invocationId: `invocation_${callId}`,
    callId,
    stepId: context.identity.stepId,
    ...overrides,
  }
}

class MemoryApprovalRepository implements ApprovalRepository {
  readonly records: ApprovalRecord[] = []

  async prepareApprovalRecord(record: ApprovalRecord): Promise<ApprovalRecord> {
    const existing = await this.getApprovalRecordForCall(record.runId, record.callId)
    if (existing) return existing
    this.records.push(structuredClone(record))
    return structuredClone(record)
  }

  async getApprovalRecord(approvalId: string): Promise<ApprovalRecord | null> {
    return structuredClone(this.records.find(record => record.approvalId === approvalId) ?? null)
  }

  async getApprovalRecordForCall(runId: string, callId: string): Promise<ApprovalRecord | null> {
    return structuredClone(this.records.find(record => record.runId === runId && record.callId === callId) ?? null)
  }

  async listApprovalRecords(runId: string): Promise<ApprovalRecord[]> {
    return structuredClone(this.records.filter(record => record.runId === runId))
  }

  async findSessionApproval(sessionId: string, actionKey: string): Promise<ApprovalRecord | null> {
    return structuredClone(this.records.find(record => (
      record.sessionId === sessionId
      && record.actionKey === actionKey
      && record.decision === 'approved'
      && record.decisionScope === 'session'
      && ['resolved', 'consumed'].includes(record.status)
    )) ?? null)
  }

  async resolveApprovalRecord(input: ResolveApprovalRecordInput): Promise<ApprovalRecord> {
    const index = this.records.findIndex(record => (
      record.runId === input.runId && record.approvalId === input.approvalId
    ))
    if (index < 0) throw new Error('approval missing')
    const current = this.records[index]!
    if (current.status !== 'pending' || current.version !== input.expectedVersion) {
      if (
        current.decision === input.decision
        && current.decisionScope === input.scope
        && current.decisionReason === input.reason
      ) return structuredClone(current)
      throw new Error('resolve CAS failed')
    }
    const updated: ApprovalRecord = {
      ...current,
      status: 'resolved',
      decision: input.decision,
      decisionScope: input.scope,
      decisionReason: input.reason,
      decidedByUserId: input.decidedByUserId,
      resolvedAt: input.resolvedAt,
      version: current.version + 1,
    }
    this.records[index] = updated
    return structuredClone(updated)
  }

  async consumeApprovalRecord(input: ConsumeApprovalRecordInput): Promise<ApprovalRecord> {
    const index = this.records.findIndex(record => (
      record.runId === input.runId && record.approvalId === input.approvalId
    ))
    if (index < 0) throw new Error('approval missing')
    const current = this.records[index]!
    if (current.status === 'consumed') return structuredClone(current)
    if (current.status !== 'resolved' || current.version !== input.expectedVersion) {
      throw new Error('consume CAS failed')
    }
    const updated: ApprovalRecord = {
      ...current,
      status: 'consumed',
      consumedAt: input.consumedAt,
      version: current.version + 1,
    }
    this.records[index] = updated
    return structuredClone(updated)
  }
}

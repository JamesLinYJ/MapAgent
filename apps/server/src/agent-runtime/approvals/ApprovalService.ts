// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行审批服务
//
//   文件:       ApprovalService.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { isDeepStrictEqual } from 'node:util'

import {
  approvalDecisionInputSchema,
  approvalRecordSchema,
  type ApprovalDecisionInput,
  type ApprovalRecord,
} from '@geo-agent-platform/shared-types/approval-runtime'
import type { AgentStepContext } from '@geo-agent-platform/shared-types/agent-step-context'
import type { AgentToolDescriptorSource } from '@geo-agent-platform/shared-types/tool-runtime'

import type {
  ApprovalRepository,
} from '../../store/postgres/conversationPersistencePorts.js'
import { nowUtc } from '../../utils/ids.js'
import { agentContextDigest } from '../step/agentContextDigest.js'
import {
  approvalActionKey,
  buildApprovalAction,
} from './ApprovalAction.js'
import {
  ApprovalPolicyEngine,
  type ApprovalPolicyOutcome,
} from './ApprovalPolicyEngine.js'

export type ApprovalExecutionDecision = 'not_required' | 'approved'

export interface ApprovalCallInput {
  context: AgentStepContext
  descriptor: AgentToolDescriptorSource
  args: Record<string, unknown>
  invocationId: string
  callId: string
  stepId: string
  deniedReadResourceIds?: readonly string[]
}

export interface ApprovalRequirement {
  requiresApproval: boolean
  record: ApprovalRecord | null
  policy: ApprovalPolicyOutcome
}

export class ApprovalForbiddenError extends Error {
  readonly code = 'APPROVAL_FORBIDDEN'
}

class ApprovalPendingError extends Error {
  readonly code = 'APPROVAL_PENDING'
}

export class ApprovalRejectedError extends Error {
  readonly code = 'APPROVAL_REJECTED'
}

/**
 * 每次调用先由不可变 StepContext 计算 canonical Action，再进入持久记录。
 * SDK hook、用户决定与真正执行都只按 runId/callId 读取同一事实，不读取
 * “最近一次审批”或可变运行配置。
 */
export class ApprovalService {
  private readonly policy = new ApprovalPolicyEngine()

  constructor(private readonly options: {
    store: ApprovalRepository
    runId: string
    threadId: string
    sessionId: string
  }) {}

  async requirement(input: ApprovalCallInput): Promise<ApprovalRequirement> {
    this.assertCallScope(input)
    const action = buildApprovalAction({
      workspaceId: input.context.permissions.workspaceId,
      descriptor: input.descriptor,
      args: input.args,
      contextDigest: input.context.contextDigest,
      ...(input.deniedReadResourceIds
        ? { deniedReadResourceIds: input.deniedReadResourceIds }
        : {}),
    })
    const policy = this.policy.evaluate({
      context: input.context,
      descriptor: input.descriptor,
      action,
    })
    if (policy.kind === 'forbidden') throw new ApprovalForbiddenError(policy.reason)
    if (policy.kind === 'allowed') {
      return { requiresApproval: false, record: null, policy }
    }

    const actionKey = approvalActionKey(action)
    const existing = await this.options.store.getApprovalRecordForCall(
      this.options.runId,
      input.callId,
    )
    if (existing) {
      assertApprovalIdentity(existing, input, actionKey, action)
      if (existing.decision === 'rejected') {
        throw new ApprovalRejectedError(
          existing.decisionReason ?? `工具调用 '${input.callId}' 已被拒绝`,
        )
      }
      return {
        requiresApproval: existing.status === 'pending',
        record: existing,
        policy,
      }
    }

    const inherited = await this.options.store.findSessionApproval(
      this.options.sessionId,
      actionKey,
    )
    const timestamp = nowUtc()
    const prepared = await this.options.store.prepareApprovalRecord(approvalRecordSchema.parse({
      approvalId: approvalIdentity(this.options.runId, input.callId),
      runId: this.options.runId,
      threadId: this.options.threadId,
      sessionId: this.options.sessionId,
      workspaceId: input.context.permissions.workspaceId,
      invocationId: input.invocationId,
      callId: input.callId,
      stepId: input.stepId,
      contextDigest: input.context.contextDigest,
      actionKey,
      action,
      status: inherited ? 'resolved' : 'pending',
      decision: inherited ? 'approved' : null,
      decisionScope: inherited ? 'exact_call' : null,
      decisionReason: inherited?.decisionReason ?? null,
      decidedByUserId: inherited?.decidedByUserId ?? null,
      sourceApprovalId: inherited?.approvalId ?? null,
      createdAt: timestamp,
      resolvedAt: inherited ? timestamp : null,
      consumedAt: null,
      version: 1,
    }))
    assertApprovalIdentity(prepared, input, actionKey, action)
    return {
      requiresApproval: prepared.status === 'pending',
      record: prepared,
      policy,
    }
  }

  async executionDecision(input: ApprovalCallInput): Promise<ApprovalExecutionDecision> {
    const requirement = await this.requirement(input)
    if (requirement.policy.kind === 'allowed') return 'not_required'
    const record = requirement.record
    if (!record) throw new Error(`工具调用 '${input.callId}' 缺少审批记录`)
    if (record.status === 'pending') {
      throw new ApprovalPendingError(`工具调用 '${input.callId}' 尚待审批`)
    }
    if (record.decision !== 'approved') {
      throw new ApprovalRejectedError(
        record.decisionReason ?? `工具调用 '${input.callId}' 未获批准`,
      )
    }
    if (record.status === 'consumed') return 'approved'
    await this.options.store.consumeApprovalRecord({
      runId: this.options.runId,
      approvalId: record.approvalId,
      expectedVersion: record.version,
      consumedAt: nowUtc(),
    })
    return 'approved'
  }

  async resolveCall(
    callId: string,
    decision: ApprovalDecisionInput,
    decidedByUserId: string | null,
  ): Promise<ApprovalRecord> {
    const parsed = approvalDecisionInputSchema.parse(decision)
    const record = await this.options.store.getApprovalRecordForCall(this.options.runId, callId)
    if (!record) throw new Error(`工具调用 '${callId}' 没有待处理审批`)
    return this.options.store.resolveApprovalRecord({
      ...parsed,
      runId: this.options.runId,
      approvalId: record.approvalId,
      expectedVersion: record.version,
      decidedByUserId,
      resolvedAt: nowUtc(),
    })
  }

  async consumeRejectedCall(callId: string): Promise<ApprovalRecord> {
    const record = await this.options.store.getApprovalRecordForCall(this.options.runId, callId)
    if (!record) throw new Error(`工具调用 '${callId}' 没有审批记录`)
    if (record.decision !== 'rejected') {
      throw new Error(`工具调用 '${callId}' 的审批决定不是 rejected`)
    }
    if (record.status === 'consumed') return record
    return this.options.store.consumeApprovalRecord({
      runId: this.options.runId,
      approvalId: record.approvalId,
      expectedVersion: record.version,
      consumedAt: nowUtc(),
    })
  }

  getForCall(callId: string): Promise<ApprovalRecord | null> {
    return this.options.store.getApprovalRecordForCall(this.options.runId, callId)
  }

  private assertCallScope(input: ApprovalCallInput): void {
    if (input.context.runId !== this.options.runId) {
      throw new Error(`审批 StepContext runId '${input.context.runId}' 与当前运行不一致`)
    }
    if (input.context.identity.stepId !== input.stepId) {
      throw new Error(`审批调用 '${input.callId}' 的 stepId 与 StepContext 不一致`)
    }
  }
}

function approvalIdentity(runId: string, callId: string): string {
  return `approval_${agentContextDigest({ runId, callId }).slice('sha256:'.length)}`
}

function assertApprovalIdentity(
  record: ApprovalRecord,
  input: ApprovalCallInput,
  actionKey: string,
  action: ApprovalRecord['action'],
): void {
  const expected = {
    runId: input.context.runId,
    invocationId: input.invocationId,
    callId: input.callId,
    stepId: input.stepId,
    contextDigest: input.context.contextDigest,
    workspaceId: input.context.permissions.workspaceId,
    actionKey,
    action,
  }
  const actual = {
    runId: record.runId,
    invocationId: record.invocationId,
    callId: record.callId,
    stepId: record.stepId,
    contextDigest: record.contextDigest,
    workspaceId: record.workspaceId,
    actionKey: record.actionKey,
    action: record.action,
  }
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`审批调用 '${input.callId}' 的持久身份与 StepContext 不一致`)
  }
}

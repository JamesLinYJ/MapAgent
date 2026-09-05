// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具调用领域账本
//
//   文件:       ToolInvocationLedger.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  toolInvocationRecordSchema,
  type AgentToolDescriptorSource,
  type AgentToolExecutionSurface,
  type ToolInvocationRecord,
  type ToolInvocationTerminalOutcome,
} from '@geo-agent-platform/shared-types/tool-runtime'

import type {
  StartToolInvocationInput,
  TerminalToolInvocationInput,
} from '../../store/postgres/conversationPersistencePorts.js'
import { nowUtc } from '../../utils/ids.js'
import { agentContextDigest } from '../step/agentContextDigest.js'

export interface ToolInvocationLedgerStore {
  prepareToolInvocation(invocation: ToolInvocationRecord): Promise<ToolInvocationRecord>
  getToolInvocation(runId: string, callId: string): Promise<ToolInvocationRecord | null>
  listToolInvocations(runId: string): Promise<ToolInvocationRecord[]>
  startToolInvocation(input: StartToolInvocationInput): Promise<ToolInvocationRecord>
  terminateToolInvocation(input: TerminalToolInvocationInput): Promise<ToolInvocationRecord>
}

export interface PrepareToolInvocationInput {
  runId: string
  turnId: string
  callId: string
  stepId: string | null
  objectiveRevision: number
  toolPlanDigest: string
  descriptor: AgentToolDescriptorSource
  args: Record<string, unknown>
  executionSurface: AgentToolExecutionSurface
}

export interface RejectUnplannedToolInvocationInput {
  runId: string
  turnId: string
  callId: string
  toolName: string
  objectiveRevision: number
  toolPlanDigest: string
  args: Record<string, unknown>
  error: string
}

export class ToolInvocationLedger {
  constructor(
    private readonly store: ToolInvocationLedgerStore,
    private readonly runId: string,
  ) {}

  prepare(input: PrepareToolInvocationInput): Promise<ToolInvocationRecord> {
    if (input.runId !== this.runId) {
      return Promise.reject(new Error(`工具调用 runId '${input.runId}' 与账本 '${this.runId}' 不一致`))
    }
    const invocationId = invocationIdentity(input.runId, input.callId)
    return this.store.prepareToolInvocation(toolInvocationRecordSchema.parse({
      invocationId,
      runId: input.runId,
      turnId: input.turnId,
      callId: input.callId,
      stepId: input.stepId,
      toolName: input.descriptor.name,
      toolKind: input.descriptor.kind,
      executionSurface: input.executionSurface,
      objectiveRevision: input.objectiveRevision,
      toolPlanDigest: input.toolPlanDigest,
      descriptorDigest: agentContextDigest(input.descriptor),
      argsDigest: agentContextDigest(input.args),
      effect: input.descriptor.effect,
      replayPolicy: input.descriptor.replayPolicy,
      idempotencyKey: input.descriptor.replayPolicy === 'idempotency_key'
        ? invocationId
        : null,
      approvalAction: input.descriptor.approvalAction,
      approvalDecision: null,
      status: 'prepared',
      terminalOutcome: null,
      resultId: null,
      error: null,
      preparedAt: nowUtc(),
      runningAt: null,
      terminalAt: null,
      checkpointedAt: null,
      version: 1,
    }))
  }

  async rejectUnplanned(input: RejectUnplannedToolInvocationInput): Promise<ToolInvocationRecord> {
    if (input.runId !== this.runId) {
      throw new Error(`工具调用 runId '${input.runId}' 与账本 '${this.runId}' 不一致`)
    }
    const invocationId = invocationIdentity(input.runId, input.callId)
    const prepared = await this.store.prepareToolInvocation(toolInvocationRecordSchema.parse({
      invocationId,
      runId: input.runId,
      turnId: input.turnId,
      callId: input.callId,
      stepId: null,
      toolName: input.toolName,
      toolKind: 'unavailable',
      executionSurface: 'agent',
      objectiveRevision: input.objectiveRevision,
      toolPlanDigest: input.toolPlanDigest,
      descriptorDigest: agentContextDigest({
        name: input.toolName,
        kind: 'unavailable',
        reason: input.error,
      }),
      argsDigest: agentContextDigest(input.args),
      effect: 'external_write',
      replayPolicy: 'manual_recovery',
      idempotencyKey: null,
      approvalAction: null,
      approvalDecision: null,
      status: 'prepared',
      terminalOutcome: null,
      resultId: null,
      error: null,
      preparedAt: nowUtc(),
      runningAt: null,
      terminalAt: null,
      checkpointedAt: null,
      version: 1,
    }))
    if (prepared.terminalOutcome === 'rejected') return prepared
    return this.store.terminateToolInvocation({
      runId: input.runId,
      invocationId: prepared.invocationId,
      expectedVersion: prepared.version,
      outcome: 'rejected',
      resultId: null,
      error: input.error,
      terminalAt: nowUtc(),
      checkpointImmediately: false,
      approvalDecision: 'rejected',
    })
  }

  async start(
    callId: string,
    approvalDecision: StartToolInvocationInput['approvalDecision'],
  ): Promise<ToolInvocationRecord> {
    const current = await this.require(callId)
    if (current.status === 'running') return current
    if (current.status !== 'prepared') {
      throw new Error(`工具调用 '${callId}' 不能从 ${current.status} 进入 running`)
    }
    return this.store.startToolInvocation({
      runId: this.runId,
      invocationId: current.invocationId,
      expectedVersion: current.version,
      runningAt: nowUtc(),
      approvalDecision,
    })
  }

  fail(callId: string, error: string, checkpointImmediately: boolean): Promise<ToolInvocationRecord> {
    return this.terminate(callId, 'failed', null, error, checkpointImmediately)
  }

  abort(callId: string, error: string, checkpointImmediately: boolean): Promise<ToolInvocationRecord> {
    return this.terminate(callId, 'aborted', null, error, checkpointImmediately)
  }

  reject(callId: string, error: string, checkpointImmediately: boolean): Promise<ToolInvocationRecord> {
    return this.terminate(callId, 'rejected', null, error, checkpointImmediately, 'rejected')
  }

  succeed(
    callId: string,
    resultId: string | null,
    checkpointImmediately: boolean,
  ): Promise<ToolInvocationRecord> {
    return this.terminate(callId, 'succeeded', resultId, null, checkpointImmediately)
  }

  async require(callId: string): Promise<ToolInvocationRecord> {
    const invocation = await this.store.getToolInvocation(this.runId, callId)
    if (!invocation) throw new Error(`工具调用 '${callId}' 尚未进入持久账本`)
    return invocation
  }

  async requireRunning(callId: string): Promise<ToolInvocationRecord> {
    const invocation = await this.require(callId)
    if (invocation.status !== 'running') {
      throw new Error(`工具调用 '${callId}' 当前为 ${invocation.status}，不能提交副作用`)
    }
    return invocation
  }

  async checkpointTerminalCallIds(): Promise<string[]> {
    const records = await this.store.listToolInvocations(this.runId)
    return records.filter(record => [
      'succeeded',
      'failed',
      'rejected',
      'aborted',
    ].includes(record.status)).map(record => record.callId)
  }

  private async terminate(
    callId: string,
    outcome: ToolInvocationTerminalOutcome,
    resultId: string | null,
    error: string | null,
    checkpointImmediately: boolean,
    approvalDecision?: 'rejected',
  ): Promise<ToolInvocationRecord> {
    const current = await this.require(callId)
    if (current.terminalOutcome === outcome) return current
    return this.store.terminateToolInvocation({
      runId: this.runId,
      invocationId: current.invocationId,
      expectedVersion: current.version,
      outcome,
      resultId,
      error,
      terminalAt: nowUtc(),
      checkpointImmediately,
      ...(approvalDecision ? { approvalDecision } : {}),
    })
  }
}

function invocationIdentity(runId: string, callId: string): string {
  return `tool_invocation_${agentContextDigest({ runId, callId }).slice('sha256:'.length)}`
}

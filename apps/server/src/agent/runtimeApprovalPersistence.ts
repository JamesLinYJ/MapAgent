// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行审批持久化
//
//   文件:       runtimeApprovalPersistence.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { RunToolApprovalItem } from '@openai/agents'

import type { ItemSink } from '../conversation/itemSink.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import { approvalDecisionFromRequest, approvalDescription, approvalTitle, upsertDecision } from './runtimeApprovals.js'
import { functionCallId, parseArguments, requireThreadId } from './runtimeSdkProjection.js'
import type { RunEventSink } from './turnRunner.js'
import type { AgentsSdkCheckpointService } from '../agent-runtime/sdk/AgentsSdkCheckpointService.js'
import type { RunOptions } from './runtimeTypes.js'
import { agentContextDigest } from '../agent-runtime/step/agentContextDigest.js'

export class RuntimeApprovalPersistence {
  constructor(
    private readonly store: AgentRuntimeStore,
    private readonly toolRegistry: ToolRegistry,
    private readonly checkpoints: AgentsSdkCheckpointService,
  ) {}

  async persist(
    options: RunOptions,
    interruptions: RunToolApprovalItem[],
    eventSink: RunEventSink,
    itemSink: ItemSink,
  ): Promise<void> {
    const run = this.store.getRun(options.runId)
    const approvals = [...run.state.approvals]
    let decisions = [...run.state.decisions]
    for (const interruption of interruptions) {
      const callId = functionCallId(interruption)
      const toolName = interruption.name
      if (!callId || !toolName) throw new Error('SDK 审批中断缺少 callId/toolName')
      if (approvals.some(item => item.payload.callId === callId && item.payload.consumed !== true)) continue
      const args = parseArguments(interruption.arguments)
      const actionArgs = { ...args }
      delete actionArgs.workflowStepId
      const record = await this.store.getApprovalRecordForCall(options.runId, callId)
      if (!record) throw new Error(`SDK 审批中断 '${callId}' 缺少持久审批事实`)
      if (record.action.toolName !== toolName || record.action.argsDigest !== agentContextDigest(actionArgs)) {
        throw new Error(`SDK 审批中断 '${callId}' 与持久审批动作不一致`)
      }
      if (record.status !== 'pending') {
        throw new Error(`SDK 审批中断 '${callId}' 的持久审批状态不是 pending`)
      }
      const definition = this.toolRegistry.get(toolName)
      const request = {
        approvalId: record.approvalId,
        action: toolName,
        title: approvalTitle(toolName, definition?.label),
        description: approvalDescription(toolName, definition?.description),
        status: 'pending',
        artifactId: null,
        payload: {
          toolName,
          args,
          callId,
          actionKey: record.actionKey,
          contextDigest: record.contextDigest,
          decisionScope: record.decisionScope,
          turnId: await this.checkpoints.requireTurnId(requireThreadId(options.threadId), options.runId),
          consumed: false,
        },
        createdAt: record.createdAt,
        resolvedAt: record.resolvedAt,
      }
      approvals.push(request)
      decisions = upsertDecision(decisions, approvalDecisionFromRequest(request))
      eventSink.emit('approval.required', request.title, { approvalId: request.approvalId, tool: toolName, callId })
      itemSink.appendResult('waiting_approval', {
        decisionId: request.approvalId,
        approvalId: request.approvalId,
        tool: toolName,
        callId,
        title: request.title,
        description: request.description,
        args,
      })
    }
    await this.store.updateRunState(options.runId, { approvals, decisions })
    await eventSink.flush()
    await itemSink.flush()
    await this.store.completeRun(options.runId, 'waiting_approval')
  }
}

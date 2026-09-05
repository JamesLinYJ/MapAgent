// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具运行投影发布器
//
//   文件:       ToolProjectionPublisher.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ToolRegistry } from '../../framework/registry.js'
import type { ToolResult } from '../../framework/types.js'
import {
  agentToolOutputMetadataSchema,
  type AgentToolOutputMetadata,
} from '../../schemas/types.js'
import type { ToolExecutionStore } from '../../store/runtimePorts.js'
import type { ItemSink } from '../../conversation/itemSink.js'
import type { RunEventSink } from '../../agent/turnRunner.js'

interface ToolProjectionPublisherOptions {
  store: ToolExecutionStore
  registry: ToolRegistry
  runId: string
  threadId: string
  turnId: string
  inlineToolResultMaxChars: number
  eventSink: RunEventSink
  itemSink: ItemSink
  valueState: Map<string, unknown>
  onPlanModeChanged?: (enabled: boolean) => void
}

export interface PublishPreparedToolCallInput {
  callId: string
  toolName: string
  toolLabel: string
  args: Record<string, unknown>
  workflowStepId: string | null
  objectiveRevision: number
  createConversationItem: boolean
}

export interface PublishToolSuccessInput {
  callId: string
  toolName: string
  toolLabel: string
  result: ToolResult
  objectiveRevision: number
  controlsApplied: boolean
  existingArtifactIds: ReadonlySet<string>
}

/**
 * Publishes rebuildable transcript, item, event and in-memory value projections.
 * Durable invocation/effect facts are committed before this boundary and are never rolled back here.
 */
export class ToolProjectionPublisher {
  private readonly callItems = new Map<string, string>()
  private readonly outputMetadata = new Map<string, AgentToolOutputMetadata>()

  constructor(private readonly options: ToolProjectionPublisherOptions) {}

  async ensurePrepared(input: PublishPreparedToolCallInput): Promise<number> {
    const existing = (await this.options.store.activeTranscript(this.options.threadId))
      .find(entry => entry.kind === 'tool_call' && entry.payload.callId === input.callId)
    if (existing) return objectiveRevisionFromPayload(existing.payload, 1)

    await this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'tool_call',
      payload: {
        callId: input.callId,
        name: input.toolName,
        label: input.toolLabel,
        arguments: input.args,
        workflowStepId: input.workflowStepId,
        objectiveRevision: input.objectiveRevision,
        ledgerStatus: 'prepared',
      },
    })
    if (input.createConversationItem) {
      const item = this.options.itemSink.startItem('function_call', {
        name: input.toolName,
        callId: input.callId,
        arguments: JSON.stringify(input.args),
        metadata: { toolLabel: input.toolLabel, objectiveRevision: input.objectiveRevision },
      })
      this.callItems.set(input.callId, item.itemId)
    }
    return input.objectiveRevision
  }

  rejectPrepared(toolName: string, callId: string, message: string): void {
    const itemId = this.callItems.get(callId)
    if (!itemId) return
    this.options.itemSink.completeItem(itemId, {
      callId,
      name: toolName,
      body: message,
      isError: true,
      metadata: { toolLabel: this.toolLabel(toolName), rejectedBy: 'input_guardrail' },
    })
  }

  async publishApprovalRejected(input: {
    callId: string
    toolName: string
    objectiveRevision: number
    message: string
  }): Promise<void> {
    const transcript = await this.options.store.activeTranscript(this.options.threadId)
    if (transcript.some(entry => entry.kind === 'tool_result' && entry.payload.callId === input.callId)) return
    await this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'tool_result',
      payload: {
        callId: input.callId,
        objectiveRevision: input.objectiveRevision,
        name: input.toolName,
        label: this.toolLabel(input.toolName),
        summary: input.message,
        content: input.message,
        contentRef: null,
        ledgerStatus: 'rejected',
        resultId: null,
        source: 'approval_decision',
      },
    })
  }

  async publishStarted(
    callId: string,
    toolName: string,
    toolLabel: string,
    objectiveRevision: number,
  ): Promise<void> {
    await this.appendLedger(callId, toolName, toolLabel, 'started', objectiveRevision)
    this.options.eventSink.emit('tool.started', toolLabel, {
      tool: toolName,
      toolLabel,
      callId,
      objectiveRevision,
    })
  }

  async publishSucceeded(input: PublishToolSuccessInput): Promise<void> {
    const generatedArtifactIds = this.options.store.getRun(this.options.runId).state.artifacts
      .map(artifact => artifact.artifactId)
      .filter(artifactId => !input.existingArtifactIds.has(artifactId))
    this.outputMetadata.set(input.callId, agentToolOutputMetadataSchema.parse({
      schemaVersion: 1,
      callId: input.callId,
      toolName: input.toolName,
      resultId: input.result.resultId,
      valueRefIds: (input.result.valueRefs ?? []).map(reference => reference.refId),
      artifactIds: [...new Set([
        ...(input.result.artifacts ?? []).map(artifact => artifact.artifactId),
        ...generatedArtifactIds,
      ])],
      display: {
        label: input.toolLabel,
        summary: input.result.message,
        source: input.result.source,
      },
    }))

    if (input.controlsApplied && typeof input.result.payload.planMode === 'boolean') {
      this.options.onPlanModeChanged?.(input.result.payload.planMode)
    }
    if (input.controlsApplied) this.publishWorkflowControl(input.toolName)
    for (const ref of input.result.valueRefs ?? []) this.options.valueState.set(ref.refId, ref)
    this.options.eventSink.emit('tool.completed', input.result.message, {
      tool: input.toolName,
      toolLabel: input.toolLabel,
      callId: input.callId,
      result: input.result.payload,
      objectiveRevision: input.objectiveRevision,
    })

    const itemId = this.callItems.get(input.callId)
    if (itemId) {
      this.options.itemSink.completeItem(itemId, {
        callId: input.callId,
        name: input.toolName,
        output: JSON.stringify(input.result.payload),
        metadata: {
          toolLabel: input.toolLabel,
          resultId: input.result.resultId,
          source: input.result.source,
          artifacts: input.result.artifacts ?? [],
          objectiveRevision: input.objectiveRevision,
        },
      })
    }
    const outputItemId = this.options.itemSink.startItem('function_call_output', {
      callId: input.callId,
      name: input.toolName,
      role: 'tool',
      metadata: {
        toolLabel: input.toolLabel,
        resultId: input.result.resultId,
        source: input.result.source,
        artifacts: input.result.artifacts ?? [],
        objectiveRevision: input.objectiveRevision,
      },
    }).itemId
    this.options.itemSink.completeItem(outputItemId, {
      callId: input.callId,
      name: input.toolName,
      output: JSON.stringify(input.result.payload),
      metadata: {
        toolLabel: input.toolLabel,
        resultId: input.result.resultId,
        source: input.result.source,
        valueRefs: input.result.valueRefs ?? [],
        artifacts: input.result.artifacts ?? [],
        objectiveRevision: input.objectiveRevision,
      },
    })
    await this.appendToolResult(input)
  }

  async publishFailed(input: {
    callId: string
    toolName: string
    toolLabel: string
    message: string
    objectiveRevision: number
  }): Promise<void> {
    this.outputMetadata.set(input.callId, agentToolOutputMetadataSchema.parse({
      schemaVersion: 1,
      callId: input.callId,
      toolName: input.toolName,
      resultId: null,
      valueRefIds: [],
      artifactIds: [],
      display: {
        label: input.toolLabel,
        summary: input.message,
        source: null,
      },
    }))
    await this.options.store.mutateRunState(this.options.runId, state => ({
      warnings: [...state.warnings, `工具“${input.toolLabel}”调用失败：${input.message}`],
      errors: [...state.errors, input.message],
      failedTool: input.toolName,
    }))
    await this.appendLedger(
      input.callId,
      input.toolName,
      input.toolLabel,
      'failed',
      input.objectiveRevision,
      input.message,
    )
    await this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'tool_result',
      payload: {
        callId: input.callId,
        objectiveRevision: input.objectiveRevision,
        name: input.toolName,
        label: input.toolLabel,
        summary: input.message,
        content: input.message,
        contentRef: null,
        ledgerStatus: 'failed',
        resultId: null,
      },
    })
    const itemId = this.callItems.get(input.callId)
    if (itemId) {
      this.options.itemSink.completeItem(itemId, {
        callId: input.callId,
        name: input.toolName,
        isError: true,
        body: input.message,
        metadata: { toolLabel: input.toolLabel, objectiveRevision: input.objectiveRevision },
      })
    }
  }

  async recordPostCommitWarning(toolName: string, message: string): Promise<void> {
    const toolLabel = this.toolLabel(toolName)
    await this.options.store.mutateRunState(this.options.runId, state => ({
      warnings: [...state.warnings, `工具“${toolLabel}”已成功，但后续投影失败：${message}`],
    }))
    this.options.eventSink.emit('warning.raised', `工具结果投影失败：${message}`, {
      tool: toolName,
      toolLabel,
    })
  }

  toolOutputMetadata(callId: string): AgentToolOutputMetadata {
    const metadata = this.outputMetadata.get(callId)
    if (!metadata) throw new Error(`工具调用 '${callId}' 尚无可投影的输出元数据`)
    return metadata
  }

  private publishWorkflowControl(toolName: string): void {
    if (toolName !== 'submit_agent_workflow' && toolName !== 'revise_agent_workflow') return
    const workflow = this.options.store.getRun(this.options.runId).state.agentWorkflow
    if (!workflow) throw new Error('智能体工作流控制工具执行后没有写入工作流状态。')
    this.options.eventSink.emit(
      toolName === 'submit_agent_workflow' ? 'agent_workflow.created' : 'agent_workflow.revised',
      workflow.goal,
      {
        agentWorkflowId: workflow.agentWorkflowId,
        revision: workflow.revision,
        changeReason: workflow.changeReason,
      },
    )
  }

  private async appendToolResult(input: PublishToolSuccessInput): Promise<void> {
    const content = JSON.stringify({
      message: input.result.message,
      payload: input.result.payload,
      valueRefs: (input.result.valueRefs ?? []).map(ref => ({
        refId: ref.refId,
        kind: ref.kind,
        label: ref.label,
      })),
    })
    const appendResult = (
      contentRef: Awaited<ReturnType<ToolExecutionStore['putConversationObject']>> | null,
    ) => this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'tool_result',
      payload: {
        callId: input.callId,
        objectiveRevision: input.objectiveRevision,
        name: input.toolName,
        label: input.toolLabel,
        summary: input.result.message,
        content: contentRef ? null : content,
        contentRef,
        ledgerStatus: 'completed',
        resultId: input.result.resultId,
        valueRefIds: (input.result.valueRefs ?? []).map(reference => reference.refId),
        artifactIds: (input.result.artifacts ?? []).map(artifact => artifact.artifactId),
      },
    })
    if (content.length > this.options.inlineToolResultMaxChars) {
      await this.options.store.publishConversationObject(
        content,
        'application/json',
        reference => appendResult(reference),
      )
    } else {
      await appendResult(null)
    }
  }

  private appendLedger(
    callId: string,
    toolName: string,
    toolLabel: string,
    ledgerStatus: 'started' | 'failed',
    objectiveRevision: number,
    error?: string,
  ): Promise<unknown> {
    return this.options.store.appendTranscript({
      threadId: this.options.threadId,
      runId: this.options.runId,
      turnId: this.options.turnId,
      kind: 'checkpoint',
      payload: {
        callId,
        objectiveRevision,
        name: toolName,
        label: toolLabel,
        ledgerStatus,
        error: error ?? null,
      },
    })
  }

  private toolLabel(toolName: string): string {
    const tool = this.options.registry.get(toolName)
    if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
    return tool.label
  }
}

function objectiveRevisionFromPayload(payload: Record<string, unknown>, fallback: number): number {
  const value = payload.objectiveRevision
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback
}

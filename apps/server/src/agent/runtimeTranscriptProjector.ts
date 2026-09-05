// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行记录投影器
//
//   文件:       runtimeTranscriptProjector.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AgentInputItem, RunStreamEvent } from '@openai/agents'
import {
  agentToolOutputMetadataSchema,
  type AgentToolOutputMetadata,
} from '@geo-agent-platform/shared-types/runtime'

import type { ItemSink } from '../conversation/itemSink.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import type { RunEventSink } from './turnRunner.js'
import {
  extractReasoningDelta,
  isAssistantContentCheckpoint,
  parseArguments,
  sdkNativeLedgerStatus,
  toolResultText,
} from './runtimeSdkProjection.js'
import type { RuntimeAssembly, StreamProjectionState } from './runtimeTypes.js'

// SDK 流事件只在此处投影成 canonical transcript 与 ConversationItem。
export class RuntimeTranscriptProjector {
  constructor(
    private readonly store: AgentRuntimeStore,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  createState(): StreamProjectionState {
    return {
      assistantItemId: null,
      reasoningItemId: null,
      lastAssistantText: '',
      lastAssistantSdkItemId: null,
      completedAssistantItems: [],
      subAgentCallItemIds: new Map(),
    }
  }

  async projectStreamEvent(
    event: RunStreamEvent,
    projection: StreamProjectionState,
    assembly: RuntimeAssembly,
    eventSink: RunEventSink,
    itemSink: ItemSink,
  ): Promise<void> {
    if (event.type === 'raw_model_stream_event') {
      // Supervisor 使用 SDK 原生文本输出；模型正文增量可直接进入展示流。
      // 无文字的 Responses 事件允许 delta 为 null，只忽略该事件，不影响后续流式输出。
      if (event.data.type === 'output_text_delta' && event.data.delta) {
        if (!projection.assistantItemId) {
          projection.assistantItemId = itemSink.startItem('message', { role: 'assistant' }).itemId
        }
        itemSink.deltaItem(projection.assistantItemId, event.data.delta)
      }
      if (event.data.type === 'model') {
        const delta = extractReasoningDelta(event.data.event)
        if (delta) {
          if (!projection.reasoningItemId) {
            projection.reasoningItemId = itemSink.startItem('reasoning', { role: 'assistant' }).itemId
          }
          itemSink.deltaItem(projection.reasoningItemId, delta)
        }
      }
      return
    }
    // Agent 生命周期由 Runner 的 agent_start / agent_end / agent_handoff hooks
    // 统一投影；stream event 只负责模型内容和 run item，避免同一状态双写。
    if (event.type === 'agent_updated_stream_event') return
    if (event.name === 'message_output_created') {
      const raw = event.item.rawItem as AgentInputItem
      if (raw.type === 'message' && raw.role === 'assistant') {
        const content = raw.content
          .filter(part => part.type === 'output_text')
          .map(part => part.text)
          .join('')
        if (content) {
          projection.lastAssistantSdkItemId = raw.id ?? null
          if (!projection.assistantItemId) projection.lastAssistantText = content
        }
      }
      return
    }
    if (event.name === 'reasoning_item_created') {
      if (projection.reasoningItemId) {
        itemSink.completeItem(projection.reasoningItemId)
        projection.reasoningItemId = null
      }
      return
    }
    if (event.name === 'tool_called' || event.name === 'handoff_requested') {
      if (projection.assistantItemId || projection.lastAssistantText.trim()) {
        const itemId = projection.assistantItemId
          ?? itemSink.startItem('message', { role: 'assistant' }).itemId
        const completed = itemSink.completeItem(itemId, projection.assistantItemId
          ? {}
          : { body: projection.lastAssistantText })
        const text = completed.body ?? ''
        projection.completedAssistantItems.push({
          itemId,
          text,
          sdkItemId: projection.lastAssistantSdkItemId,
          entryId: null,
        })
        projection.assistantItemId = null
        projection.lastAssistantText = ''
        projection.lastAssistantSdkItemId = null
      }
      const raw = event.item.rawItem
      if (
        raw.type === 'function_call'
        && !this.isPlatformManagedTool(raw.name, assembly)
        && isSdkRejectedToolCall(raw.name, raw.callId, assembly)
      ) {
        const rejection = assembly.coordinator.formatUnavailableToolForModel(raw.name)
        await assembly.coordinator.recordSdkRejectedToolCall(
          raw.name,
          parseArguments(raw.arguments),
          raw.callId,
          rejection,
        )
        const transcript = await this.store.activeTranscript(assembly.threadId)
        const existing = transcript.find(entry => (
          entry.kind === 'tool_call' && entry.payload.callId === raw.callId
        ))
        if (!existing) {
          await this.appendSdkRejectedToolCallTranscript(
            assembly.context.runId,
            assembly.threadId,
            assembly.turnId,
            raw,
            itemSink,
            this.toolRegistry.get(raw.name)?.label ?? raw.name,
            assembly.context.currentObjectiveRevision(),
          )
        }
        eventSink.emit('tool.completed', '未开放的工具调用已拒绝', {
          sdkItemType: event.item.type,
          callId: raw.callId,
          status: 'rejected',
        })
        return
      }
      if (raw.type === 'hosted_tool_call') {
        await this.appendSdkHostedToolCallCheckpoint(
          assembly.context.runId,
          assembly.threadId,
          assembly.turnId,
          raw,
          itemSink,
          sdkToolPresentation(raw.name, assembly),
          assembly.context.currentObjectiveRevision(),
        )
      } else if (raw.type === 'function_call' && assembly.subAgentToolNames.has(raw.name)) {
        const entries = await this.store.activeTranscript(assembly.threadId)
        const existingToolCall = entries
          .find(entry => entry.kind === 'tool_call' && entry.payload.callId === raw.callId)
        const objectiveRevision = existingToolCall
          ? objectiveRevisionFromPayload(existingToolCall.payload, 1)
          : assembly.context.currentObjectiveRevision()
        if (!existingToolCall) {
          const parsedArgs = parseArguments(raw.arguments)
          await this.store.appendTranscript({
            threadId: assembly.threadId,
            runId: assembly.context.runId,
            turnId: assembly.turnId,
            kind: 'tool_call',
            payload: {
              callId: raw.callId,
              name: raw.name,
              label: '子智能体任务',
              arguments: parsedArgs,
              ledgerStatus: 'started',
              objectiveRevision,
            },
          })
        }
        if (!projection.subAgentCallItemIds.has(raw.callId)) {
          const item = itemSink.startItem('function_call', {
            name: raw.name,
            callId: raw.callId,
            arguments: raw.arguments,
            metadata: { toolLabel: '子智能体任务', objectiveRevision },
          })
          projection.subAgentCallItemIds.set(raw.callId, item.itemId)
        }
      } else if (
        raw.type === 'function_call'
        && !this.isPlatformManagedTool(raw.name, assembly)
      ) {
        const exists = (await this.store.activeTranscript(assembly.threadId))
          .some(entry => entry.kind === 'tool_call' && entry.payload.callId === raw.callId)
        if (!exists) {
          await this.appendSdkNativeToolCallTranscript(
            assembly.context.runId,
            assembly.threadId,
            assembly.turnId,
            raw,
            itemSink,
            sdkToolPresentation(raw.name, assembly),
            assembly.context.currentObjectiveRevision(),
          )
        }
      }
      if (raw.type === 'hosted_tool_call') {
        await this.persistCompletedAssistantEntriesForToolCall(
          assembly,
          projection,
          itemSink,
          null,
        )
      }
      if (raw.type === 'function_call' && !this.isPlatformManagedTool(raw.name, assembly)) {
        await assembly.coordinator.markSdkToolCallPending(
          raw.name,
          parseArguments(raw.arguments),
          raw.callId,
        )
      }
      const eventLabel = raw.type === 'function_call'
        ? assembly.subAgentToolNames.has(raw.name)
          ? '子智能体任务'
          : assembly.handoffToolNames.has(raw.name)
            ? 'Handoff 转交'
            : '工具调用'
        : raw.type === 'hosted_tool_call'
          ? sdkToolPresentation(raw.name, assembly).label
        : '工具调用'
      eventSink.emit(
        raw.type === 'hosted_tool_call' && raw.status === 'completed'
          ? 'tool.completed'
          : 'tool.started',
        eventLabel,
        { sdkItemType: event.item.type },
      )
      return
    }
    if (event.name === 'tool_output' || event.name === 'handoff_occurred') {
      const raw = event.item.rawItem
      if (raw.type === 'function_call_result') {
        // 工具 prepare/result 已进入平台账本后，公开 tool_output 才是把同一
        // 模型响应中的 assistant 前导正文绑定到 callId 的稳定时点。
        await this.persistCompletedAssistantEntriesForToolCall(
          assembly,
          projection,
          itemSink,
          raw.callId,
        )
      }
      if (
        raw.type === 'function_call_result'
        && !this.isPlatformManagedTool(raw.name, assembly)
        && isSdkRejectedToolCall(raw.name, raw.callId, assembly)
      ) {
        const content = toolResultText(raw.output)
        const transcript = await this.store.activeTranscript(assembly.threadId)
        const objectiveRevision = objectiveRevisionForCall(transcript, raw.callId)
        const exists = transcript.some(entry => (
          entry.kind === 'tool_result' && entry.payload.callId === raw.callId
        ))
        if (!exists) {
          await this.store.appendTranscript({
            threadId: assembly.threadId,
            runId: assembly.context.runId,
            turnId: assembly.turnId,
            kind: 'tool_result',
            payload: {
              callId: raw.callId,
              name: raw.name,
              label: this.toolRegistry.get(raw.name)?.label ?? raw.name,
              summary: content,
              content,
              contentRef: null,
              ledgerStatus: 'rejected',
              resultId: null,
              source: 'openai_agents_sdk',
              objectiveRevision,
            },
          })
        }
        await assembly.coordinator.markSdkToolCallTerminal({
          callId: raw.callId,
          outcome: 'rejected',
          resultId: null,
          error: content,
        })
        return
      }
      const metadata = event.item.type === 'tool_call_output_item'
        && raw.type === 'function_call_result'
        ? parseOutputMetadata(
            event.item.customData,
            this.isPlatformManagedTool(raw.name, assembly)
              || assembly.subAgentToolNames.has(raw.name)
              || assembly.mcpToolNames.has(raw.name),
          )
        : null
      if (raw.type === 'function_call_result' && assembly.subAgentToolNames.has(raw.name)) {
        const entries = await this.store.activeTranscript(assembly.threadId)
        const objectiveRevision = objectiveRevisionForCall(
          entries,
          raw.callId,
        )
        const failed = raw.status === 'incomplete'
        const itemId = projection.subAgentCallItemIds.get(raw.callId)
        if (itemId) {
          itemSink.completeItem(itemId, {
            name: raw.name,
            callId: raw.callId,
            body: failed ? '子智能体执行失败' : '子智能体已返回结果',
            isError: failed,
            metadata: { toolLabel: '子智能体任务', objectiveRevision },
          })
          projection.subAgentCallItemIds.delete(raw.callId)
        }
        eventSink.emit('tool.completed', failed ? '子智能体执行失败' : '子智能体任务完成', {
          sdkItemType: event.item.type,
          callId: raw.callId,
          agentId: raw.name,
          status: failed ? 'failed' : 'completed',
          objectiveRevision,
        })
      }
      if (
        raw.type === 'function_call_result'
        && (
          assembly.subAgentToolNames.has(raw.name)
          || !this.isPlatformManagedTool(raw.name, assembly)
        )
      ) {
        const transcript = await this.store.activeTranscript(assembly.threadId)
        const objectiveRevision = objectiveRevisionForCall(
          transcript,
          raw.callId,
        )
        const exists = transcript.some(entry => (
          entry.kind === 'tool_result' && entry.payload.callId === raw.callId
        ))
        if (!exists) {
          const presentation = sdkToolPresentation(raw.name, assembly)
          const content = toolResultText(raw.output)
          const ledgerStatus = sdkNativeLedgerStatus(raw.status)
          await this.store.appendTranscript({
            threadId: assembly.threadId,
            runId: assembly.context.runId,
            turnId: assembly.turnId,
            kind: 'tool_result',
            payload: {
              callId: raw.callId,
              name: raw.name,
              label: metadata?.display?.label ?? presentation.label,
              summary: metadata?.display?.summary ?? content,
              content,
              contentRef: null,
              ledgerStatus,
              resultId: metadata?.resultId ?? null,
              valueRefIds: metadata?.valueRefIds ?? [],
              artifactIds: metadata?.artifactIds ?? [],
              source: metadata?.display?.source ?? presentation.source,
              objectiveRevision,
            },
          })
          if (!assembly.subAgentToolNames.has(raw.name)) {
            const outputItem = itemSink.startItem('function_call_output', {
              callId: raw.callId,
              name: raw.name,
              role: 'tool',
              metadata: {
                toolLabel: metadata?.display?.label ?? presentation.label,
                source: metadata?.display?.source ?? presentation.source,
                objectiveRevision,
              },
            })
            itemSink.completeItem(outputItem.itemId, {
              callId: raw.callId,
              name: raw.name,
              output: content,
              isError: ledgerStatus === 'failed',
              metadata: {
                toolLabel: metadata?.display?.label ?? presentation.label,
                source: metadata?.display?.source ?? presentation.source,
                resultId: metadata?.resultId ?? null,
                valueRefIds: metadata?.valueRefIds ?? [],
                artifactIds: metadata?.artifactIds ?? [],
                objectiveRevision,
              },
            })
          }
        }
      }
      if (raw.type === 'function_call_result') {
        const content = toolResultText(raw.output)
        await assembly.coordinator.markSdkToolCallTerminal({
          callId: raw.callId,
          outcome: raw.status === 'incomplete' ? 'failed' : 'succeeded',
          resultId: metadata?.resultId ?? null,
          error: raw.status === 'incomplete' ? content : null,
        })
      }
      return
    }
    if (event.name === 'tool_approval_requested') {
      eventSink.emit('approval.required', '工具调用等待审批', {})
    }
  }

  async linkAssistantTranscriptEntries(
    runId: string,
    assembly: RuntimeAssembly,
    projection: StreamProjectionState,
    itemSink: ItemSink,
  ): Promise<void> {
    if (!projection.completedAssistantItems.length) return
    if (projection.completedAssistantItems.every(item => item.entryId)) return
    const entries = (await this.store.activeTranscript(assembly.threadId)).filter(entry => (
      entry.runId === runId && entry.turnId === assembly.turnId
    ))
    const assistantMessages = entries.filter(entry => (
      entry.kind === 'message' && entry.payload.role === 'assistant'
    ))
    const assistantToolContent = entries.filter(isAssistantContentCheckpoint)
    for (const projected of projection.completedAssistantItems) {
      const messageIndex = assistantMessages.findIndex(entry => entry.payload.content === projected.text)
      if (messageIndex >= 0) {
        const [entry] = assistantMessages.splice(messageIndex, 1)
        if (!entry) throw new Error('SDK Session assistant 消息索引失效')
        itemSink.completeItem(projected.itemId, {
          body: projected.text,
          metadata: { transcriptEntryId: entry.entryId },
        })
        projected.entryId = entry.entryId
        continue
      }
      const checkpointIndex = assistantToolContent.findIndex(entry => entry.payload.content === projected.text)
      if (checkpointIndex < 0) throw new Error('SDK Session 未持久化全部 assistant 可见正文')
      const [entry] = assistantToolContent.splice(checkpointIndex, 1)
      if (!entry) throw new Error('SDK Session assistant checkpoint 索引失效')
      itemSink.completeItem(projected.itemId, {
        body: projected.text,
        metadata: {
          transcriptEntryId: entry.entryId,
          assistantContentForCallId: entry.payload.callId,
        },
      })
      projected.entryId = entry.entryId
    }
  }

  private async persistCompletedAssistantEntriesForToolCall(
    assembly: RuntimeAssembly,
    projection: StreamProjectionState,
    itemSink: ItemSink,
    callId: string | null,
  ): Promise<void> {
    const unresolved = projection.completedAssistantItems.filter(item => !item.entryId)
    for (const [index, projected] of unresolved.entries()) {
      const attachesToTool = callId !== null && index === unresolved.length - 1
      const entry = attachesToTool
        ? await this.appendAssistantContentCheckpoint(
            assembly,
            callId,
            projected.text,
            projected.sdkItemId,
          )
        : await this.appendAssistantMessageTranscript(assembly, projected.text, {
            itemId: projected.itemId,
            sdkItemId: projected.sdkItemId,
          })
      itemSink.completeItem(projected.itemId, {
        body: projected.text,
        metadata: {
          transcriptEntryId: entry.entryId,
          ...(attachesToTool ? { assistantContentForCallId: callId } : {}),
        },
      })
      projected.entryId = entry.entryId
    }
  }

  isPlatformManagedTool(toolName: string, assembly: RuntimeAssembly): boolean {
    return Boolean(this.toolRegistry.get(toolName))
      || assembly.subAgentToolNames.has(toolName)
  }

  failPendingSubAgentItems(
    projection: StreamProjectionState,
    itemSink: ItemSink,
    message: string,
  ): void {
    for (const [callId, itemId] of projection.subAgentCallItemIds) {
      itemSink.completeItem(itemId, {
        callId,
        body: message,
        isError: true,
        metadata: { toolLabel: '子智能体任务' },
      })
    }
    projection.subAgentCallItemIds.clear()
  }

  async appendSdkNativeToolCallTranscript(
    runId: string,
    threadId: string,
    turnId: string,
    item: Extract<AgentInputItem, { type: 'function_call' }>,
    itemSink: ItemSink,
    presentation: { label: string; source: string },
    objectiveRevision = 1,
  ): Promise<void> {
    const args = parseArguments(item.arguments)
    const sdkStatus = item.status ?? 'completed'
    await this.store.appendTranscript({
      threadId,
      runId,
      turnId,
      kind: 'tool_call',
      payload: {
        callId: item.callId,
        name: item.name,
        label: presentation.label,
        arguments: args,
        ledgerStatus: 'started',
        source: presentation.source,
        objectiveRevision,
      },
    })
    const callItem = itemSink.startItem('function_call', {
      name: item.name,
      callId: item.callId,
      arguments: item.arguments,
      metadata: { toolLabel: presentation.label, source: presentation.source, objectiveRevision },
    })
    itemSink.completeItem(callItem.itemId, {
      name: item.name,
      callId: item.callId,
      body: sdkStatus === 'incomplete' ? `${presentation.label}未完成` : `${presentation.label}已发起`,
      isError: item.status === 'incomplete',
      metadata: { toolLabel: presentation.label, source: presentation.source, objectiveRevision },
    })
  }

  async appendSdkHostedToolCallCheckpoint(
    runId: string,
    threadId: string,
    turnId: string,
    item: Extract<AgentInputItem, { type: 'hosted_tool_call' }>,
    itemSink: ItemSink,
    presentation: { label: string; source: string },
    objectiveRevision = 1,
  ): Promise<void> {
    if (!item.id) throw new Error(`SDK 服务端工具 '${item.name}' 缺少响应项 ID`)
    const entries = await this.store.activeTranscript(threadId)
    const exists = entries.some(entry => (
      entry.kind === 'checkpoint'
      && entry.payload.type === 'sdk_hosted_tool_call'
      && entry.payload.itemId === item.id
    ))
    if (exists) return

    const argumentsText = item.arguments ?? JSON.stringify(item.providerData ?? {})
    await this.store.appendTranscript({
      threadId,
      runId,
      turnId,
      kind: 'checkpoint',
      payload: {
        type: 'sdk_hosted_tool_call',
        itemId: item.id,
        name: item.name,
        label: presentation.label,
        arguments: argumentsText,
        status: item.status ?? 'completed',
        source: presentation.source,
        objectiveRevision,
      },
    })
    const callItem = itemSink.startItem('function_call', {
      name: item.name,
      callId: item.id,
      arguments: argumentsText,
      metadata: {
        toolLabel: presentation.label,
        source: presentation.source,
        sdkItemType: 'hosted_tool_call',
        objectiveRevision,
      },
    })
    itemSink.completeItem(callItem.itemId, {
      name: item.name,
      callId: item.id,
      body: item.status === 'failed'
        ? `${presentation.label}失败`
        : `${presentation.label}已执行`,
      isError: item.status === 'failed',
      metadata: {
        toolLabel: presentation.label,
        source: presentation.source,
        sdkItemType: 'hosted_tool_call',
        objectiveRevision,
      },
    })
  }

  async appendSdkRejectedToolCallTranscript(
    runId: string,
    threadId: string,
    turnId: string,
    item: Extract<AgentInputItem, { type: 'function_call' }>,
    itemSink: ItemSink,
    label: string,
    objectiveRevision = 1,
  ): Promise<void> {
    await this.store.appendTranscript({
      threadId,
      runId,
      turnId,
      kind: 'tool_call',
      payload: {
        callId: item.callId,
        name: item.name,
        label,
        arguments: parseArguments(item.arguments),
        ledgerStatus: 'rejected',
        source: 'openai_agents_sdk',
        objectiveRevision,
      },
    })
    const callItem = itemSink.startItem('function_call', {
      name: item.name,
      callId: item.callId,
      arguments: item.arguments,
      metadata: { toolLabel: label, source: 'openai_agents_sdk', objectiveRevision },
    })
    itemSink.completeItem(callItem.itemId, {
      name: item.name,
      callId: item.callId,
      body: `${label}未在当前运行阶段开放`,
      isError: true,
      metadata: {
        toolLabel: label,
        source: 'openai_agents_sdk',
        rejectedBy: 'tool_not_found',
        objectiveRevision,
      },
    })
  }

  appendAssistantMessageTranscript(
    assembly: RuntimeAssembly,
    content: string,
    options: {
      itemId?: string | null
      sdkItemId?: string | null
      objectiveRevision?: number
    } = {},
  ) {
    const objectiveRevision = options.objectiveRevision
      ?? assembly.context.currentObjectiveRevision()
    return this.store.appendTranscript({
      threadId: assembly.threadId,
      runId: assembly.context.runId,
      turnId: assembly.turnId,
      kind: 'message',
      payload: {
        role: 'assistant',
        content,
        ...(options.itemId ? { itemId: options.itemId } : {}),
        ...(options.sdkItemId ? { sdkItemId: options.sdkItemId } : {}),
        objectiveRevision,
      },
    })
  }

  async appendAssistantContentCheckpoint(
    assembly: RuntimeAssembly,
    callId: string,
    content: string,
    sdkItemId: string | null = null,
  ) {
    const entries = await this.store.activeTranscript(assembly.threadId)
    const toolCall = entries.find(entry => entry.kind === 'tool_call' && entry.payload.callId === callId)
    if (!toolCall) throw new Error(`SDK Session 收到未准备的工具调用 '${callId}'`)
    const objectiveRevision = objectiveRevisionFromPayload(
      toolCall.payload,
      1,
    )
    const existingContent = typeof toolCall.payload.assistantContent === 'string' && toolCall.payload.assistantContent.trim()
      ? toolCall.payload.assistantContent.trim()
      : null
    if (existingContent && existingContent !== content) {
      throw new Error(`工具调用 '${callId}' 的 assistant 前导正文不一致`)
    }
    const existingCheckpoint = entries.find(entry => (
      isAssistantContentCheckpoint(entry) && entry.payload.callId === callId
    ))
    if (existingCheckpoint) {
      if (existingCheckpoint.payload.content !== content) {
        throw new Error(`工具调用 '${callId}' 的 assistant 前导正文 checkpoint 不一致`)
      }
      if (
        sdkItemId
        && existingCheckpoint.payload.sdkItemId
        && existingCheckpoint.payload.sdkItemId !== sdkItemId
      ) {
        throw new Error(`工具调用 '${callId}' 的 assistant SDK item 不一致`)
      }
      return existingCheckpoint
    }
    return this.store.appendTranscript({
      threadId: assembly.threadId,
      runId: assembly.context.runId,
      turnId: assembly.turnId,
      kind: 'checkpoint',
      payload: {
        type: 'assistant_content_for_tool_call',
        callId,
        content,
        ...(sdkItemId ? { sdkItemId } : {}),
        source: 'openai_agents_stream',
        objectiveRevision,
      },
    })
  }
}

function objectiveRevisionForCall(
  entries: ReadonlyArray<{ kind: string; payload: Record<string, unknown> }>,
  callId: string,
): number {
  const toolCall = entries.find(entry => entry.kind === 'tool_call' && entry.payload.callId === callId)
  if (!toolCall) throw new Error(`SDK 工具结果 '${callId}' 缺少 canonical tool_call`)
  return objectiveRevisionFromPayload(toolCall.payload, 1)
}

function objectiveRevisionFromPayload(payload: Record<string, unknown>, fallback: number): number {
  const value = payload.objectiveRevision
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback
}

function parseOutputMetadata(
  value: unknown,
  requiredPlatformContract: boolean,
): AgentToolOutputMetadata | null {
  if (value === undefined) return null
  const parsed = agentToolOutputMetadataSchema.safeParse(value)
  if (!parsed.success) {
    if (requiredPlatformContract) {
      throw new Error('Agents SDK 工具输出 customData 不符合平台契约')
    }
    return null
  }
  return parsed.data
}

function sdkToolPresentation(
  toolName: string,
  assembly: RuntimeAssembly,
): { label: string; source: string } {
  if (assembly.hostedToolNames.has(toolName) || toolName === 'web_search_call') {
    return { label: '联网搜索', source: 'openai_agents_hosted_web_search' }
  }
  if (assembly.handoffToolNames.has(toolName)) {
    return { label: 'Handoff 转交', source: 'openai_agents_handoff' }
  }
  if (assembly.mcpToolNames.has(toolName)) {
    return { label: 'MCP 工具调用', source: 'openai_agents_mcp' }
  }
  if (assembly.subAgentToolNames.has(toolName)) {
    return { label: '子智能体任务', source: 'openai_agents_agent_as_tool' }
  }
  return { label: '沙箱工具调用', source: 'openai_agents_sandbox' }
}

function isSdkRejectedToolCall(
  toolName: string,
  callId: string,
  assembly: RuntimeAssembly,
): boolean {
  if (assembly.isUnavailableSdkToolCall(callId)) return true
  return !assembly.subAgentToolNames.has(toolName)
    && !assembly.handoffToolNames.has(toolName)
    && !assembly.mcpToolNames.has(toolName)
    && !assembly.sandboxToolNames.has(toolName)
}

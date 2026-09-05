import type { RunStreamEvent } from '@openai/agents'
import { describe, expect, it, vi } from 'vitest'

import { ItemSink } from '../conversation/itemSink.js'
import { ToolRegistry } from '../framework/registry.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import { RuntimeTranscriptProjector } from './runtimeTranscriptProjector.js'
import type { RuntimeAssembly } from './runtimeTypes.js'
import { RunEventSink } from './turnRunner.js'

describe('RuntimeTranscriptProjector objective revision lineage', () => {
  it('attributes a legacy tool result to revision 1 instead of the current model revision', async () => {
    const writes: Array<Record<string, unknown>> = []
    const store = projectorStore([{
      kind: 'tool_call',
      payload: { callId: 'call_legacy', name: 'sdk_native', ledgerStatus: 'started' },
    }], writes)
    const coordinator = {
      markSdkToolCallTerminal: vi.fn(async () => undefined),
    }
    const projector = new RuntimeTranscriptProjector(store, new ToolRegistry())
    const items = new ItemSink(async () => undefined, 'run_1', 'thread_1', 'turn_1')

    await projector.projectStreamEvent(
      toolOutputEvent('call_legacy'),
      projector.createState(),
      projectorAssembly(coordinator),
      new RunEventSink(async () => undefined, 'run_1', 'thread_1'),
      items,
    )

    expect(writes).toContainEqual(expect.objectContaining({
      kind: 'tool_result',
      payload: expect.objectContaining({
        callId: 'call_legacy',
        objectiveRevision: 1,
      }),
    }))
    expect(coordinator.markSdkToolCallTerminal).toHaveBeenCalledWith({
      callId: 'call_legacy',
      outcome: 'succeeded',
      resultId: null,
      error: null,
    })
  })

  it('rejects an SDK result that has no canonical tool_call lineage', async () => {
    const writes: Array<Record<string, unknown>> = []
    const store = projectorStore([], writes)
    const coordinator = {
      markSdkToolCallTerminal: vi.fn(async () => undefined),
    }
    const projector = new RuntimeTranscriptProjector(store, new ToolRegistry())

    await expect(projector.projectStreamEvent(
      toolOutputEvent('call_orphan'),
      projector.createState(),
      projectorAssembly(coordinator),
      new RunEventSink(async () => undefined, 'run_1', 'thread_1'),
      new ItemSink(async () => undefined, 'run_1', 'thread_1', 'turn_1'),
    )).rejects.toThrow("SDK 工具结果 'call_orphan' 缺少 canonical tool_call")
    expect(writes).toEqual([])
    expect(coordinator.markSdkToolCallTerminal).not.toHaveBeenCalled()
  })

  it('replays a legacy subagent call item with revision 1 metadata', async () => {
    const writes: Array<Record<string, unknown>> = []
    const store = projectorStore([{
      kind: 'tool_call',
      payload: { callId: 'call_subagent_legacy', name: 'spatial_agent', ledgerStatus: 'started' },
    }], writes)
    const projector = new RuntimeTranscriptProjector(store, new ToolRegistry())
    const itemUpdates: Array<Record<string, unknown>> = []
    const itemSink = new ItemSink(update => { itemUpdates.push(update) }, 'run_1', 'thread_1', 'turn_1')
    const assembly = projectorAssembly({
      markSdkToolCallTerminal: vi.fn(async () => undefined),
      markSdkToolCallPending: vi.fn(async () => undefined),
    })
    assembly.subAgentToolNames.add('spatial_agent')

    await projector.projectStreamEvent(
      subAgentCallEvent(),
      projector.createState(),
      assembly,
      new RunEventSink(async () => undefined, 'run_1', 'thread_1'),
      itemSink,
    )
    await itemSink.flush()

    expect(writes).toEqual([])
    expect(itemUpdates).toContainEqual(expect.objectContaining({
      item: expect.objectContaining({
        callId: 'call_subagent_legacy',
        metadata: expect.objectContaining({ objectiveRevision: 1 }),
      }),
    }))
  })
})

function projectorStore(
  entries: Array<{ kind: string; payload: Record<string, unknown> }>,
  writes: Array<Record<string, unknown>>,
): AgentRuntimeStore {
  return {
    activeTranscript: vi.fn(async () => entries),
    appendTranscript: vi.fn(async input => {
      writes.push(input)
      return { entryId: `entry_${writes.length}` }
    }),
  } as unknown as AgentRuntimeStore
}

function projectorAssembly(coordinator: {
  markSdkToolCallTerminal(input: {
    callId: string
    outcome: 'succeeded' | 'failed' | 'rejected' | 'aborted'
    resultId: string | null
    error: string | null
  }): Promise<void>
  markSdkToolCallPending?(toolName: string, args: Record<string, unknown>, callId: string): Promise<void>
}): RuntimeAssembly {
  return {
    threadId: 'thread_1',
    turnId: 'turn_1',
    context: {
      runId: 'run_1',
      currentObjectiveRevision: () => 2,
    },
    coordinator,
    isUnavailableSdkToolCall: () => false,
    subAgentToolNames: new Set<string>(),
    hostedToolNames: new Set<string>(),
    handoffToolNames: new Set<string>(),
    mcpToolNames: new Set<string>(),
    sandboxToolNames: new Set<string>(['sdk_native']),
  } as unknown as RuntimeAssembly
}

function subAgentCallEvent(): RunStreamEvent {
  return {
    type: 'run_item_stream_event',
    name: 'tool_called',
    item: {
      type: 'tool_call_item',
      rawItem: {
        type: 'function_call',
        name: 'spatial_agent',
        callId: 'call_subagent_legacy',
        arguments: '{}',
      },
    },
  } as unknown as RunStreamEvent
}

function toolOutputEvent(callId: string): RunStreamEvent {
  return {
    type: 'run_item_stream_event',
    name: 'tool_output',
    item: {
      type: 'tool_call_output_item',
      rawItem: {
        type: 'function_call_result',
        name: 'sdk_native',
        callId,
        output: 'ok',
        status: 'completed',
      },
    },
  } as unknown as RunStreamEvent
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 统一上下文协议单元测试
//
//   文件:       ContextUnit.test.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AgentInputItem } from '@openai/agents'
import type { TranscriptEntry } from '../../schemas/types.js'
import { describe, expect, it } from 'vitest'
import {
  buildAgentInputContextUnits,
  buildTranscriptContextUnits,
  contextUnitSourceDigest,
  dropOldestCompactableTranscriptGroup,
  flattenContextUnits,
  selectContextCompactionSlice,
} from './ContextUnit.js'

describe('ContextUnit', () => {
  it('keeps reasoning, parallel calls, results, and the assistant response in one turn group', () => {
    const oldTurn: AgentInputItem[] = [
      { type: 'message', role: 'user', content: '旧问题' },
      { type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: '核对两个图层' }] },
      { type: 'function_call', callId: 'call_a', name: 'read_layer', arguments: '{}', status: 'completed' },
      { type: 'function_call', callId: 'call_b', name: 'read_layer', arguments: '{}', status: 'completed' },
      { type: 'function_call_result', callId: 'call_a', name: 'read_layer', output: 'A', status: 'completed' },
      { type: 'function_call_result', callId: 'call_b', name: 'read_layer', output: 'B', status: 'completed' },
      { type: 'message', role: 'assistant', content: '旧问题已完成。', status: 'completed' },
    ]
    const current: AgentInputItem = { type: 'message', role: 'user', content: '当前问题' }
    const slice = selectContextCompactionSlice(
      buildAgentInputContextUnits([...oldTurn, current]),
      1,
    )

    expect(flattenContextUnits(slice.sourceUnits)).toEqual(oldTurn)
    expect(flattenContextUnits(slice.preservedUnits)).toEqual([current])
    expect(slice.sourceUnits.every(unit => unit.complete)).toBe(true)
    expect(new Set(slice.sourceUnits.map(unit => unit.groupId)).size).toBe(1)
  })

  it('preserves an unresolved call without pinning the preceding complete turn', () => {
    const unresolved: AgentInputItem = {
      type: 'function_call',
      callId: 'call_pending',
      name: 'query_layer',
      arguments: '{}',
      status: 'completed',
    }
    const slice = selectContextCompactionSlice(buildAgentInputContextUnits([
      { type: 'message', role: 'user', content: '旧问题' },
      { type: 'message', role: 'assistant', content: '旧答案', status: 'completed' },
      unresolved,
      { type: 'message', role: 'user', content: '当前问题' },
    ]), 1)

    expect(flattenContextUnits(slice.sourceUnits).map(item => item.type)).toEqual(['message', 'message'])
    expect(flattenContextUnits(slice.preservedUnits)).toContain(unresolved)
    expect(slice.preservedUnits.some(unit => !unit.complete && unit.mandatory)).toBe(true)
  })

  it('derives an idempotent digest from canonical unit content', () => {
    const left = buildAgentInputContextUnits([
      { type: 'message', role: 'user', content: '旧问题', providerData: { b: 2, a: 1 } },
      { type: 'message', role: 'assistant', content: '旧答案', status: 'completed' },
      { type: 'message', role: 'user', content: '当前问题' },
    ])
    const right = buildAgentInputContextUnits([
      { type: 'message', role: 'user', content: '旧问题', providerData: { a: 1, b: 2 } },
      { type: 'message', role: 'assistant', content: '旧答案', status: 'completed' },
      { type: 'message', role: 'user', content: '当前问题' },
    ])
    const leftSource = selectContextCompactionSlice(left, 1).sourceUnits
    const rightSource = selectContextCompactionSlice(right, 1).sourceUnits

    expect(contextUnitSourceDigest(leftSource)).toBe(contextUnitSourceDigest(rightSource))
  })

  it('drops a complete old transcript turn and never leaves an orphan tool result', () => {
    const entries = [
      transcript(1, 'message', { role: 'user', content: '旧问题' }),
      transcript(2, 'tool_call', { callId: 'call_old', name: 'query', arguments: '{}' }),
      transcript(3, 'tool_result', { callId: 'call_old', name: 'query', content: '结果' }),
      transcript(4, 'message', { role: 'assistant', content: '旧答案' }),
      transcript(5, 'message', { role: 'user', content: '当前问题' }),
      transcript(6, 'message', { role: 'assistant', content: '当前答案' }),
    ]

    expect(buildTranscriptContextUnits(entries).filter(unit => unit.kind === 'tool_exchange'))
      .toEqual([expect.objectContaining({ complete: true })])
    expect(dropOldestCompactableTranscriptGroup(entries, 1)?.map(entry => entry.entryId))
      .toEqual(['entry_5', 'entry_6'])
  })
})

function transcript(
  seq: number,
  kind: TranscriptEntry['kind'],
  payload: Record<string, unknown>,
): TranscriptEntry {
  return {
    schemaVersion: 2,
    seq,
    entryId: `entry_${seq}`,
    parentEntryId: seq === 1 ? null : `entry_${seq - 1}`,
    logicalParentEntryId: null,
    threadId: 'thread_context_unit',
    runId: 'run_context_unit',
    turnId: 'turn_context_unit',
    kind,
    timestamp: `2026-08-24T00:00:0${seq}.000Z`,
    payload,
  }
}

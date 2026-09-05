// +-------------------------------------------------------------------------
//
//   地理智能平台 - ConversationItem 跨端展示投影测试
//
//   文件:       presentation.test.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ConversationItem, ToolDescriptor } from '@geo-agent-platform/shared-types'
import { describe, expect, it } from 'vitest'

import { deriveEntriesFromItems } from './presentation.js'

describe('cross-client conversation presentation', () => {
  it('pairs tool input and output even when the transport array is out of order', () => {
    const entries = deriveEntriesFromItems([
      item({
        itemId: 'output',
        itemType: 'function_call_output',
        callId: 'call_1',
        output: '{"summary":"杭州未来一小时有阵雨。"}',
      }),
      item({
        itemId: 'call',
        itemType: 'function_call',
        callId: 'call_1',
        name: 'query_public_weather',
        arguments: '{"location":"杭州"}',
      }),
    ], 'completed', [tool()])

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: 'command_batch',
      title: '查询公开天气',
      status: 'completed',
      body: '杭州未来一小时有阵雨。',
    })
    expect(entries[0]?.commands?.[0]).toMatchObject({
      toolName: 'query_public_weather',
      displayIdentifier: 'query_public_weather',
      commandText: '{"location":"杭州"}',
    })
  })

  it('does not expose an unknown machine identifier as display metadata', () => {
    const entries = deriveEntriesFromItems([
      item({
        itemType: 'function_call',
        callId: 'call_unknown',
        name: 'private_machine_identifier',
      }),
    ])

    expect(entries[0]?.title).toBe('工具调用')
    expect(entries[0]?.commands?.[0]?.displayIdentifier).toBeNull()
  })

  it('uses the persisted failure source instead of blaming the selected model route', () => {
    const entries = deriveEntriesFromItems([
      item({
        itemType: 'result',
        status: 'failed',
        isError: true,
        metadata: {
          resultType: 'failed',
          message: '数据库函数不存在。',
          failure: {
            source: 'database',
            message: '数据库函数不存在。',
            code: '42883',
            retryable: false,
          },
        },
      }),
    ], 'failed')

    expect(entries[0]).toMatchObject({
      kind: 'error',
      title: '数据库处理失败',
      body: '数据库函数不存在。',
    })
  })
})

function item(overrides: Partial<ConversationItem>): ConversationItem {
  return {
    itemId: overrides.itemId ?? 'item_1',
    itemType: overrides.itemType ?? 'message',
    runId: 'run_1',
    threadId: 'thread_1',
    turnId: 'turn_1',
    callId: overrides.callId ?? null,
    role: overrides.role ?? null,
    body: overrides.body ?? null,
    name: overrides.name ?? null,
    arguments: overrides.arguments ?? null,
    output: overrides.output ?? null,
    isError: overrides.isError ?? false,
    phase: overrides.phase ?? null,
    status: overrides.status ?? 'completed',
    metadata: overrides.metadata ?? {},
    timestamp: overrides.timestamp ?? '2026-07-27T00:00:00.000Z',
  }
}

function tool(): ToolDescriptor {
  return {
    name: 'query_public_weather',
    label: '查询公开天气',
    description: '',
    group: 'weather',
    toolKind: 'registry',
    providerId: 'public-weather',
    language: 'typescript',
    isReadOnly: true,
    isDestructive: false,
    parallelSafe: true,
    available: true,
    tags: [],
    parameters: [],
    error: null,
    meta: {},
  }
}

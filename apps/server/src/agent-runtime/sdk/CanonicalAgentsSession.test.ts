// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK canonical replay Session 测试
//
//   文件:       CanonicalAgentsSession.test.ts
//
//   日期:       2026年06月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// CanonicalAgentsSession 只拥有 SDK replay history；observer 不写平台事实。
// provider reasoning 只服务当前 run 的 UI 回放，不能成为后续模型历史。

import type { AgentInputItem } from '@openai/agents'
import { describe, expect, it } from 'vitest'
import { CanonicalAgentsSession } from './CanonicalAgentsSession.js'

describe('CanonicalAgentsSession', () => {
  it('serializes concurrent SDK persistence callbacks in invocation order', async () => {
    const projected: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    let firstStarted!: () => void
    const firstStartedPromise = new Promise<void>(resolve => {
      firstStarted = resolve
    })
    const session = new CanonicalAgentsSession('test-session', [], async items => {
      const item = items[0]
      if (!item || item.type !== 'function_call') throw new Error('测试项类型错误')
      projected.push(item.callId)
      if (item.callId === 'call_1') {
        firstStarted()
        await firstBlocked
      }
    })
    const call = (callId: string): AgentInputItem => ({
      type: 'function_call',
      name: 'query_layer',
      callId,
      arguments: '{}',
      status: 'completed',
    })

    const first = session.addItems([call('call_1')])
    await firstStartedPromise
    const second = session.addItems([call('call_2')])
    await Promise.resolve()
    expect(projected).toEqual(['call_1'])
    releaseFirst()
    await Promise.all([first, second])

    expect(projected).toEqual(['call_1', 'call_2'])
    expect((await session.getItems()).map(item => 'callId' in item ? item.callId : null))
      .toEqual(['call_1', 'call_2'])
  })

  it('does not persist provider reasoning as replayable session history', async () => {
    const projected: AgentInputItem[][] = []
    const session = new CanonicalAgentsSession('test-session', [], async items => {
      projected.push(items)
    })

    await session.addItems([
      { type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: '内部推理' }] },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '可见回答' }],
      },
    ])

    expect(projected).toEqual([[
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '可见回答' }],
      },
    ]])
    expect(await session.getItems()).toEqual(projected[0])
  })

  it('retains platform run inputs once across outer Runner sessions without reprojecting them', async () => {
    const projected: AgentInputItem[][] = []
    const session = new CanonicalAgentsSession('test-session', [], async items => {
      projected.push(items)
    })
    const runInput = {
      type: 'message',
      role: 'user',
      content: '增加空间范围核验',
      providerData: {
        geoAgentRunInput: { runId: 'run_1', inputSequence: 2 },
      },
    } satisfies AgentInputItem

    await session.retainRunInputs([runInput])
    await session.retainRunInputs([structuredClone(runInput)])
    await session.addItems([structuredClone(runInput)])

    expect(projected).toEqual([])
    expect(await session.getItems()).toEqual([runInput])
    await expect(session.retainRunInputs([{
      ...runInput,
      content: '同 sequence 的不同内容',
    }])).rejects.toThrow('内容不一致')
  })
})

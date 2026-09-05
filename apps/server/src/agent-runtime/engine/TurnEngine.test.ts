// +-------------------------------------------------------------------------
//
//   地理智能平台 - Turn 身份与单段执行边界测试
//
//   文件:       TurnEngine.test.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { TurnEngine, type TurnSegmentStream } from './TurnEngine.js'

describe('TurnEngine', () => {
  it('creates a fresh identity and restores the exact persisted turnId', async () => {
    const restored: Array<[string, string]> = []
    const engine = new TurnEngine(async (threadId, runId) => {
      restored.push([threadId, runId])
      return 'turn_persisted'
    })

    const fresh = await engine.resolveTurnId({ runId: 'run_new', threadId: 'thread_1', resume: false })
    const resumed = await engine.resolveTurnId({ runId: 'run_old', threadId: 'thread_1', resume: true })

    expect(fresh).toMatch(/^turn_/u)
    expect(resumed).toBe('turn_persisted')
    expect(restored).toEqual([['thread_1', 'run_old']])
  })

  it('owns one SDK segment at a time and preserves stream callback order', async () => {
    const engine = new TurnEngine(async () => 'turn_unused')
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = engine.executeSegment({
      runId: 'run_1',
      turnId: 'turn_1',
      start: async () => stream(['一', '二'], gate),
      onStarted: () => { order.push('started') },
      onEvent: event => { order.push(event) },
    })
    await Promise.resolve()

    await expect(engine.executeSegment({
      runId: 'run_1',
      turnId: 'turn_1',
      start: async () => stream([], Promise.resolve()),
      onEvent: () => undefined,
    })).rejects.toThrow("Turn 'turn_1' 已有活动 Runner segment")

    release()
    const result = await first
    expect(result.error).toBeNull()
    expect(order).toEqual(['started', '一', '二'])
  })

  it('returns an iteration failure and releases the segment boundary', async () => {
    const engine = new TurnEngine(async () => 'turn_unused')
    const failure = new Error('stream failed')
    const failed = await engine.executeSegment({
      runId: 'run_1',
      turnId: 'turn_1',
      start: async () => failingStream(failure),
      onEvent: () => undefined,
    })

    expect(failed.error).toBe(failure)
    await expect(engine.executeSegment({
      runId: 'run_1',
      turnId: 'turn_1',
      start: async () => stream([], Promise.resolve()),
      onEvent: () => undefined,
    })).resolves.toMatchObject({ error: null })
  })
})

function stream(events: string[], completed: Promise<void>): TurnSegmentStream & AsyncIterable<string> {
  return {
    completed,
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event
    },
  }
}

function failingStream(error: Error): TurnSegmentStream {
  return {
    completed: Promise.resolve(),
    async *[Symbol.asyncIterator]() {
      throw error
    },
  }
}

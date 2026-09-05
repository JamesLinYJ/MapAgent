// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久运行执行边界测试
//
//   文件:       RunEngine.test.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { RunEngine } from './RunEngine.js'

describe('RunEngine', () => {
  it('allows only one active executor for a Run and releases it idempotently', () => {
    const engine = new RunEngine()
    const first = engine.start('run_1')

    expect(engine.isActive('run_1')).toBe(true)
    expect(() => engine.start('run_1')).toThrow("运行 'run_1' 已有活动执行器")
    expect(engine.abort('run_1')).toBe(true)
    expect(first.signal.aborted).toBe(true)

    first.close()
    first.close()
    expect(engine.isActive('run_1')).toBe(false)
    expect(engine.abort('run_1')).toBe(false)
    const restarted = engine.start('run_1')
    expect(engine.isActive('run_1')).toBe(true)
    restarted.close()
  })

  it('links and unlinks the caller cancellation signal at the lease boundary', () => {
    const engine = new RunEngine()
    const external = new AbortController()
    const lease = engine.start('run_external', external.signal)
    const reason = new Error('caller cancelled')

    external.abort(reason)
    expect(lease.signal.aborted).toBe(true)
    expect(lease.signal.reason).toBe(reason)
    lease.close()

    const detachedExternal = new AbortController()
    const detachedLease = engine.start('run_detached', detachedExternal.signal)
    detachedLease.close()
    detachedExternal.abort(new Error('too late'))
    expect(detachedLease.signal.aborted).toBe(false)
  })
})

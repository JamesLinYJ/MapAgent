// +-------------------------------------------------------------------------
//
//   地理智能平台 - 中止信号工具测试
//
//   文件:       abort.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { abortSignalWithTimeout } from './abort.js'

describe('abortSignalWithTimeout', () => {
  it('propagates the caller cancellation reason', () => {
    const controller = new AbortController()
    const signal = abortSignalWithTimeout(controller.signal, 60_000)

    controller.abort('user_cancelled')

    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe('user_cancelled')
  })
})

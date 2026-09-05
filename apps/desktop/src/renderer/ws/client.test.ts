// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面实时事件协议测试
//
//   文件:       client.test.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import { DesktopRealtimeProjection } from './client'

describe('DesktopRealtimeProjection', () => {
  it('接受共享 keepalive 但不把它伪装成业务消息或断连', () => {
    const projection = new DesktopRealtimeProjection()
    const listener = vi.fn()
    projection.on(listener)

    projection.acceptDesktopMessage({
      type: 'keepalive',
      id: null,
      payload: { data: {} },
    })

    expect(listener).not.toHaveBeenCalled()
  })
})

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 沙箱桌面事件传输解码器测试
//
//   文件:       eventTransportDecoder.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { encodeDesktopEvent } from '../main/eventTransportEncoder.js'
import {
  createOrderedDesktopEventDispatcher,
  decodeDesktopEvent,
} from './eventTransportDecoder.js'

describe('sandboxed desktop event transport decoder', () => {
  it('roundtrips a compressed Agent run event', async () => {
    const event = {
      version: 1 as const,
      event: 'transport:push' as const,
      payload: { content: '连续 NC 文件短临分析'.repeat(40_000) },
    }

    expect(await decodeDesktopEvent(encodeDesktopEvent(event))).toEqual(event)
  })

  it('delivers a compressed event before a later direct event', async () => {
    const compressedEvent = {
      version: 1 as const,
      event: 'transport:push' as const,
      payload: { content: '先到的大型运行推送'.repeat(40_000) },
    }
    const directEvent = {
      version: 1 as const,
      event: 'transport:push' as const,
      payload: { content: '后到的小型运行推送' },
    }
    const delivered: Array<typeof compressedEvent | typeof directEvent> = []
    const dispatch = createOrderedDesktopEventDispatcher(
      (event) => delivered.push(event as typeof compressedEvent | typeof directEvent),
      (error) => {
        throw error
      },
    )

    const firstDelivery = dispatch(encodeDesktopEvent(compressedEvent))
    const secondDelivery = dispatch(encodeDesktopEvent(directEvent))

    await Promise.all([firstDelivery, secondDelivery])
    expect(delivered).toEqual([compressedEvent, directEvent])
  })
})

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面事件传输编码器测试
//
//   文件:       eventTransportEncoder.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  DESKTOP_CONTROL_FRAME_MAX_BYTES,
  desktopEventTransportSchema,
} from '../contracts/desktopIpc.js'
import { encodeDesktopEvent } from './eventTransportEncoder.js'

describe('desktop event transport encoder', () => {
  it('keeps small status events direct', () => {
    const event = {
      version: 1 as const,
      event: 'transport:status' as const,
      payload: { state: 'connected' },
    }
    expect(encodeDesktopEvent(event)).toEqual(event)
  })

  it('compresses large run push events within the physical IPC frame limit', () => {
    const event = {
      version: 1 as const,
      event: 'transport:push' as const,
      payload: {
        type: 'run.state',
        entries: Array.from({ length: 800 }, (_, index) => ({
          index,
          content: '杭州短临降水分析工具结果。'.repeat(32),
        })),
      },
    }

    const encoded = encodeDesktopEvent(event)
    expect(encoded).toMatchObject({ frame: 'event', encoding: 'gzip-base64' })
    expect(Buffer.byteLength(JSON.stringify(encoded), 'utf8'))
      .toBeLessThanOrEqual(DESKTOP_CONTROL_FRAME_MAX_BYTES)
    expect(desktopEventTransportSchema.safeParse(encoded).success).toBe(true)
  })
})

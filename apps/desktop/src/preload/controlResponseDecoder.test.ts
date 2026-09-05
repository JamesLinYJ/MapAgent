// +-------------------------------------------------------------------------
//
//   地理智能平台 - 沙箱控制响应解码器测试
//
//   文件:       controlResponseDecoder.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { encodeDesktopControlResponse } from '../main/controlResponseEncoder.js'
import { decodeDesktopControlResponse } from './controlResponseDecoder.js'

describe('sandboxed control response decoder', () => {
  it('roundtrips a compressed response through Chromium-compatible gzip', async () => {
    const response = {
      version: 1 as const,
      requestId: crypto.randomUUID(),
      ok: true,
      data: { content: '杭州短临降水'.repeat(40_000) },
    }
    const encoded = encodeDesktopControlResponse(response)

    expect(await decodeDesktopControlResponse(encoded)).toEqual(response)
  })

  it('rejects a forged decompressed length before exposing data to Renderer', async () => {
    const response = {
      version: 1 as const,
      requestId: crypto.randomUUID(),
      ok: true,
      data: { content: '气象'.repeat(40_000) },
    }
    const encoded = encodeDesktopControlResponse(response)
    if (!('encoding' in encoded)) throw new Error('测试载荷未进入压缩传输。')

    await expect(decodeDesktopControlResponse({
      ...encoded,
      uncompressedBytes: encoded.uncompressedBytes + 1,
    })).rejects.toThrow('解压长度')
  })
})

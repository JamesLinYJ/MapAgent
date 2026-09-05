// +-------------------------------------------------------------------------
//
//   地理智能平台 - 有界 JSONL 协议测试
//
//   文件:       jsonl.test.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { encodeJsonlFrame, FrameTooLargeError, JsonlFrameDecoder, OPERATIONS_MAX_FRAME_BYTES } from './jsonl.js'

describe('bounded JSONL codec', () => {
  it('reassembles multiple fragmented frames', () => {
    const decoder = new JsonlFrameDecoder()
    const bytes = Buffer.concat([encodeJsonlFrame({ a: 1 }), encodeJsonlFrame({ b: '杭州' })])

    expect(decoder.push(bytes.subarray(0, 5))).toEqual([])
    expect(decoder.push(bytes.subarray(5))).toEqual(['{"a":1}', '{"b":"杭州"}'])
  })

  it('rejects outgoing and incoming frames at the 64 KiB boundary', () => {
    expect(() => encodeJsonlFrame({ value: 'x'.repeat(OPERATIONS_MAX_FRAME_BYTES) }))
      .toThrow(FrameTooLargeError)
    const decoder = new JsonlFrameDecoder()
    expect(() => decoder.push(Buffer.alloc(OPERATIONS_MAX_FRAME_BYTES, 0x78)))
      .toThrow(FrameTooLargeError)
  })
})

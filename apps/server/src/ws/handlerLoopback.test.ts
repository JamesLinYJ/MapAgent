// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 本机地址判定测试
//
//   文件:       handlerLoopback.test.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { isLoopbackAddress } from './handler.js'

describe('WebSocket local Agent boundary', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])(
    'accepts loopback address %s',
    address => expect(isLoopbackAddress(address)).toBe(true),
  )

  it.each(['0.0.0.0', '192.168.1.20', '::ffff:192.168.1.20', undefined])(
    'rejects non-loopback address %s',
    address => expect(isLoopbackAddress(address)).toBe(false),
  )
})

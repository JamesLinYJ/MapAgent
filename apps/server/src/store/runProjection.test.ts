// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行列表投影测试
//
//   文件:       runProjection.test.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { decodeRunCursor, encodeRunCursor } from './runProjection.js'

describe('runProjection', () => {
  it('往返编码运行分页游标', () => {
    const cursor = { id: 'run_1', updatedAt: '2026-07-16T08:00:00.000Z' }
    expect(decodeRunCursor(encodeRunCursor(cursor))).toEqual(cursor)
  })

  it('拒绝结构无效的游标', () => {
    const invalid = Buffer.from(JSON.stringify({ id: '', updatedAt: 'not-a-date' }), 'utf8').toString('base64url')
    expect(() => decodeRunCursor(invalid)).toThrow('运行分页游标无效。')
  })
})

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地点地理编码工具测试
//
//   文件:       handler.test.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ToolContext } from '../../framework/types.js'
import { geocodePlaceTool } from './handler.js'

describe('geocode place tool', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('maps provider network failures to a stable Chinese error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))

    await expect(geocodePlaceTool.handler({ query: '杭州西湖' }, runtime()))
      .rejects.toThrow('地理编码网络请求失败。')
  })

  it('maps provider timeouts without exposing the runtime abort message', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort())
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('The operation was aborted due to timeout')
    }))

    await expect(geocodePlaceTool.handler({ query: '杭州西湖' }, runtime()))
      .rejects.toThrow('地理编码查询超时，请改用城市或区县标准名称重试。')
  })

  it('returns normalized place candidates for a valid provider response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{
      display_name: '西湖风景名胜区，中国浙江省杭州市',
      lat: '30.2448',
      lon: '120.1500',
      boundingbox: ['30.1', '30.3', '120.0', '120.2'],
    }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    const result = await geocodePlaceTool.handler({ query: '杭州西湖', limit: 1 }, runtime())

    expect(result.payload).toMatchObject({
      query: '杭州西湖',
      count: 1,
      candidates: [{ latitude: 30.2448, longitude: 120.15, source: 'nominatim' }],
    })
  })
})

function runtime(): ToolContext {
  return {
    runId: 'run_geocode',
    threadId: 'thread_geocode',
    sessionId: 'session_geocode',
    signal: new AbortController().signal,
    state: new Map(),
    resolveValueRef: refId => {
      throw new Error(`未知 valueRef '${refId}'`)
    },
    invokeStructuredModel: async () => ({}),
    log: () => undefined,
  }
}

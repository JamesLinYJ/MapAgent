// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行历史加载协调器测试
//
//   文件:       useRunHistoryLoader.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import { loadRunHistoryPanel } from './useRunHistoryLoader'

describe('run history loader', () => {
  it('loads only the requested session history', async () => {
    const loadRunHistory = vi.fn().mockResolvedValue(undefined)
    await loadRunHistoryPanel('session-1', loadRunHistory)
    expect(loadRunHistory).toHaveBeenCalledWith('session-1')
  })

  it('propagates a history failure to the coordinator error boundary', async () => {
    const failure = new Error('历史读取失败')
    await expect(loadRunHistoryPanel(
      'session-1',
      vi.fn().mockRejectedValue(failure),
    )).rejects.toBe(failure)
  })
})

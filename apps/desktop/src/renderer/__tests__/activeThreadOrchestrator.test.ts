// +-------------------------------------------------------------------------
//
//   地理智能平台 - 活跃线程编排测试
//
//   文件:       activeThreadOrchestrator.test.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import { ensureActiveThread } from '../app/services/activeThreadOrchestrator'

describe('active thread orchestrator', () => {
  it('returns the existing thread without touching persistence or navigation', async () => {
    const createThread = vi.fn()
    const activateThread = vi.fn()
    const addThreadToHistory = vi.fn()
    const syncLocation = vi.fn()

    await expect(ensureActiveThread({
      currentThreadId: 'thread_existing',
      sessionId: 'session_1',
      title: '地图浏览',
    }, { createThread, activateThread, addThreadToHistory, syncLocation })).resolves.toBe('thread_existing')

    expect(createThread).not.toHaveBeenCalled()
    expect(activateThread).not.toHaveBeenCalled()
    expect(addThreadToHistory).not.toHaveBeenCalled()
    expect(syncLocation).not.toHaveBeenCalled()
  })

  it('creates and projects one thread through explicit ports', async () => {
    const thread = { id: 'thread_created', title: '地图浏览' }
    const createThread = vi.fn().mockResolvedValue(thread)
    const activateThread = vi.fn()
    const addThreadToHistory = vi.fn()
    const syncLocation = vi.fn()

    await expect(ensureActiveThread({
      sessionId: 'session_1',
      title: ' 地图浏览 ',
    }, { createThread, activateThread, addThreadToHistory, syncLocation })).resolves.toBe(thread.id)

    expect(createThread).toHaveBeenCalledWith('session_1', '地图浏览')
    expect(activateThread).toHaveBeenCalledWith(thread)
    expect(addThreadToHistory).toHaveBeenCalledWith(thread)
    expect(syncLocation).toHaveBeenCalledWith('session_1', thread.id)
  })

  it('fails before persistence when session or title is missing', async () => {
    const port = {
      createThread: vi.fn(),
      activateThread: vi.fn(),
      addThreadToHistory: vi.fn(),
      syncLocation: vi.fn(),
    }

    await expect(ensureActiveThread({ title: '地图浏览' }, port)).rejects.toThrow('当前会话还没有初始化')
    await expect(ensureActiveThread({ sessionId: 'session_1', title: '   ' }, port)).rejects.toThrow('工作线程标题不能为空')
    expect(port.createThread).not.toHaveBeenCalled()
  })
})
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 活跃线程编排测试
//
//   文件:       activeThreadOrchestrator.test.ts
// --------------------------------------------------------------------------

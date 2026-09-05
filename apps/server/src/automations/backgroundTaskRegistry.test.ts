// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 后台任务注册表测试
//
//   文件:       backgroundTaskRegistry.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { BackgroundTaskRegistry } from './backgroundTaskRegistry.js'

describe('BackgroundTaskRegistry', () => {
  it('保留取消状态，不被随后完成的 Promise 覆盖', async () => {
    const registry = new BackgroundTaskRegistry()
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })

    const task = registry.start({
      taskId: 'task_1',
      label: '测试任务',
      kind: 'test',
      workspaceId: 'workspace_1',
      run: async () => gate,
    })

    expect(registry.cancel('task_1').status).toBe('cancelled')
    release?.()
    await task

    expect(registry.get('task_1')).toMatchObject({
      status: 'cancelled',
      errorMessage: '任务已取消。',
    })
  })

  it('拒绝同一 taskId 的并发任务', async () => {
    const registry = new BackgroundTaskRegistry()
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const task = registry.start({
      taskId: 'task_duplicate',
      label: '原任务',
      kind: 'test',
      run: async () => gate,
    })

    expect(() => registry.start({
      taskId: 'task_duplicate',
      label: '重复任务',
      kind: 'test',
      run: async () => undefined,
    })).toThrow("后台任务 'task_duplicate' 已在运行")

    release?.()
    await task
  })
})

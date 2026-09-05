// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面窗口协调器测试
//
//   文件:       useDesktopWindowCoordinator.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  resolveWorkspaceBinding,
  resolveWorkspaceOpenTarget,
  taskbarProgressForRun,
} from './useDesktopWindowCoordinator'

describe('desktop window coordinator', () => {
  it('projects run lifecycle states to native taskbar states', () => {
    expect(taskbarProgressForRun('running')).toEqual({ state: 'indeterminate', value: null })
    expect(taskbarProgressForRun('waiting_approval')).toEqual({ state: 'paused', value: 1 })
    expect(taskbarProgressForRun('failed')).toEqual({ state: 'error', value: 1 })
    expect(taskbarProgressForRun('completed')).toEqual({ state: 'none', value: null })
  })

  it('binds the active session without leaking an unrelated workspace name', () => {
    expect(resolveWorkspaceBinding(
      { id: 'session-1', workspaceId: 'workspace-1' },
      'thread-1',
      { workspaceId: 'workspace-2', name: '其它工作区' },
    )).toEqual({
      workspaceId: 'workspace-1',
      workspaceName: '工作区 workspace-1',
      sessionId: 'session-1',
      threadId: 'thread-1',
    })
  })

  it('rejects workspace targets outside the authorized query result', () => {
    expect(() => resolveWorkspaceOpenTarget('workspace-2', [
      { workspaceId: 'workspace-1', name: '主工作区' },
    ])).toThrow("工作区 'workspace-2' 不在当前账号的可见工作区列表中。")
  })
})

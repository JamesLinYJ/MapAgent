// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区导出协调器测试
//
//   文件:       useWorkspaceExportCoordinator.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { resolveExportScope } from './useWorkspaceExportCoordinator'

describe('workspace export coordinator', () => {
  it('resolves the export ownership scope from session and thread facts', () => {
    expect(resolveExportScope({
      session: { id: 'session-1', workspaceId: 'workspace-1' },
      threadId: 'thread-1',
    })).toEqual({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      threadId: 'thread-1',
    })
  })

  it('rejects an incomplete scope before opening the exporter', () => {
    expect(() => resolveExportScope({
      defaultWorkspaceId: 'workspace-1',
    })).toThrow('当前工作区或对话尚未就绪，无法导出成果。')
  })
})

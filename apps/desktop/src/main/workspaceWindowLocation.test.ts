// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面工作区窗口位置测试
//
//   文件:       workspaceWindowLocation.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { buildWorkspaceWindowQuery } from './workspaceWindowLocation.js'

describe('buildWorkspaceWindowQuery', () => {
  it('does not expose an internal bootstrap sentinel as a workspace pointer', () => {
    expect(buildWorkspaceWindowQuery(null)).toBe('')
  })

  it('encodes only a real workspace and its optional recovery pointers', () => {
    expect(buildWorkspaceWindowQuery({
      workspaceId: 'workspace 1',
      workspaceName: '测试工作区',
      sessionId: 'session/1',
      threadId: 'thread?1',
    })).toBe('?workspace=workspace+1&session=session%2F1&thread=thread%3F1')
  })
})

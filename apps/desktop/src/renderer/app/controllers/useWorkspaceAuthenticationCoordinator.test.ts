// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区认证协调器测试
//
//   文件:       useWorkspaceAuthenticationCoordinator.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { shouldRetryAuthentication } from './useWorkspaceAuthenticationCoordinator'

describe('workspace authentication coordinator', () => {
  it('keeps an online revision available when broker failure arrives after the backend', () => {
    expect(shouldRetryAuthentication(0, 1, 'checking')).toBe(false)
    expect(shouldRetryAuthentication(0, 1, 'error')).toBe(true)
  })

  it('consumes each backend-online revision at most once after authentication fails', () => {
    expect(shouldRetryAuthentication(2, 3, 'error')).toBe(true)
    expect(shouldRetryAuthentication(3, 3, 'error')).toBe(false)
    expect(shouldRetryAuthentication(2, 3, 'authenticated')).toBe(false)
  })
})

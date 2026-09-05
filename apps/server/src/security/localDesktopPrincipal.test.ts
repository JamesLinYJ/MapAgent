// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Desktop 服务主体测试
//
//   文件:       localDesktopPrincipal.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  deriveLocalDesktopCredential,
  isLocalDesktopEmail,
} from './localDesktopPrincipal.js'
import { deriveLocalAgentCredential } from './localAgentPrincipal.js'

describe('local Desktop principal', () => {
  it('derives a stable reserved identity independently from the Agent principal', () => {
    const rootSecret = 'a'.repeat(64)
    const desktop = deriveLocalDesktopCredential(rootSecret)
    const agent = deriveLocalAgentCredential(rootSecret)

    expect(isLocalDesktopEmail(desktop.email)).toBe(true)
    expect(desktop.password).not.toBe(agent.password)
    expect(desktop.keyVersion).not.toBe(agent.keyVersion)
  })

  it('rejects an undersized local root secret', () => {
    expect(() => deriveLocalDesktopCredential('too-short')).toThrow('本机根密钥长度不足')
  })

  it('does not grant local Desktop identity semantics to another local-domain address', () => {
    expect(isLocalDesktopEmail('other@local-desktop.geo-agent-platform.invalid')).toBe(false)
  })
})

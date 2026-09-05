// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 服务主体标识测试
//
//   文件:       localAgentPrincipal.test.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { deriveLocalConsoleCredential } from './localConsolePrincipal.js'
import {
  deriveLocalAgentCredential,
  isLocalAgentEmail,
  LOCAL_AGENT_EMAIL,
} from './localAgentPrincipal.js'

describe('local Agent principal', () => {
  it('derives a stable reserved identity without sharing Console credentials', () => {
    const rootSecret = 'a'.repeat(64)
    const agent = deriveLocalAgentCredential(rootSecret)
    const consolePrincipal = deriveLocalConsoleCredential(rootSecret)

    expect(agent.email).toBe(LOCAL_AGENT_EMAIL)
    expect(agent.password).not.toBe(consolePrincipal.password)
    expect(agent.keyVersion).not.toBe(consolePrincipal.keyVersion)
    expect(isLocalAgentEmail(agent.email)).toBe(true)
  })

  it('rotates the credential without creating a second identity', () => {
    const first = deriveLocalAgentCredential('a'.repeat(64))
    const second = deriveLocalAgentCredential('b'.repeat(64))

    expect(second.email).toBe(first.email)
    expect(second.password).not.toBe(first.password)
    expect(second.keyVersion).not.toBe(first.keyVersion)
  })

  it('rejects undersized root secrets', () => {
    expect(() => deriveLocalAgentCredential('too-short')).toThrow('本机根密钥长度不足')
  })
})

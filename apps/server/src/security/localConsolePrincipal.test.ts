// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Console 服务主体标识测试
//
//   文件:       localConsolePrincipal.test.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  deriveLocalConsoleCredential,
  isLocalConsoleEmail,
  LOCAL_CONSOLE_EMAIL_DOMAIN,
} from './localConsolePrincipal.js'

describe('local Console credential derivation', () => {
  it('is stable for one root key and rotates every derived identity field with the key', () => {
    const firstKey = 'a'.repeat(48)
    const secondKey = 'b'.repeat(48)
    const first = deriveLocalConsoleCredential(firstKey)
    const repeat = deriveLocalConsoleCredential(firstKey)
    const rotated = deriveLocalConsoleCredential(secondKey)

    expect(repeat).toEqual(first)
    expect(rotated).not.toEqual(first)
    expect(rotated.email).not.toBe(first.email)
    expect(rotated.password).not.toBe(first.password)
    expect(first.email.endsWith(`@${LOCAL_CONSOLE_EMAIL_DOMAIN}`)).toBe(true)
    expect(first.email).toBe(first.email.toLowerCase())
    expect(isLocalConsoleEmail(first.email.toUpperCase())).toBe(true)
    expect(isLocalConsoleEmail('admin@example.com')).toBe(false)
  })

  it('rejects a root key shorter than the local security boundary', () => {
    expect(() => deriveLocalConsoleCredential('too-short')).toThrow('本机根密钥长度不足')
  })
})

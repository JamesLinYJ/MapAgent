// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 麦克风一次性授权 Gate 测试
//
//   文件:       microphonePermissionGate.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { MicrophonePermissionGate } from './microphonePermissionGate.js'

describe('MicrophonePermissionGate', () => {
  it('isolates grants by window and consumes each grant only once', () => {
    const gate = new MicrophonePermissionGate(() => 1_000, 5_000)

    expect(gate.grant(11)).toBe(true)
    expect(gate.hasActiveGrant(11)).toBe(true)
    expect(gate.hasActiveGrant(12)).toBe(false)
    expect(gate.hasActiveGrant(11)).toBe(true)
    expect(gate.consume(11)).toBe(true)
    expect(gate.consume(11)).toBe(false)
  })

  it('expires grants and releases all state when the owner window is destroyed', () => {
    let now = 10_000
    const gate = new MicrophonePermissionGate(() => now, 1_000)

    expect(gate.grant(21)).toBe(true)
    expect(gate.grant(21)).toBe(false)
    now = 11_000
    expect(gate.hasActiveGrant(21)).toBe(false)

    expect(gate.grant(21)).toBe(false)
    gate.releaseOwner(21)
    expect(gate.hasActiveGrant(21)).toBe(false)
    expect(gate.grant(21)).toBe(true)
  })

  it('revokes every pending grant when Main authorization changes', () => {
    const gate = new MicrophonePermissionGate()
    gate.grant(31)
    gate.grant(32)

    gate.revokeAll()

    expect(gate.hasActiveGrant(31)).toBe(false)
    expect(gate.hasActiveGrant(32)).toBe(false)
  })
})

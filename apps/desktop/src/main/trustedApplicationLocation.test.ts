// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 可信应用位置测试
//
//   文件:       trustedApplicationLocation.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  isTrustedApplicationUrl,
  isTrustedDevelopmentRendererUrl,
} from './trustedApplicationLocation.js'

describe('isTrustedApplicationUrl', () => {
  it('accepts only the exact platform application host', () => {
    expect(isTrustedApplicationUrl('geo-agent-platform://app/index.html?workspace=1')).toBe(true)
    expect(isTrustedApplicationUrl('geo-agent-platform://app')).toBe(true)
    expect(isTrustedApplicationUrl('geo-agent-platform://app.evil/index.html')).toBe(false)
    expect(isTrustedApplicationUrl('geo-agent-platform://app@evil.example/index.html')).toBe(false)
    expect(isTrustedApplicationUrl('geo-agent-platform://app:443/index.html')).toBe(false)
  })

  it('allows only the exact configured loopback development origin', () => {
    const developmentUrl = 'http://127.0.0.1:5173/'
    expect(isTrustedApplicationUrl('http://127.0.0.1:5173/workbench?q=1', developmentUrl)).toBe(true)
    expect(isTrustedApplicationUrl('http://127.0.0.1:5174/workbench', developmentUrl)).toBe(false)
    expect(isTrustedApplicationUrl('http://127.0.0.1.evil.example:5173/', developmentUrl)).toBe(false)
    expect(isTrustedApplicationUrl('http://user@127.0.0.1:5173/', developmentUrl)).toBe(false)
    expect(isTrustedApplicationUrl('http://[::1]:5173/workbench', 'http://[::1]:5173/')).toBe(true)
  })

  it('rejects a remote development renderer configuration', () => {
    expect(isTrustedApplicationUrl(
      'https://renderer.example.com/workbench',
      'https://renderer.example.com/',
    )).toBe(false)
    expect(isTrustedDevelopmentRendererUrl('https://renderer.example.com/')).toBe(false)
    expect(isTrustedDevelopmentRendererUrl('http://localhost:5173/')).toBe(true)
  })
})

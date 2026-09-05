// +-------------------------------------------------------------------------
//
//   地理智能平台 - 安全窗口首选项测试
//
//   文件:       secureWebPreferences.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { secureWebPreferences } from './secureWebPreferences.js'

describe('secure BrowserWindow preferences', () => {
  it('keeps renderer privilege escalation surfaces disabled for every window kind', () => {
    for (const preferences of [
      secureWebPreferences(),
      secureWebPreferences({ preload: 'C:/app/preload.cjs', devTools: true, spellcheck: true }),
      secureWebPreferences({ javascript: false }),
    ]) {
      expect(preferences).toMatchObject({
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        allowRunningInsecureContent: false,
      })
    }
  })

  it('allows only non-privileged window capabilities to vary', () => {
    expect(secureWebPreferences({
      preload: 'C:/app/preload.cjs',
      devTools: true,
      javascript: false,
      spellcheck: true,
    })).toMatchObject({
      preload: 'C:/app/preload.cjs',
      devTools: true,
      javascript: false,
      spellcheck: true,
    })
  })
})

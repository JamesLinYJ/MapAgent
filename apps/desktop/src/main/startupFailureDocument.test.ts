// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面启动失败文档测试
//
//   文件:       startupFailureDocument.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  buildStartupFailureDocument,
  safeStartupMessage,
} from './startupFailureDocument.js'

describe('startup failure document', () => {
  it('escapes untrusted error text and never emits active script', () => {
    const html = buildStartupFailureDocument(
      new Error('<script>alert(1)</script> token=private-value'),
    )

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('token=[REDACTED]')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('private-value')
    expect(html).toContain("default-src 'none'")
  })

  it('keeps a stable Chinese fallback for non-errors', () => {
    expect(safeStartupMessage(null)).toBe('桌面主进程遇到未知启动错误。')
  })
})

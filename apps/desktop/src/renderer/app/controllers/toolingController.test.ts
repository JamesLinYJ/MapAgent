// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具与运行时配置控制器测试
//
//   文件:       toolingController.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { shouldLoadToolingDiagnostics } from './toolingController'

describe('tooling controller', () => {
  it('loads diagnostic state only for tool-owned surfaces', () => {
    expect(shouldLoadToolingDiagnostics('/debug', 'summary')).toBe(true)
    expect(shouldLoadToolingDiagnostics('/', 'tools')).toBe(true)
    expect(shouldLoadToolingDiagnostics('/', 'config')).toBe(true)
    expect(shouldLoadToolingDiagnostics('/', 'summary')).toBe(false)
  })
})

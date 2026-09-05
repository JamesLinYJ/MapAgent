// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话输入模式测试
//
//   文件:       composerModes.test.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  COMPOSER_MODES,
  executionModeForComposerMode,
  runProfileForComposerMode,
} from './composerModes'

describe('composer modes', () => {
  it('maps geospatial Compose to the auto SDK path with an explicit run profile', () => {
    expect(executionModeForComposerMode('compose')).toBe('auto')
    expect(runProfileForComposerMode('compose')).toBe('geospatial_compose')
    const compose = COMPOSER_MODES.find(mode => mode.id === 'compose')
    expect(compose).toMatchObject({
      badge: '阶段化交付 · 独立验证',
    })
    expect(compose && 'disabled' in compose ? compose.disabled : false).toBe(false)
  })

  it('keeps existing modes on the standard run profile', () => {
    expect(runProfileForComposerMode('approval')).toBe('standard')
    expect(runProfileForComposerMode('auto')).toBe('standard')
    expect(runProfileForComposerMode('plan')).toBe('standard')
  })
})

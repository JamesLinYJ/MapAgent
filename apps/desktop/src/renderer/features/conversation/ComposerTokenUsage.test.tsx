// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话累计词元底栏测试
//
//   文件:       ComposerTokenUsage.test.tsx
//
//   日期:       2026年08月30日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe,expect,it,vi } from 'vitest'

import { tokenUsageTotalsSchema } from '@geo-agent-platform/shared-types'
import { Composer } from './Composer'
import { DEFAULT_GOAL_DRAFT } from './goalDraft'

describe('Composer thread token usage', () => {
  it('renders the current thread totals at the very bottom', () => {
    const html = renderToStaticMarkup(
      <Composer
        query=""
        providerLabel="DeepSeek"
        isSubmitting={false}
        conversationReady
        canSteerActiveRun={false}
        composerMode="auto"
        threadUsage={tokenUsageTotalsSchema.parse({
          runCount: 3,
          runsWithUsage: 3,
          runsWithoutUsage: 0,
          inputTokens: 88_342,
          outputTokens: 202,
          cacheHitInputTokens: 88_064,
          cacheMeasuredInputTokens: 88_342,
          totalTokens: 88_544,
          contextEstimatedTokens: 0,
          resultCacheHitCount: 0,
          resultCacheAvoidedRequestCount: 0,
          resultCacheEstimatedSavedTokens: 0,
        })}
        goalDraft={DEFAULT_GOAL_DRAFT}
        onGoalDraftChange={vi.fn()}
        composerInputRef={createRef<HTMLTextAreaElement>()}
        onQueryChange={vi.fn()}
        onSubmit={vi.fn()}
        onUseTemplate={vi.fn()}
        onUploadFiles={vi.fn()}
        modeMenuOpen={false}
        onModeMenuOpenChange={vi.fn()}
        onComposerModeChange={vi.fn()}
        onCompositionStart={vi.fn()}
        onCompositionEnd={vi.fn()}
        onInputKeyDown={vi.fn()}
      />,
    )

    expect(html).toContain('本对话累计')
    expect(html).toContain('88,342')
    expect(html).toContain('88,064')
    expect(html).toContain('99.69%')
    expect(html).not.toContain('统计 3/3')
    expect(html.indexOf('cc-thread-usage')).toBeGreaterThan(html.indexOf('cc-composer-toolbar'))
  })

  it('marks retained totals as possibly stale after a refresh failure', () => {
    const html = renderToStaticMarkup(
      <Composer
        query=""
        providerLabel="DeepSeek"
        isSubmitting={false}
        conversationReady
        canSteerActiveRun={false}
        composerMode="auto"
        threadUsage={tokenUsageTotalsSchema.parse({
          runCount: 1,
          runsWithUsage: 1,
          runsWithoutUsage: 0,
          inputTokens: 120,
          outputTokens: 30,
          cacheHitInputTokens: 80,
          cacheMeasuredInputTokens: 120,
          totalTokens: 150,
          contextEstimatedTokens: 0,
          resultCacheHitCount: 0,
          resultCacheAvoidedRequestCount: 0,
          resultCacheEstimatedSavedTokens: 0,
        })}
        threadUsageUnavailable
        goalDraft={DEFAULT_GOAL_DRAFT}
        onGoalDraftChange={vi.fn()}
        composerInputRef={createRef<HTMLTextAreaElement>()}
        onQueryChange={vi.fn()}
        onSubmit={vi.fn()}
        onUseTemplate={vi.fn()}
        onUploadFiles={vi.fn()}
        modeMenuOpen={false}
        onModeMenuOpenChange={vi.fn()}
        onComposerModeChange={vi.fn()}
        onCompositionStart={vi.fn()}
        onCompositionEnd={vi.fn()}
        onInputKeyDown={vi.fn()}
      />,
    )

    expect(html).toContain('输入 <strong>120</strong>')
    expect(html).toContain('统计可能已过期')
    expect(html).not.toContain('词元统计暂不可用')
  })
})

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型词元用量统计面板测试
//
//   文件:       UsageManagementPanel.test.tsx
//
//   日期:       2026年08月30日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { describe,expect,it } from 'vitest'

import { tokenUsageSummarySchema } from '@geo-agent-platform/shared-types'
import { UsageManagementPanel } from './UsageManagementPanel'

describe('UsageManagementPanel cache metrics', () => {
  it('shows the real workspace cache rate without exposing transport field coverage', () => {
    const summary = tokenUsageSummarySchema.parse({
      workspaceId: 'workspace_test',
      generatedAt: '2026-08-30T00:00:00.000Z',
      totals: {
        runCount: 2,
        runsWithUsage: 2,
        runsWithoutUsage: 0,
        inputTokens: 100,
        outputTokens: 10,
        cacheHitInputTokens: 81,
        cacheMeasuredInputTokens: 100,
        totalTokens: 110,
        contextEstimatedTokens: 0,
        resultCacheHitCount: 0,
        resultCacheAvoidedRequestCount: 0,
        resultCacheEstimatedSavedTokens: 0,
      },
      limits: [],
      byProvider: [],
      byModel: [],
      byStatus: [],
      recentRuns: [],
      warnings: [],
    })

    const html = renderToStaticMarkup(<UsageManagementPanel summary={summary} />)

    expect(html).toContain('81% 命中率，仅采用供应商明细')
    expect(html).not.toContain('2/2 个响应已报告')
  })

  it('uses zero measurable input as the only unreported signal', () => {
    const summary = tokenUsageSummarySchema.parse({
      workspaceId: 'workspace_test',
      generatedAt: '2026-08-30T00:00:00.000Z',
      totals: {
        runCount: 1,
        runsWithUsage: 1,
        runsWithoutUsage: 0,
        inputTokens: 100,
        outputTokens: 10,
        cacheHitInputTokens: 0,
        cacheMeasuredInputTokens: 0,
        totalTokens: 110,
        contextEstimatedTokens: 0,
        resultCacheHitCount: 0,
        resultCacheAvoidedRequestCount: 0,
        resultCacheEstimatedSavedTokens: 0,
      },
      limits: [],
      byProvider: [],
      byModel: [],
      byStatus: [],
      recentRuns: [{
        runId: 'run_test',
        threadId: 'thread_test',
        sessionId: 'session_test',
        userQuery: '测试问题',
        modelProvider: 'deepseek',
        modelName: 'deepseek-chat',
        status: 'completed',
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:01.000Z',
        inputTokens: 100,
        outputTokens: 10,
        cacheHitInputTokens: 0,
        cacheMeasuredInputTokens: 0,
        resultCacheHitCount: 0,
        resultCacheAvoidedRequestCount: 0,
        resultCacheEstimatedSavedTokens: 0,
        totalTokens: 110,
        contextEstimatedTokens: 0,
        contextUsagePermille: null,
        usageResponseCount: 1,
        hasUsage: true,
      }],
      warnings: [],
    })

    const html = renderToStaticMarkup(<UsageManagementPanel summary={summary} />)

    expect(html).toContain('供应商未返回缓存明细')
    expect(html).toContain('<span>未报告</span>')
  })
})

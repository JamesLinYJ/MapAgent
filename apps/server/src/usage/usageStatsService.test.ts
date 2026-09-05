// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型用量统计服务测试
//
//   文件:       usageStatsService.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import { parseEnv, type Env } from '../framework/env.js'
import { analysisRunSchema, type AnalysisRun } from '@geo-agent-platform/shared-types/platform'
import type { RunStatus } from '@geo-agent-platform/shared-types/core'
import type { AuthContext } from '../security/types.js'
import { UsageStatsService, type UsageRunReader } from './usageStatsService.js'

describe('UsageStatsService', () => {
  it('separates input, output, cache-hit, total tokens, and missing usage runs', () => {
    const service = new UsageStatsService(fakeStore([
      run('run_with_cache', {
        runtimeStats: {
          modelInputTokens: 120,
          modelOutputTokens: 30,
          modelCacheHitInputTokens: 80,
          modelCacheMeasuredInputTokens: 120,
          modelTotalTokens: 150,
          modelUsageResponseCount: 1,
          contextEstimatedTokens: 900,
          modelResultCacheHitCount: 2,
          modelResultCacheAvoidedRequestCount: 2,
          modelResultCacheEstimatedSavedTokens: 70,
        },
      }),
      run('run_without_cache_detail', {
        runtimeStats: {
          modelInputTokens: 10,
          modelOutputTokens: 5,
          modelTotalTokens: 15,
          modelUsageResponseCount: 1,
        },
      }),
      run('run_without_provider_usage', { runtimeStats: {} }),
    ]), env())

    const summary = service.summarizeWorkspace(auth())

    expect(summary.totals.runCount).toBe(3)
    expect(summary.totals.runsWithUsage).toBe(2)
    expect(summary.totals.runsWithoutUsage).toBe(1)
    expect(summary.totals.inputTokens).toBe(130)
    expect(summary.totals.outputTokens).toBe(35)
    expect(summary.totals.cacheHitInputTokens).toBe(80)
    expect(summary.totals.cacheMeasuredInputTokens).toBe(120)
    expect(summary.totals.totalTokens).toBe(165)
    expect(summary.totals.contextEstimatedTokens).toBe(900)
    expect(summary.totals.resultCacheAvoidedRequestCount).toBe(2)
    expect(summary.totals.resultCacheEstimatedSavedTokens).toBe(70)
    expect(summary.byProvider[0]?.key).toBe('deepseek')
    expect(summary.byModel[0]?.label).toBe('deepseek-v4-pro')
    expect(summary.recentRuns[0]).toMatchObject({
      runId: 'run_with_cache',
      inputTokens: 120,
      outputTokens: 30,
      cacheHitInputTokens: 80,
      cacheMeasuredInputTokens: 120,
      totalTokens: 150,
      hasUsage: true,
    })
    expect(summary.warnings.join('\n')).toContain('没有模型 provider 返回的 usage')
    expect(summary.warnings.join('\n')).not.toContain('缓存明细')
  })

  it('enforces daily and monthly limits from real total token usage', () => {
    const service = new UsageStatsService(fakeStore([
      run('run_today', {
        createdAt: new Date().toISOString(),
        runtimeStats: {
          modelInputTokens: 80,
          modelOutputTokens: 20,
          modelTotalTokens: 100,
          modelUsageResponseCount: 1,
        },
      }),
    ]), env({ USAGE_DAILY_TOTAL_TOKEN_LIMIT: '100', USAGE_MONTHLY_TOTAL_TOKEN_LIMIT: '1000' }))

    const summary = service.summarizeWorkspace(auth())

    expect(summary.limits.find(limit => limit.period === 'day')).toMatchObject({
      enabled: true,
      limitTokens: 100,
      usedTokens: 100,
      remainingTokens: 0,
      exceeded: true,
    })
    expect(summary.limits.find(limit => limit.period === 'month')).toMatchObject({
      enabled: true,
      limitTokens: 1000,
      usedTokens: 100,
      remainingTokens: 900,
      exceeded: false,
    })
    expect(() => service.assertWorkspaceCanStartModelRun(auth())).toThrow(/今日模型 token 用量已达到上限/)
  })

  it('只汇总当前对话的全部运行', () => {
    const service = new UsageStatsService(fakeStore([
      run('run_thread_a_1', {
        threadId: 'thread_a',
        runtimeStats: {
          modelInputTokens: 100,
          modelOutputTokens: 10,
          modelCacheHitInputTokens: 40,
          modelCacheMeasuredInputTokens: 100,
          modelUsageResponseCount: 1,
        },
      }),
      run('run_thread_a_2', {
        threadId: 'thread_a',
        runtimeStats: {
          modelInputTokens: 50,
          modelOutputTokens: 5,
          modelCacheHitInputTokens: 25,
          modelCacheMeasuredInputTokens: 50,
          modelUsageResponseCount: 1,
        },
      }),
      run('run_thread_b', {
        threadId: 'thread_b',
        runtimeStats: {
          modelInputTokens: 1_000,
          modelOutputTokens: 100,
          modelUsageResponseCount: 1,
        },
      }),
    ]), env())

    const summary = service.summarizeThread('thread_a')

    expect(summary.threadId).toBe('thread_a')
    expect(summary.totals).toMatchObject({
      runCount: 2,
      inputTokens: 150,
      outputTokens: 15,
      cacheHitInputTokens: 65,
      cacheMeasuredInputTokens: 150,
    })
  })

  it('按目标对话的真实工作区汇总，而不是认证默认工作区', () => {
    const store = fakeStore([
      run('run_default_workspace', {
        threadId: 'thread_default',
        workspaceId: 'workspace_test',
        runtimeStats: {
          modelInputTokens: 1_000,
          modelOutputTokens: 100,
          modelTotalTokens: 1_100,
          modelUsageResponseCount: 1,
        },
      }),
      run('run_secondary_target', {
        threadId: 'thread_secondary',
        workspaceId: 'workspace_secondary',
        runtimeStats: {
          modelInputTokens: 70,
          modelOutputTokens: 7,
          modelTotalTokens: 77,
          modelUsageResponseCount: 1,
        },
      }),
      run('run_secondary_other_thread', {
        threadId: 'thread_secondary_other',
        workspaceId: 'workspace_secondary',
        runtimeStats: {
          modelInputTokens: 900,
          modelOutputTokens: 90,
          modelTotalTokens: 990,
          modelUsageResponseCount: 1,
        },
      }),
    ])
    const service = new UsageStatsService(store, env())

    const summary = service.summarizeThread('thread_secondary')

    expect(store.getThread).toHaveBeenCalledWith('thread_secondary')
    expect(store.listRunsForWorkspace).toHaveBeenCalledWith('workspace_secondary')
    expect(summary.totals).toMatchObject({
      runCount: 1,
      inputTokens: 70,
      outputTokens: 7,
      totalTokens: 77,
    })
  })
})

function fakeStore(runs: AnalysisRun[]): UsageRunReader {
  return {
    getThread: vi.fn((threadId: string) => {
      const matchingRun = runs.find(runRecord => runRecord.threadId === threadId)
      if (!matchingRun) throw new Error(`对话 '${threadId}' 不存在`)
      return { id: threadId, workspaceId: matchingRun.workspaceId }
    }),
    listRunsForWorkspace: vi.fn((workspaceId: string) => (
      runs.filter(runRecord => runRecord.workspaceId === workspaceId)
    )),
  }
}

function auth(): AuthContext {
  return {
    userId: 'user_test',
    subject: 'user_test',
    email: 'user@example.test',
    displayName: 'Usage Tester',
    authSessionId: 'session_test',
    authSessionExpiresAt: null,
    csrfToken: 'csrf_test',
    defaultWorkspaceId: 'workspace_test',
    roles: [{ workspaceId: 'workspace_test', role: 'analyst' }],
  }
}

function run(
  id: string,
  options: {
    createdAt?: string
    status?: RunStatus
    threadId?: string
    workspaceId?: string
    runtimeStats: Record<string, number>
  },
): AnalysisRun {
  const createdAt = options.createdAt ?? '2026-07-09T00:00:00.000Z'
  const threadId = options.threadId ?? `thread_${id}`
  const workspaceId = options.workspaceId ?? 'workspace_test'
  return analysisRunSchema.parse({
    id,
    threadId,
    sessionId: 'session_test',
    workspaceId,
    createdByUserId: 'user_test',
    visibility: 'workspace',
    userQuery: id,
    modelProvider: 'deepseek',
    modelName: 'deepseek-v4-pro',
    status: options.status ?? 'completed',
    createdAt,
    updatedAt: createdAt,
    state: {
      sessionId: 'session_test',
      threadId,
      userQuery: id,
      modelProvider: 'deepseek',
      modelName: 'deepseek-v4-pro',
      runtimeStats: options.runtimeStats,
    },
  })
}

function env(overrides: NodeJS.ProcessEnv = {}): Env {
  return parseEnv({
    API_PORT: '8000',
    API_HOST: '127.0.0.1',
    DATABASE_URL: 'postgres://geo_agent:geo_agent@localhost:5432/geo_agent',
    RUNTIME_ROOT: 'runtime',
    APP_BASE_URL: 'http://localhost:8000',
    BETTER_AUTH_URL: 'http://localhost:8000',
    BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
    ENABLED_TOOL_PROVIDERS: 'geo-platform-plan',
    ...overrides,
  })
}

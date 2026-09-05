// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型用量统计服务
//
//   文件:       usageStatsService.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AuthContext } from '../security/types.js'
import type { Env } from '../framework/env.js'
import type { AnalysisRun,RunStatus } from '../schemas/types.js'
import type { TokenUsageThreadSummary } from '@geo-agent-platform/shared-types'

export interface UsageRunReader {
  getThread(threadId: string): { id: string; workspaceId: string | null }
  listRunsForWorkspace(workspaceId: string): AnalysisRun[]
}

interface UsageTotals {
  runCount: number
  runsWithUsage: number
  runsWithoutUsage: number
  inputTokens: number
  outputTokens: number
  cacheHitInputTokens: number
  cacheMeasuredInputTokens: number
  totalTokens: number
  contextEstimatedTokens: number
  resultCacheHitCount: number
  resultCacheAvoidedRequestCount: number
  resultCacheEstimatedSavedTokens: number
}

interface UsageBucket extends UsageTotals {
  key: string
  label: string
}

interface UsageLimit {
  period: 'day' | 'month'
  label: string
  enabled: boolean
  limitTokens: number | null
  usedTokens: number
  remainingTokens: number | null
  exceeded: boolean
  resetsAt: string
}

interface UsageRun {
  runId: string
  threadId: string | null
  sessionId: string
  userQuery: string
  modelProvider: string | null
  modelName: string | null
  status: RunStatus
  createdAt: string
  updatedAt: string
  inputTokens: number
  outputTokens: number
  cacheHitInputTokens: number
  cacheMeasuredInputTokens: number
  resultCacheHitCount: number
  resultCacheAvoidedRequestCount: number
  resultCacheEstimatedSavedTokens: number
  totalTokens: number
  contextEstimatedTokens: number
  contextUsagePermille: number | null
  usageResponseCount: number
  hasUsage: boolean
}

export interface TokenUsageSummary {
  workspaceId: string
  generatedAt: string
  totals: UsageTotals
  limits: UsageLimit[]
  byProvider: UsageBucket[]
  byModel: UsageBucket[]
  byStatus: UsageBucket[]
  recentRuns: UsageRun[]
  warnings: string[]
}

export class UsageStatsService {
  constructor(
    private readonly store: UsageRunReader,
    private readonly env: Env,
  ) {}

  summarizeWorkspace(auth: AuthContext): TokenUsageSummary {
    const workspaceId = auth.defaultWorkspaceId
    const runs = this.store.listRunsForWorkspace(workspaceId)
    const usageRuns = runs.map(toUsageRun)
    const generatedAt = new Date()
    const totals = aggregate(usageRuns)
    const limits = this.limits(usageRuns, generatedAt)
    const warnings: string[] = []
    if (totals.runsWithoutUsage > 0) {
      warnings.push(`有 ${totals.runsWithoutUsage} 个运行没有模型 provider 返回的 usage；它们可能是确定性工具链、失败运行、旧历史或尚未产生模型响应的运行。`)
    }
    if (usageRuns.some(run => run.contextEstimatedTokens > 0)) {
      warnings.push('上下文估算词元来自本地上下文装配器，只用于容量判断，不等同于 provider 账单。')
    }
    return {
      workspaceId,
      generatedAt: generatedAt.toISOString(),
      totals,
      limits,
      byProvider: buckets(usageRuns, run => run.modelProvider ?? 'unreported', run => run.modelProvider ?? '未记录 Provider'),
      byModel: buckets(usageRuns, run => `${run.modelProvider ?? 'unreported'}:${run.modelName ?? 'unreported'}`, run => run.modelName ?? '未记录模型'),
      byStatus: buckets(usageRuns, run => run.status, run => statusLabel(run.status)),
      recentRuns: usageRuns.slice(0, 50),
      warnings,
    }
  }

  summarizeThread(threadId: string): TokenUsageThreadSummary {
    const thread = this.store.getThread(threadId)
    if (!thread.workspaceId) {
      throw new Error(`对话 '${thread.id}' 缺少 workspaceId，无法统计模型用量。`)
    }
    const usageRuns = this.store.listRunsForWorkspace(thread.workspaceId)
      .filter(run => run.threadId === threadId)
      .map(toUsageRun)
    return {
      threadId,
      generatedAt: new Date().toISOString(),
      totals: aggregate(usageRuns),
    }
  }

  assertWorkspaceCanStartModelRun(auth: AuthContext): void {
    const summary = this.summarizeWorkspace(auth)
    const exceeded = summary.limits.find(limit => limit.enabled && limit.exceeded)
    if (exceeded) {
      throw new Error(`${exceeded.label}模型 token 用量已达到上限：已用 ${exceeded.usedTokens.toLocaleString('zh-CN')} / ${exceeded.limitTokens?.toLocaleString('zh-CN')}，重置时间 ${exceeded.resetsAt}。`)
    }
  }

  private limits(runs: UsageRun[], now: Date): UsageLimit[] {
    const day = windowLimit('day', '今日', this.env.USAGE_DAILY_TOTAL_TOKEN_LIMIT, runs, now)
    const month = windowLimit('month', '本月', this.env.USAGE_MONTHLY_TOTAL_TOKEN_LIMIT, runs, now)
    return [day, month]
  }
}

function toUsageRun(run: AnalysisRun): UsageRun {
  const stats = run.state.runtimeStats
  const inputTokens = stat(stats.modelInputTokens)
  const outputTokens = stat(stats.modelOutputTokens)
  const cacheHitInputTokens = stat(stats.modelCacheHitInputTokens)
  const totalTokens = stat(stats.modelTotalTokens)
  const usageResponseCount = stat(stats.modelUsageResponseCount)
  const persistedCacheMeasuredInputTokens = stat(stats.modelCacheMeasuredInputTokens)
  const cacheMeasuredInputTokens = Math.min(inputTokens, persistedCacheMeasuredInputTokens)
  return {
    runId: run.id,
    threadId: run.threadId,
    sessionId: run.sessionId,
    userQuery: run.userQuery,
    modelProvider: run.modelProvider,
    modelName: run.modelName,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    inputTokens,
    outputTokens,
    cacheHitInputTokens,
    cacheMeasuredInputTokens,
    resultCacheHitCount: stat(stats.modelResultCacheHitCount),
    resultCacheAvoidedRequestCount: stat(stats.modelResultCacheAvoidedRequestCount),
    resultCacheEstimatedSavedTokens: stat(stats.modelResultCacheEstimatedSavedTokens),
    totalTokens,
    contextEstimatedTokens: stat(stats.contextEstimatedTokens),
    contextUsagePermille: nullableStat(stats.contextUsagePermille),
    usageResponseCount,
    hasUsage: usageResponseCount > 0 || inputTokens > 0 || outputTokens > 0 || totalTokens > 0,
  }
}

function buckets(
  runs: UsageRun[],
  keyOf: (run: UsageRun) => string,
  labelOf: (run: UsageRun) => string,
): UsageBucket[] {
  const grouped = new Map<string, UsageBucket>()
  for (const run of runs) {
    const key = keyOf(run)
    const previous = grouped.get(key) ?? { key, label: labelOf(run), ...emptyTotals() }
    grouped.set(key, addRun(previous, run))
  }
  return [...grouped.values()].sort((left, right) => right.totalTokens - left.totalTokens || right.runCount - left.runCount)
}

function aggregate(runs: UsageRun[]): UsageTotals {
  return runs.reduce((total, run) => addRun(total, run), emptyTotals())
}

function addRun<T extends UsageTotals>(total: T, run: UsageRun): T {
  total.runCount += 1
  total.runsWithUsage += run.hasUsage ? 1 : 0
  total.runsWithoutUsage += run.hasUsage ? 0 : 1
  total.inputTokens += run.inputTokens
  total.outputTokens += run.outputTokens
  total.cacheHitInputTokens += run.cacheHitInputTokens
  total.cacheMeasuredInputTokens += run.cacheMeasuredInputTokens
  total.totalTokens += run.totalTokens
  total.contextEstimatedTokens += run.contextEstimatedTokens
  total.resultCacheHitCount += run.resultCacheHitCount
  total.resultCacheAvoidedRequestCount += run.resultCacheAvoidedRequestCount
  total.resultCacheEstimatedSavedTokens += run.resultCacheEstimatedSavedTokens
  return total
}

function emptyTotals(): UsageTotals {
  return {
    runCount: 0,
    runsWithUsage: 0,
    runsWithoutUsage: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitInputTokens: 0,
    cacheMeasuredInputTokens: 0,
    totalTokens: 0,
    contextEstimatedTokens: 0,
    resultCacheHitCount: 0,
    resultCacheAvoidedRequestCount: 0,
    resultCacheEstimatedSavedTokens: 0,
  }
}

function stat(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

function nullableStat(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null
}

function statusLabel(status: RunStatus): string {
  switch (status) {
    case 'queued': return '排队中'
    case 'running': return '运行中'
    case 'clarification_needed': return '等待澄清'
    case 'waiting_approval': return '等待审批'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    case 'interrupted': return '已中断'
    case 'requires_action': return '需要操作'
    default: return status
  }
}

function windowLimit(
  period: 'day' | 'month',
  label: string,
  configuredLimit: number,
  runs: UsageRun[],
  now: Date,
): UsageLimit {
  const start = period === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const reset = period === 'day'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const usedTokens = runs
    .filter(run => Date.parse(run.createdAt) >= start.getTime())
    .reduce((total, run) => total + run.totalTokens, 0)
  const enabled = configuredLimit > 0
  return {
    period,
    label,
    enabled,
    limitTokens: enabled ? configuredLimit : null,
    usedTokens,
    remainingTokens: enabled ? Math.max(0, configuredLimit - usedTokens) : null,
    exceeded: enabled && usedTokens >= configuredLimit,
    resetsAt: reset.toISOString(),
  }
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型词元用量统计面板
//
//   文件:       UsageManagementPanel.tsx
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { TokenUsageBucket,TokenUsageLimit,TokenUsageRun,TokenUsageSummary } from '@geo-agent-platform/shared-types'
import { AlertTriangle,BarChart3 } from 'lucide-react'

import { StatusPill } from '../../shared/components/StatusPill'

interface UsageManagementPanelProps {
  summary?: TokenUsageSummary
}

export function UsageManagementPanel({ summary }: UsageManagementPanelProps) {
  if (!summary) {
    return (
      <main className="tool-management__detail tool-management__detail--extensions">
        <section className="panel usage-panel ui-page-section">
          <PanelTitle eyebrow="模型计量" title="词元用量" />
          <div className="panel__section">
            <div className="panel__empty">正在加载真实用量统计…</div>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="tool-management__detail tool-management__detail--extensions">
      <section className="panel usage-panel ui-page-section">
        <PanelTitle eyebrow="模型计量" title="词元用量" count={summary.totals.runCount} />
        <div className="usage-metric-grid">
          <MetricCard label="输入词元" value={formatNumber(summary.totals.inputTokens)} hint={`${summary.totals.runsWithUsage} 个运行已报告实际用量`} />
          <MetricCard label="输出词元" value={formatNumber(summary.totals.outputTokens)} hint="来自模型服务返回的用量数据" />
          <MetricCard
            label="供应商缓存命中"
            value={formatNumber(summary.totals.cacheHitInputTokens)}
            hint={cacheHitRateHint(summary.totals.cacheHitInputTokens, summary.totals.cacheMeasuredInputTokens)}
          />
          <MetricCard label="结果缓存命中" value={formatNumber(summary.totals.resultCacheHitCount)} hint={`避免 ${formatNumber(summary.totals.resultCacheAvoidedRequestCount)} 次请求，估算节省 ${formatNumber(summary.totals.resultCacheEstimatedSavedTokens)} 词元`} />
          <MetricCard label="总词元" value={formatNumber(summary.totals.totalTokens)} hint={`${summary.totals.runsWithoutUsage} 个运行未报告实际用量`} />
        </div>
        <div className="usage-limit-grid">
          {summary.limits.map((limit) => <UsageLimitCard key={limit.period} limit={limit} />)}
        </div>
        {summary.warnings.length ? (
          <div className="usage-warning-list" role="note" aria-label="统计说明">
            {summary.warnings.map((warning) => (
              <p key={warning}><AlertTriangle size={15} aria-hidden="true" />{warning}</p>
            ))}
          </div>
        ) : null}
      </section>

      <div className="usage-grid">
        <UsageBucketPanel title="按服务提供方" buckets={summary.byProvider} />
        <UsageBucketPanel title="按模型" buckets={summary.byModel} />
        <UsageBucketPanel title="按运行状态" buckets={summary.byStatus} />
      </div>

      <section className="panel usage-panel ui-page-section">
        <PanelTitle eyebrow="最近运行" title="最近运行明细" count={summary.recentRuns.length} />
        <div className="usage-run-table" role="table" aria-label="最近运行用量">
          <div className="usage-run-table__row usage-run-table__row--head" role="row">
            <span>运行</span>
            <span>模型</span>
            <span>输入</span>
            <span>输出</span>
            <span>缓存命中</span>
            <span>状态</span>
          </div>
          {summary.recentRuns.length ? summary.recentRuns.map((run) => <UsageRunRow key={run.runId} run={run} />) : (
            <div className="panel__empty">当前工作区还没有运行记录。</div>
          )}
        </div>
      </section>
    </main>
  )
}

function UsageLimitCard({ limit }: { limit: TokenUsageLimit }) {
  const tone = limit.enabled && limit.exceeded ? 'danger' : limit.enabled ? 'success' : 'accent'
  return (
    <article className="usage-limit-card">
      <div>
        <span>{limit.label}限制</span>
        <strong>{limit.enabled ? `${formatNumber(limit.usedTokens)} / ${formatNumber(limit.limitTokens ?? 0)}` : `${formatNumber(limit.usedTokens)} 已用`}</strong>
        <p>{limit.enabled ? `剩余 ${formatNumber(limit.remainingTokens ?? 0)} 词元` : '未启用硬限制'}</p>
      </div>
      <StatusPill label={limit.enabled ? (limit.exceeded ? '已达上限' : '生效中') : '未启用'} tone={tone} />
      <small>重置：{formatDateTime(limit.resetsAt)}</small>
    </article>
  )
}

function UsageBucketPanel({ title, buckets }: { title: string; buckets: TokenUsageBucket[] }) {
  return (
    <section className="panel usage-panel ui-page-section">
      <PanelTitle eyebrow="分类统计" title={title} count={buckets.length} />
      <div className="usage-bucket-list">
        {buckets.length ? buckets.slice(0, 8).map((bucket) => (
          <article className="usage-bucket-row" key={bucket.key}>
            <div>
              <strong>{bucket.label}</strong>
              <span>{bucket.runCount} 运行 · {bucket.runsWithoutUsage} 未报告</span>
            </div>
            <div>
              <strong>{formatNumber(bucket.totalTokens)} 词元</strong>
              <span>输入 {formatNumber(bucket.inputTokens)} · 输出 {formatNumber(bucket.outputTokens)} · 缓存命中 {formatNumber(bucket.cacheHitInputTokens)} / 可测输入 {formatNumber(bucket.cacheMeasuredInputTokens)} · {cacheHitRate(bucket.cacheHitInputTokens, bucket.cacheMeasuredInputTokens)}</span>
            </div>
          </article>
        )) : <div className="panel__empty">暂无分组数据。</div>}
      </div>
    </section>
  )
}

function UsageRunRow({ run }: { run: TokenUsageRun }) {
  return (
    <div className="usage-run-table__row" role="row">
      <span title={run.userQuery}>{run.userQuery}</span>
      <span>{run.modelName ?? run.modelProvider ?? '未记录'}</span>
      <span>{run.hasUsage ? formatNumber(run.inputTokens) : '未报告'}</span>
      <span>{run.hasUsage ? formatNumber(run.outputTokens) : '未报告'}</span>
      <span>{run.cacheMeasuredInputTokens > 0 ? formatNumber(run.cacheHitInputTokens) : '未报告'}</span>
      <span>{run.status}</span>
    </div>
  )
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <article className="usage-metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{hint}</p>
    </article>
  )
}

function cacheHitRate(hit: number, measuredInput: number): string {
  return measuredInput > 0 ? `${Math.round(hit / measuredInput * 100)}%` : '未报告'
}

function cacheHitRateHint(hit: number, measuredInput: number): string {
  return measuredInput > 0
    ? `${cacheHitRate(hit, measuredInput)} 命中率，仅采用供应商明细`
    : '供应商未返回缓存明细'
}

function PanelTitle({ eyebrow, title, count }: { eyebrow: string; title: string; count?: number }) {
  return (
    <div className="panel__header">
      <div>
        <div className="panel__eyebrow">{eyebrow}</div>
        <h2>{title}</h2>
      </div>
      {typeof count === 'number' ? <StatusPill label={`${count}`} tone="accent" /> : <BarChart3 size={17} aria-hidden="true" />}
    </div>
  )
}

function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN')
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

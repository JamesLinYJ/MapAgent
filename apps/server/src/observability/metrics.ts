// +-------------------------------------------------------------------------
//
//   地理智能平台 - Prometheus 指标
//
//   文件:       metrics.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 暴露 /metrics 端点，覆盖 HTTP、WS、工具、Worker、JSONL queue。
// 所有指标带 service=geo-agent-platform-api label，避免多服务指标冲突。

import { collectDefaultMetrics,Counter,Gauge,Histogram,register } from 'prom-client'
import type { Context,Next } from 'hono'
import { routePath } from 'hono/route'

collectDefaultMetrics({ prefix: 'geo_agent_platform_', labels: { service: 'geo-agent-platform-api' } })

// HTTP
export const httpRequestsTotal = new Counter({
  name: 'geo_agent_platform_http_requests_total',
  help: 'HTTP 请求总数',
  labelNames: ['method', 'route', 'status'],
})

export const httpRequestDurationMs = new Histogram({
  name: 'geo_agent_platform_http_request_duration_ms',
  help: 'HTTP 请求耗时 (ms)',
  labelNames: ['method', 'route'],
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
})

// WebSocket
export const wsConnectionsActive = new Gauge({
  name: 'geo_agent_platform_ws_connections_active',
  help: '活跃 WebSocket 连接数',
})

export const wsMessagesTotal = new Counter({
  name: 'geo_agent_platform_ws_messages_total',
  help: 'WebSocket 消息总数',
  labelNames: ['type', 'direction'],
})

// Automation
export const automationRunsTotal = new Counter({
  name: 'geo_agent_platform_automation_runs_total',
  help: 'Automation 运行终态总数',
  labelNames: ['trigger', 'status'],
})

export const automationNodeExecutionsTotal = new Counter({
  name: 'geo_agent_platform_automation_node_executions_total',
  help: 'Automation 节点执行总数',
  labelNames: ['node_type', 'status'],
})

export const automationNodeDurationMs = new Histogram({
  name: 'geo_agent_platform_automation_node_duration_ms',
  help: 'Automation 节点执行耗时 (ms)',
  labelNames: ['node_type'],
  buckets: [5, 25, 100, 500, 1000, 5000, 15000, 60000, 300000],
})

// Model / Responses API
export const modelRequestsTotal = new Counter({
  name: 'geo_agent_platform_model_requests_total',
  help: '模型请求总数',
  labelNames: ['provider', 'model', 'transport', 'status'],
})

export const modelRequestDurationMs = new Histogram({
  name: 'geo_agent_platform_model_request_duration_ms',
  help: '模型请求总耗时 (ms)',
  labelNames: ['provider', 'model', 'transport'],
  buckets: [100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 180000],
})

export const modelTimeToResponseStartedMs = new Histogram({
  name: 'geo_agent_platform_model_time_to_response_started_ms',
  help: '模型请求从发起到收到 response_started 的耗时 (ms)',
  labelNames: ['provider', 'model', 'transport'],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
})

export const modelTimeToFirstTextDeltaMs = new Histogram({
  name: 'geo_agent_platform_model_first_text_delta_ms',
  help: '模型请求从发起到首个文本增量的耗时 (ms)',
  labelNames: ['provider', 'model', 'transport'],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
})

export const modelTokensTotal = new Counter({
  name: 'geo_agent_platform_model_tokens_total',
  help: '模型服务返回的实际词元用量',
  labelNames: ['provider', 'model', 'transport', 'kind'],
})

// JSONL storage
export const jsonlQueueDepth = new Gauge({
  name: 'geo_agent_platform_jsonl_queue_depth',
  help: 'JSONL 写入队列深度',
  labelNames: ['scope'],
})

export const jsonlFlushLatencyMs = new Histogram({
  name: 'geo_agent_platform_jsonl_flush_latency_ms',
  help: 'JSONL flush 延迟 (ms)',
  labelNames: ['scope'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
})

export const applicationInstanceLockHeld = new Gauge({
  name: 'geo_agent_platform_application_instance_lock_held',
  help: '当前进程是否持有 PostgreSQL 平台单写实例锁（1=持有，0=未持有）',
})

export const runtimeMutationQueueDepth = new Gauge({
  name: 'geo_agent_platform_runtime_mutation_queue_depth',
  help: '运行时跨文件变更队列深度',
  labelNames: ['scope'],
})

export const runtimeMutationFailuresTotal = new Counter({
  name: 'geo_agent_platform_runtime_mutation_failures_total',
  help: '运行时跨文件变更导致队列关闭的失败总数',
  labelNames: ['scope'],
})

export const runDomainReplayComparisonsTotal = new Counter({
  name: 'geo_agent_platform_run_domain_replay_comparisons_total',
  help: 'Run 领域日志 reducer 与同事务事实的 shadow 比对总数',
  labelNames: ['scope', 'outcome'],
})

export const runDomainProjectionInspectionsTotal = new Counter({
  name: 'geo_agent_platform_run_domain_projection_inspections_total',
  help: 'Run 领域日志从 sequence 0 完整重放及事实核对结果',
  labelNames: ['outcome', 'reason'],
})

export const runDomainProjectionSequenceDistanceRecords = new Histogram({
  name: 'geo_agent_platform_run_domain_projection_sequence_distance_records',
  help: 'Run 领域事件事实游标与持久 snapshot 游标的绝对距离',
  buckets: [0, 1, 2, 4, 8, 16, 32, 64, 128],
})

export const runPresentationProjectionLagRecords = new Histogram({
  name: 'geo_agent_platform_run_presentation_projection_lag_records',
  help: 'Run 展示记录事实游标与成功 reducer 游标之间的记录数',
  buckets: [0, 1, 2, 4, 8, 16, 32, 64, 128],
})

export const runPresentationProjectionFailuresTotal = new Counter({
  name: 'geo_agent_platform_run_presentation_projection_failures_total',
  help: 'Run 展示记录因 sequence、schema 或稳定 ID 冲突而重放失败的总数',
  labelNames: ['reason'],
})

// Metrics endpoint handler
export async function metricsResponse(): Promise<Response> {
  return new Response(await register.metrics(), {
    headers: { 'Content-Type': register.contentType },
  })
}

export async function observeHttpMetrics(c: Context, next: Next): Promise<void> {
  const started = performance.now()
  try {
    await next()
  } finally {
    const route = normalizedRouteLabel(c)
    const status = String(c.res.status || 200)
    const method = c.req.method
    httpRequestsTotal.inc({ method, route, status })
    httpRequestDurationMs.observe({ method, route }, performance.now() - started)
  }
}

export function normalizedRouteLabel(c: Context): string {
  const matched = routePath(c, -1)
  return matched && matched !== '*' && matched !== '/*' ? matched : 'unmatched'
}

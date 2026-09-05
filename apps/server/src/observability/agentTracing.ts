// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 本地追踪处理器
//
//   文件:       agentTracing.ts
//
//   日期:       2026年07月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  setTraceProcessors,
  setTracingDisabled,
  type Span,
  type SpanData,
  type Trace,
  type TracingProcessor,
} from '@openai/agents'

import { logger } from './logger.js'

const RUN_TRACE_BUDGET_BYTES = 2 * 1024 * 1024
const GLOBAL_TRACE_BUDGET_BYTES = 16 * 1024 * 1024
const TRACE_RETENTION_MS = 30 * 60_000

interface TraceBudgetRecord {
  runId: string
  bytes: number
  recordedAt: number
}

interface TraceLogRecord {
  level: 'debug' | 'info' | 'error'
  message: string
  payload: Record<string, unknown>
}

/**
 * SDK Trace/Span 只投影到 Supervisor 的内存诊断流；不得复用 RunEventSink，
 * 否则高频 Span 会被误当作业务事实持久化到 PostgreSQL。
 */
export class LocalAgentTracing implements TracingProcessor {
  private readonly activeRuns = new Set<string>()
  private readonly budgetRecords: TraceBudgetRecord[] = []
  private installed = false

  constructor(
    private readonly write: (record: TraceLogRecord) => void = record => {
      logger[record.level](record.payload, record.message)
    },
    private readonly now: () => number = Date.now,
  ) {}

  install(): void {
    if (this.installed) return
    setTraceProcessors([this])
    setTracingDisabled(false)
    this.installed = true
  }

  attachRun(runId: string): () => void {
    if (!this.installed) throw new Error('Agents SDK 本地追踪处理器尚未安装')
    if (this.activeRuns.has(runId)) throw new Error(`运行 '${runId}' 已绑定追踪事件流`)
    this.activeRuns.add(runId)
    return () => this.activeRuns.delete(runId)
  }

  async onTraceStart(trace: Trace): Promise<void> {
    this.emit(trace.metadata, {
      level: 'debug',
      message: 'SDK Trace 开始',
      payload: {
        event: 'agent.sdk.trace.started',
        category: 'agent',
        retention: 'diagnostic',
        phase: 'trace_start',
        traceId: trace.traceId,
      },
    })
  }

  async onTraceEnd(trace: Trace): Promise<void> {
    this.emit(trace.metadata, {
      level: 'debug',
      message: 'SDK Trace 结束',
      payload: {
        event: 'agent.sdk.trace.completed',
        category: 'agent',
        retention: 'diagnostic',
        phase: 'trace_end',
        traceId: trace.traceId,
      },
    })
  }

  async onSpanStart(_span: Span<SpanData>): Promise<void> {}

  async onSpanEnd(span: Span<SpanData>): Promise<void> {
    const summary = summarizeSpan(span.spanData)
    const durationMs = durationBetween(span.startedAt, span.endedAt)
    const failed = span.error !== null
    this.emit(span.traceMetadata, {
      level: 'debug',
      message: `SDK ${summary.label}${failed ? '失败' : '完成'}`,
      payload: {
        event: `agent.sdk.span.${failed ? 'failed' : 'completed'}`,
        category: 'agent',
        retention: 'diagnostic',
        phase: 'span_end',
        traceId: span.traceId,
        spanId: span.spanId,
        spanType: span.spanData.type,
        durationMs,
        failed,
        ...summary.details,
      },
    })
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {
    if (!this.installed) return
    // SDK 在替换 processor 时会回调旧 processor.shutdown()。先撤销本实例的
    // installed 标记，避免 setTraceProcessors([]) 重新进入本方法形成递归。
    this.installed = false
    this.activeRuns.clear()
    this.budgetRecords.length = 0
    setTracingDisabled(true)
    setTraceProcessors([])
  }

  private emit(metadata: unknown, record: TraceLogRecord): void {
    const runId = recordString(metadata, 'runId')
    if (!runId || !this.activeRuns.has(runId)) return
    const threadId = recordString(metadata, 'threadId')
    const provider = recordString(metadata, 'provider')
    const payload = {
      ...record.payload,
      runId,
      ...(threadId ? { threadId } : {}),
      ...(provider ? { provider } : {}),
    }
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
    if (!this.reserveBudget(runId, bytes)) return
    this.write({ ...record, payload })
  }

  private reserveBudget(runId: string, bytes: number): boolean {
    const cutoff = this.now() - TRACE_RETENTION_MS
    while ((this.budgetRecords[0]?.recordedAt ?? Number.POSITIVE_INFINITY) < cutoff) {
      this.budgetRecords.shift()
    }
    const globalBytes = this.budgetRecords.reduce((total, record) => total + record.bytes, 0)
    const runBytes = this.budgetRecords.reduce(
      (total, record) => total + (record.runId === runId ? record.bytes : 0),
      0,
    )
    if (bytes > RUN_TRACE_BUDGET_BYTES || runBytes + bytes > RUN_TRACE_BUDGET_BYTES) return false
    if (globalBytes + bytes > GLOBAL_TRACE_BUDGET_BYTES) return false
    this.budgetRecords.push({ runId, bytes, recordedAt: this.now() })
    return true
  }
}

function summarizeSpan(data: SpanData): {
  label: string
  details: Record<string, unknown>
} {
  switch (data.type) {
    case 'task':
      return {
        label: '任务 Span',
        details: {
          requests: data.usage?.requests ?? null,
          totalTokens: data.usage?.total_tokens ?? null,
        },
      }
    case 'turn':
      return {
        label: '轮次 Span',
        details: {
          turn: data.turn,
          inputTokens: data.usage?.input_tokens ?? null,
          outputTokens: data.usage?.output_tokens ?? null,
        },
      }
    case 'agent':
      return { label: 'Agent Span', details: { agentName: data.name } }
    case 'function':
      return { label: '工具 Span', details: { toolName: data.name, mcp: Boolean(data.mcp_data) } }
    case 'generation':
      return {
        label: '模型 Span',
        details: {
          model: data.model ?? null,
          inputTokens: data.usage?.input_tokens ?? null,
          outputTokens: data.usage?.output_tokens ?? null,
          totalTokens: data.usage?.total_tokens ?? null,
        },
      }
    case 'response':
      return { label: '响应 Span', details: { responseId: data.response_id ?? null } }
    case 'handoff':
      return {
        label: 'Handoff Span',
        details: { fromAgent: data.from_agent ?? null, toAgent: data.to_agent ?? null },
      }
    case 'guardrail':
      return { label: 'Guardrail Span', details: { guardrailName: data.name, triggered: data.triggered } }
    case 'mcp_tools':
      return {
        label: 'MCP 工具发现 Span',
        details: { server: data.server ?? null, toolCount: Array.isArray(data.result) ? data.result.length : null },
      }
    case 'custom':
      return { label: '自定义 Span', details: { spanName: data.name } }
    case 'transcription':
      return { label: '转写 Span', details: { model: data.model ?? null, format: data.input.format } }
    case 'speech':
      return { label: '语音 Span', details: { model: data.model ?? null, format: data.output.format } }
    case 'speech_group':
      return { label: '语音组 Span', details: {} }
  }
}

function durationBetween(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null
  const duration = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isFinite(duration) && duration >= 0 ? duration : null
}

function recordString(value: unknown, key: string): string | null {
  if (!isUnknownRecord(value)) return null
  const candidate = value[key]
  return typeof candidate === 'string' && candidate.length ? candidate : null
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

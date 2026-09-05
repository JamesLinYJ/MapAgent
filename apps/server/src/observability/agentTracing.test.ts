// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 本地追踪处理器测试
//
//   文件:       agentTracing.test.ts
//
//   日期:       2026年07月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { Span, Trace } from '@openai/agents'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'
import { describe, expect, it } from 'vitest'

import { LocalAgentTracing } from './agentTracing.js'

describe('LocalAgentTracing', () => {
  it('routes sanitized SDK lifecycle records to the owning run diagnostic stream only', async () => {
    const records: Array<{
      level: 'debug' | 'info' | 'error'
      message: string
      payload: Record<string, unknown>
    }> = []
    const tracing = new LocalAgentTracing(record => { records.push(record) })
    tracing.install()
    const detach = tracing.attachRun('run_trace')
    try {
      const trace = new Trace({
        traceId: 'trace_0123456789abcdef0123456789abcdef',
        name: `${PRODUCT_CODENAME} Agent Workflow`,
        groupId: 'thread_trace',
        metadata: { runId: 'run_trace', threadId: 'thread_trace' },
      }, tracing)
      const span = new Span({
        traceId: trace.traceId,
        spanId: 'span_0123456789abcdef0123456789abcdef',
        parentId: undefined,
        traceMetadata: { runId: 'run_trace', threadId: 'thread_trace' },
        startedAt: '2026-07-21T00:00:00.000Z',
        endedAt: '2026-07-21T00:00:00.125Z',
        data: {
          type: 'function',
          name: 'query_layer',
          input: 'SECRET_INPUT_MUST_NOT_BE_PERSISTED',
          output: 'SECRET_OUTPUT_MUST_NOT_BE_PERSISTED',
        },
      }, tracing)

      await tracing.onTraceStart(trace)
      await tracing.onSpanEnd(span)
      await tracing.onTraceEnd(trace)
      await tracing.forceFlush()

      expect(records.map(record => record.payload.event)).toEqual([
        'agent.sdk.trace.started',
        'agent.sdk.span.completed',
        'agent.sdk.trace.completed',
      ])
      expect(records[1]).toMatchObject({
        message: 'SDK 工具 Span完成',
        payload: {
          category: 'agent',
          retention: 'diagnostic',
          phase: 'span_end',
          spanType: 'function',
          toolName: 'query_layer',
          durationMs: 125,
          failed: false,
        },
      })
      expect(JSON.stringify(records)).not.toContain('SECRET_INPUT_MUST_NOT_BE_PERSISTED')
      expect(JSON.stringify(records)).not.toContain('SECRET_OUTPUT_MUST_NOT_BE_PERSISTED')
    } finally {
      detach()
      await tracing.shutdown()
    }
  })

  it('ignores traces that do not declare a registered platform runId', async () => {
    const records: Array<{ level: 'debug' | 'info' | 'error'; message: string; payload: Record<string, unknown> }> = []
    const tracing = new LocalAgentTracing(record => { records.push(record) })
    tracing.install()
    const detach = tracing.attachRun('run_trace')
    try {
      const unrelated = new Trace({ name: 'Unrelated trace', metadata: { runId: 'run_other' } }, tracing)
      await tracing.onTraceStart(unrelated)
      await tracing.forceFlush()
      expect(records).toEqual([])
    } finally {
      detach()
      await tracing.shutdown()
    }
  })
})

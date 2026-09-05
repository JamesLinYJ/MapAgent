// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型请求遥测
//
//   文件:       modelRequestTelemetry.ts
//
//   日期:       2026年08月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { RunStreamEvent } from '@openai/agents'

import { aggregateModelUsage } from '../model/modelUsage.js'
import {
modelRequestDurationMs,
modelRequestsTotal,
modelTimeToResponseStartedMs,
modelTimeToFirstTextDeltaMs,
modelTokensTotal,
} from './metrics.js'
import { logger } from './logger.js'

interface ActiveModelRequest {
  dispatchedAt: number
  responseStartedAt: number | null
  firstTextDeltaAt: number | null
  responseId: string | null
}

export interface ModelTelemetryContext {
  provider: string
  model: string
  transport: string
  runId?: string
  threadId?: string
}

export interface ModelTelemetryUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheHitInputTokens: number
  cacheMissInputTokens: number
}

/** 只记录 Responses 请求的计量与关联标识，绝不接触提示词和模型正文。 */
export class ModelRequestTelemetry {
  private active: ActiveModelRequest | null = {
    dispatchedAt: performance.now(),
    responseStartedAt: null,
    firstTextDeltaAt: null,
    responseId: null,
  }

  constructor(private readonly context: ModelTelemetryContext & { runId: string; threadId: string }) {}

  observe(event: RunStreamEvent): void {
    if (event.type !== 'raw_model_stream_event') return
    if (event.data.type === 'response_started') {
      const observedAt = performance.now()
      const active = this.active ?? {
        dispatchedAt: observedAt,
        responseStartedAt: null,
        firstTextDeltaAt: null,
        responseId: null,
      }
      active.responseStartedAt ??= observedAt
      active.responseId = responseIdFromStartedEvent(event.data.providerData) ?? active.responseId
      this.active = active
      return
    }
    if (event.data.type === 'output_text_delta') {
      if (event.data.delta && this.active && this.active.firstTextDeltaAt === null) {
        this.active.firstTextDeltaAt = performance.now()
      }
      return
    }
    if (event.data.type !== 'response_done') return

    const completedAt = performance.now()
    const active = this.active ?? {
      dispatchedAt: completedAt,
      responseStartedAt: null,
      firstTextDeltaAt: null,
      responseId: null,
    }
    const responseUsage = event.data.response.usage
    const usage = aggregateModelUsage([{ usage: {
      inputTokens: responseUsage.inputTokens,
      outputTokens: responseUsage.outputTokens,
      totalTokens: responseUsage.totalTokens,
      ...(responseUsage.inputTokensDetails !== undefined
        ? { inputTokensDetails: responseUsage.inputTokensDetails }
        : {}),
    }, ...(event.data.response.rawUsage
      ? { rawUsage: event.data.response.rawUsage }
      : {}) }])
    const durationMs = roundMilliseconds(completedAt - active.dispatchedAt)
    const responseStartedMs = active.responseStartedAt === null
      ? null
      : roundMilliseconds(active.responseStartedAt - active.dispatchedAt)
    const firstTextDeltaMs = active.firstTextDeltaAt === null
      ? null
      : roundMilliseconds(active.firstTextDeltaAt - active.dispatchedAt)
    const responseId = event.data.response.id || active.responseId
    const requestId = event.data.response.requestId
    recordModelRequestCompletion({
      context: this.context,
      responseId,
      requestId: requestId ?? null,
      durationMs,
      timeToResponseStartedMs: responseStartedMs,
      timeToFirstTextDeltaMs: firstTextDeltaMs,
      usage,
    })
    this.active = null
  }

  fail(error: unknown): void {
    const active = this.active
    if (!active) return
    const durationMs = roundMilliseconds(performance.now() - active.dispatchedAt)
    const responseStartedMs = active.responseStartedAt === null
      ? null
      : roundMilliseconds(active.responseStartedAt - active.dispatchedAt)
    recordModelRequestFailure({
      context: this.context,
      responseId: active.responseId,
      durationMs,
      timeToResponseStartedMs: responseStartedMs,
      error,
    })
    this.active = null
  }
}

export function recordModelRequestCompletion(input: {
  context: ModelTelemetryContext
  responseId: string | null
  requestId: string | null
  durationMs: number
  timeToResponseStartedMs: number | null
  timeToFirstTextDeltaMs: number | null
  usage: ModelTelemetryUsage
}): void {
  const labels = metricLabels(input.context)
  modelRequestsTotal.inc({ ...labels, status: 'succeeded' })
  modelRequestDurationMs.observe(labels, input.durationMs)
  if (input.timeToResponseStartedMs !== null) {
    modelTimeToResponseStartedMs.observe(labels, input.timeToResponseStartedMs)
  }
  if (input.timeToFirstTextDeltaMs !== null) {
    modelTimeToFirstTextDeltaMs.observe(labels, input.timeToFirstTextDeltaMs)
  }
  modelTokensTotal.inc({ ...labels, kind: 'input' }, input.usage.inputTokens)
  modelTokensTotal.inc({ ...labels, kind: 'output' }, input.usage.outputTokens)
  modelTokensTotal.inc({ ...labels, kind: 'cached_input' }, input.usage.cacheHitInputTokens)
  logger.info({
    event: 'model.request.completed',
    category: 'model',
    retention: 'operational',
    ...input.context,
    ...(input.responseId ? { responseId: input.responseId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    durationMs: input.durationMs,
    timeToResponseStartedMs: input.timeToResponseStartedMs,
    timeToFirstTextDeltaMs: input.timeToFirstTextDeltaMs,
    ...input.usage,
  }, '模型请求已完成。')
}

export function recordModelRequestFailure(input: {
  context: ModelTelemetryContext
  responseId: string | null
  durationMs: number
  timeToResponseStartedMs: number | null
  error: unknown
}): void {
  const failure = classifyFailure(input.error)
  const labels = metricLabels(input.context)
  modelRequestsTotal.inc({ ...labels, status: 'failed' })
  modelRequestDurationMs.observe(labels, input.durationMs)
  if (input.timeToResponseStartedMs !== null) {
    modelTimeToResponseStartedMs.observe(labels, input.timeToResponseStartedMs)
  }
  logger.error({
    event: 'model.request.failed',
    category: 'model',
    retention: 'operational',
    ...input.context,
    ...(input.responseId ?? failure.responseId
      ? { responseId: input.responseId ?? failure.responseId }
      : {}),
    ...(failure.requestId ? { requestId: failure.requestId } : {}),
    durationMs: input.durationMs,
    timeToResponseStartedMs: input.timeToResponseStartedMs,
    errorType: failure.type,
    ...(failure.code ? { errorCode: failure.code } : {}),
    ...(failure.status !== null ? { statusCode: failure.status } : {}),
  }, '模型请求失败。')
}

function responseIdFromStartedEvent(providerData: Record<string, unknown> | undefined): string | null {
  const response = isRecord(providerData?.response) ? providerData.response : null
  return typeof response?.id === 'string' && response.id ? response.id : null
}

function classifyFailure(error: unknown): {
  type: string
  code: string | null
  status: number | null
  requestId: string | null
  responseId: string | null
} {
  if (!(error instanceof Error)) {
    return { type: 'UnknownError', code: null, status: null, requestId: null, responseId: null }
  }
  const record = error as Error & {
    code?: unknown
    request_id?: unknown
    requestId?: unknown
    response_id?: unknown
    responseId?: unknown
    status?: unknown
    statusCode?: unknown
  }
  const status = typeof record.status === 'number'
    ? record.status
    : typeof record.statusCode === 'number'
      ? record.statusCode
      : null
  return {
    type: error.name || 'Error',
    code: typeof record.code === 'string' ? record.code.slice(0, 80) : null,
    status,
    requestId: boundedIdentifier(record.requestId ?? record.request_id),
    responseId: boundedIdentifier(record.responseId ?? record.response_id),
  }
}

function boundedIdentifier(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : null
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100
}

function metricLabels(context: ModelTelemetryContext): {
  provider: string
  model: string
  transport: string
} {
  return {
    provider: context.provider,
    model: context.model,
    transport: context.transport,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

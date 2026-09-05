// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型请求遥测测试
//
//   文件:       modelRequestTelemetry.test.ts
//
//   日期:       2026年08月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { RunStreamEvent } from '@openai/agents'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { logger } from './logger.js'
import {
  modelRequestDurationMs,
  modelTimeToFirstTextDeltaMs,
  modelTimeToResponseStartedMs,
} from './metrics.js'
import {
  ModelRequestTelemetry,
  recordModelRequestFailure,
} from './modelRequestTelemetry.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ModelRequestTelemetry', () => {
  it('keeps text deltas streaming while emitting one body-free completion summary', () => {
    const info = vi.spyOn(logger, 'info')
    const durationMetric = vi.spyOn(modelRequestDurationMs, 'observe')
    const responseStartedMetric = vi.spyOn(modelTimeToResponseStartedMs, 'observe')
    const firstTextMetric = vi.spyOn(modelTimeToFirstTextDeltaMs, 'observe')
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(35)
      .mockReturnValueOnce(110)
    const telemetry = new ModelRequestTelemetry({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      transport: 'deepseek_responses',
      runId: 'run_1',
      threadId: 'thread_1',
    })

    telemetry.observe(streamEvent({
      type: 'response_started',
      providerData: { response: { id: 'response_1' } },
    }))
    telemetry.observe(streamEvent({ type: 'output_text_delta', delta: '用户可见正文不得进入日志' }))
    expect(info).not.toHaveBeenCalled()
    telemetry.observe(streamEvent({
      type: 'response_done',
      response: {
        id: 'response_1',
        requestId: 'request_1',
        usage: {
          requests: 1,
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
          inputTokensDetails: { cached_tokens: 3 },
        },
        output: [],
      },
    }))

    expect(info).toHaveBeenCalledOnce()
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      event: 'model.request.completed',
      category: 'model',
      retention: 'operational',
      responseId: 'response_1',
      requestId: 'request_1',
      durationMs: 110,
      timeToResponseStartedMs: 10,
      timeToFirstTextDeltaMs: 35,
      inputTokens: 12,
      outputTokens: 8,
      cacheHitInputTokens: 3,
    })
    const labels = {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      transport: 'deepseek_responses',
    }
    expect(durationMetric).toHaveBeenCalledWith(labels, 110)
    expect(responseStartedMetric).toHaveBeenCalledWith(labels, 10)
    expect(firstTextMetric).toHaveBeenCalledWith(labels, 35)
    expect(JSON.stringify(info.mock.calls)).not.toContain('用户可见正文不得进入日志')
  })

  it('keeps total duration valid when the provider omits response_started', () => {
    const info = vi.spyOn(logger, 'info')
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(40)
    const telemetry = new ModelRequestTelemetry({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      transport: 'deepseek_responses',
      runId: 'run_without_started',
      threadId: 'thread_1',
    })

    telemetry.observe(streamEvent({
      type: 'response_done',
      response: {
        id: 'response_without_started',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [],
      },
    }))

    expect(info.mock.calls[0]?.[0]).toMatchObject({
      durationMs: 40,
      timeToResponseStartedMs: null,
      timeToFirstTextDeltaMs: null,
    })
  })

  it('reports failure duration from dispatch without losing a received response_started milestone', () => {
    const errorLog = vi.spyOn(logger, 'error')
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(12)
      .mockReturnValueOnce(55)
    const telemetry = new ModelRequestTelemetry({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      transport: 'deepseek_responses',
      runId: 'run_failed',
      threadId: 'thread_1',
    })

    telemetry.observe(streamEvent({
      type: 'response_started',
      providerData: { response: { id: 'response_failed' } },
    }))
    telemetry.fail(new Error('failure body must not be logged'))

    expect(errorLog.mock.calls[0]?.[0]).toMatchObject({
      responseId: 'response_failed',
      durationMs: 55,
      timeToResponseStartedMs: 12,
      errorType: 'Error',
    })
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('failure body must not be logged')
  })

  it('records only bounded failure classification and correlation identifiers', () => {
    const errorLog = vi.spyOn(logger, 'error')
    const error = Object.assign(new Error('PROMPT_BODY_MUST_NOT_BE_LOGGED'), {
      name: 'APIError',
      code: 'rate_limit_exceeded',
      status: 429,
      request_id: 'request_2',
      response_id: 'response_2',
    })

    recordModelRequestFailure({
      context: { provider: 'deepseek', model: 'deepseek-v4-flash', transport: 'deepseek_responses' },
      responseId: null,
      durationMs: 42,
      timeToResponseStartedMs: null,
      error,
    })

    expect(errorLog).toHaveBeenCalledOnce()
    expect(errorLog.mock.calls[0]?.[0]).toMatchObject({
      event: 'model.request.failed',
      errorType: 'APIError',
      errorCode: 'rate_limit_exceeded',
      statusCode: 429,
      requestId: 'request_2',
      responseId: 'response_2',
      timeToResponseStartedMs: null,
    })
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('PROMPT_BODY_MUST_NOT_BE_LOGGED')
  })
})

function streamEvent(data: Record<string, unknown>): RunStreamEvent {
  return { type: 'raw_model_stream_event', data } as unknown as RunStreamEvent
}

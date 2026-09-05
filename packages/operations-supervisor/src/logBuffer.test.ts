// +-------------------------------------------------------------------------
//
//   地理智能平台 - 监督日志缓冲测试
//
//   文件:       logBuffer.test.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { LineDecoder, OperationsLogBuffer } from './logBuffer.js'

describe('OperationsLogBuffer', () => {
  it('redacts secret assignments and URL userinfo without enumerating environment values', () => {
    const buffer = new OperationsLogBuffer()
    buffer.append({
      serviceId: 'api',
      stream: 'stdout',
      message: 'token=highly-secret-value db=postgresql://geo_agent:db-password@127.0.0.1/runtime',
    })

    expect(buffer.tail(['api'], 1)[0]?.message).toBe(
      'token=[REDACTED] db=postgresql://[REDACTED]@127.0.0.1/runtime',
    )
  })

  it('enforces both entry and byte budgets', () => {
    const buffer = new OperationsLogBuffer(2, 14)
    buffer.append({ serviceId: 'api', stream: 'stdout', message: '12345' })
    buffer.append({ serviceId: 'api', stream: 'stdout', message: '67890' })
    buffer.append({ serviceId: 'api', stream: 'stdout', message: 'abcde' })

    expect(buffer.tail(['api'], 10).map(entry => entry.message)).toEqual(['67890', 'abcde'])
  })

  it('uses ingestion time for the bounded flight-recorder lifetime', () => {
    let now = Date.parse('2026-08-03T00:00:00.000Z')
    const buffer = new OperationsLogBuffer(100, 1_024, {
      diagnosticMaxBytes: 4_096,
      normalRetentionMs: 10 * 60_000,
      diagnosticRetentionMs: 30 * 60_000,
      now: () => now,
    })
    buffer.append({ serviceId: 'api', stream: 'stdout', message: 'DEBUG 诊断记录' })
    buffer.setDiagnosticMode(true)
    now += 11 * 60_000

    expect(buffer.stats()).toMatchObject({ retainedEntries: 1, maxBytes: 4_096 })
    buffer.setDiagnosticMode(false)
    expect(buffer.stats()).toMatchObject({ retainedEntries: 0, maxBytes: 1_024 })
  })

  it('paginates cursor continuations from the oldest unseen entry without gaps', () => {
    const buffer = new OperationsLogBuffer()
    for (let index = 1; index <= 5; index += 1) {
      buffer.append({ serviceId: 'api', stream: 'stdout', message: `INFO ${index}` })
    }
    const query = {
      services: ['api'] as const,
      levels: [],
      streams: [],
      categories: [],
      events: [],
      retentions: [],
      correlationId: '',
      search: '',
      includeSupervisor: false,
      tail: 2,
    }

    expect(buffer.page({ ...query, services: [...query.services], afterSequence: null })).toMatchObject({
      entries: [{ sequence: 4 }, { sequence: 5 }],
      nextCursor: 5,
      hasMore: true,
    })
    expect(buffer.page({ ...query, services: [...query.services], afterSequence: 1 })).toMatchObject({
      entries: [{ sequence: 2 }, { sequence: 3 }],
      nextCursor: 3,
      hasMore: true,
    })
    expect(buffer.page({ ...query, services: [...query.services], afterSequence: 3 })).toMatchObject({
      entries: [{ sequence: 4 }, { sequence: 5 }],
      nextCursor: 5,
      hasMore: false,
    })
  })

  it('decodes split UTF-8 Chinese output without replacement corruption', () => {
    const decoder = new LineDecoder()
    const bytes = Buffer.from('杭州就绪\n下一行', 'utf8')
    const split = bytes.indexOf(Buffer.from('州')) + 1

    expect(decoder.push(bytes.subarray(0, split))).toEqual([])
    expect(decoder.push(bytes.subarray(split))).toEqual(['杭州就绪'])
    expect(decoder.finish()).toEqual(['下一行'])
  })

  it('derives severity from content and strips terminal control sequences', () => {
    const buffer = new OperationsLogBuffer()
    buffer.append({ serviceId: 'worker', stream: 'stderr', message: '\u001b[32mINFO\u001b[0m: 服务就绪' })

    expect(buffer.tail(['worker'], 1)[0]).toMatchObject({
      stream: 'stderr',
      level: 'info',
      message: 'INFO: 服务就绪',
    })
  })

  it('projects Pino JSON and native component prefixes into structured fields', () => {
    const buffer = new OperationsLogBuffer()
    buffer.append({
      serviceId: 'api',
      stream: 'stdout',
      message: JSON.stringify({
        level: 40,
        time: '2026-07-29T06:00:00.000Z',
        pid: 8123,
        name: 'http',
        traceId: 'trace_1',
        runId: 'run_1',
        providerId: 'openai-compatible',
        wsCommand: 'tool-catalog:upsert',
        wsRequestId: 'ws_request_1',
        durationMs: 12_000,
        timeToResponseStartedMs: 11_000,
        timeToFirstTextDeltaMs: 11_800,
        error: {
          name: 'DatabaseError',
          message: '函数不存在',
          code: '42883',
          stack: '不得进入 IPC',
        },
        authorization: 'Bearer should-not-cross-the-boundary',
        msg: '请求等待时间过长',
      }),
    })
    buffer.append({
      serviceId: 'infra',
      stream: 'stdout',
      processId: 9000,
      message: '[postgresql] database system is ready',
    })

    expect(buffer.tail(['api'], 1)[0]).toMatchObject({
      component: 'http',
      processId: 8123,
      level: 'warn',
      message: '请求等待时间过长',
      createdAt: '2026-07-29T06:00:00.000Z',
      correlation: {
        traceId: 'trace_1',
        runId: 'run_1',
        requestId: 'ws_request_1',
      },
      attributes: {
        provider: 'openai-compatible',
        wsCommand: 'tool-catalog:upsert',
        durationMs: 12_000,
        timeToResponseStartedMs: 11_000,
        timeToFirstTextDeltaMs: 11_800,
        errorName: 'DatabaseError',
        errorMessage: '函数不存在',
        errorCode: '42883',
      },
    })
    expect(buffer.tail(['infra'], 1)[0]).toMatchObject({
      component: 'postgresql',
      processId: 9000,
      message: 'database system is ready',
    })
  })

  it('bounds and sanitizes structured diagnostics without forwarding arbitrary fields', () => {
    const buffer = new OperationsLogBuffer()
    const entry = buffer.append({
      serviceId: 'api',
      stream: 'stdout',
      message: JSON.stringify({
        level: 50,
        message: 'run failed',
        runId: 'run_1',
        error: {
          message: 'C:\\Users\\James\\private-secret\\database.ts failed',
          stack: 'large private stack',
        },
        prompt: '用户原始提示词不得进入运维协议',
      }),
    })

    expect(entry.correlation).toEqual({ runId: 'run_1' })
    expect(entry.attributes).toEqual({ errorMessage: '[LOCAL_PATH] failed' })
    expect(entry.errorStack).toBe('large private stack')
    expect(JSON.stringify(entry)).not.toContain('用户原始提示词')
    expect(JSON.stringify(entry)).not.toContain('private-secret')
  })

  it('filters logs by service, level, stream, text and sequence without arbitrary paths', () => {
    const buffer = new OperationsLogBuffer()
    buffer.append({ serviceId: 'api', stream: 'stdout', message: 'INFO API ready' })
    const warning = buffer.append({
      serviceId: 'worker',
      stream: 'stderr',
      message: 'WARNING 杭州数据延迟',
      attributes: {
        event: 'tool.worker.delayed',
        category: 'tool',
        retention: 'operational',
        traceId: 'trace_filter',
      },
    })
    buffer.append({ serviceId: null, stream: 'supervisor', message: '监督器状态变化' })

    expect(buffer.query({
      services: ['worker'],
      levels: ['warn'],
      streams: ['stderr'],
      categories: ['tool'],
      events: ['tool.worker.delayed'],
      retentions: ['operational'],
      correlationId: 'trace_filter',
      search: '杭州',
      includeSupervisor: false,
      afterSequence: warning.sequence - 1,
      tail: 20,
    })).toEqual([warning])
    expect(buffer.query({
      services: ['api'],
      levels: [],
      streams: [],
      categories: [],
      events: [],
      retentions: [],
      correlationId: '',
      search: '',
      includeSupervisor: true,
      afterSequence: null,
      tail: 20,
    }).map(entry => entry.serviceId)).toEqual(['api', null])
  })
})

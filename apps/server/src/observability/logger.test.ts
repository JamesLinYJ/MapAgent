// +-------------------------------------------------------------------------
//
//   地理智能平台 - 结构化日志测试
//
//   文件:       logger.test.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import {
  currentLogContext,
  errorLogPayload,
  sanitizeLogValue,
  withLogContext,
} from './logger.js'

describe('logger sanitization', () => {
  it('redacts sensitive fields and local filesystem paths', () => {
    const sanitized = sanitizeLogValue({
      authorization: 'Bearer secret-token',
      nested: {
        apiKey: 'key-value',
        filePath: 'C:/Users/example/runtime/file.nc',
      },
      message: 'failed at file:///tmp/runtime/file.nc with Bearer abc.def and https://example.test/path?token=secret',
      openaiKey: 'sk-proj-secretvalue',
      systemPrompt: '不要记录系统提示词',
      requestBody: { messages: ['不要记录用户正文'] },
      toolArguments: { source: '不要记录完整工具参数' },
      inputTokens: 123,
    }) as Record<string, unknown>
    const encoded = JSON.stringify(sanitized)

    expect(sanitized.authorization).toBe('[REDACTED]')
    expect(encoded).not.toContain('secret-token')
    expect(encoded).not.toContain('abc.def')
    expect(encoded).not.toContain('sk-proj-secretvalue')
    expect(encoded).not.toContain('token=secret')
    expect(encoded).not.toContain('C:/Users/example')
    expect(encoded).not.toContain('file:///tmp')
    expect(encoded).not.toContain('不要记录')
    expect(encoded).toContain('"inputTokens":123')
    expect(encoded).toContain('[LOCAL_PATH]')
  })

  it('sanitizes error messages and stacks', () => {
    const error = new Error('读取失败 C:/Users/example/runtime/file.nc')
    error.stack = 'Error: failed\n    at fn (C:/Users/example/project/source.ts:10:1)'

    const payload = errorLogPayload(error)

    expect(payload.message).toBe('读取失败 [LOCAL_PATH]')
    expect(payload.stack).toContain('[LOCAL_PATH]')
    expect(payload.stack).not.toContain('C:/Users/example')
  })
})

describe('logger context', () => {
  it('keeps trace context across async work', async () => {
    await withLogContext({ traceId: 'trace_test', runId: 'run_test' }, async () => {
      await Promise.resolve()
      expect(currentLogContext()).toMatchObject({ traceId: 'trace_test', runId: 'run_test' })
    })
  })
})

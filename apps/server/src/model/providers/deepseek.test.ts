// +-------------------------------------------------------------------------
//
//   地理智能平台 - DeepSeek Provider 模型边界测试
//
//   文件:       deepseek.test.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { OpenAIResponsesModel } from '@openai/agents'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizedUsageFromProviderResponse } from '../modelUsage.js'
import {
  createDeepSeekAdapter,
  DEEPSEEK_RESPONSES_MODEL,
  type DeepSeekOptions,
} from './deepseek.js'

describe('DeepSeek configured model boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects a host CLI model before issuing a provider request', () => {
    const adapter = createAdapter()

    expect(() => adapter.createAgentModel?.('gpt-5.6-sol'))
      .toThrow("DeepSeek 模型 'gpt-5.6-sol' 不在本服务允许列表中")
  })

  it('uses the official OpenAI Responses model for the only supported DeepSeek model', () => {
    const adapter = createAdapter()
    const model = adapter.createAgentModel?.(DEEPSEEK_RESPONSES_MODEL)

    expect(adapter.availableModels).toEqual([DEEPSEEK_RESPONSES_MODEL])
    expect(model).toBeInstanceOf(OpenAIResponsesModel)
    expect(() => adapter.createAgentModel?.('deepseek-v4-pro')).toThrow('不在本服务允许列表中')
    expect(() => adapter.createAgentModel?.('deepseek-chat')).toThrow('不在本服务允许列表中')
    expect(adapter.agentRuntimeCapabilities).toMatchObject({
      transport: 'deepseek_responses',
      structuredOutput: 'json_schema',
      hostedTools: true,
      remoteConversation: false,
      serverCompaction: false,
    })
    expect(adapter.protocol).toBe('responses')
    expect(adapter.capabilities()).toContain('responses')
    expect(adapter.capabilities()).toContain('hosted_web_search')
  })

  it('does not report an invalid cross-provider default as configured', () => {
    const adapter = createDeepSeekAdapter({
      baseUrl: 'https://api.deepseek.example',
      apiKey: 'test-key',
      defaultModel: 'gpt-5.6-sol',
      toolSchemaMode: 'compatible',
      transport: testTransport(),
    })

    expect(adapter.isConfigured()).toBe(false)
  })

  it('sends simple chat requests to the Responses endpoint', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ url, body })
      return new Response(JSON.stringify({
        id: 'response_test',
        object: 'response',
        created_at: 0,
        status: 'completed',
        model: DEEPSEEK_RESPONSES_MODEL,
        output: [{
          id: 'message_test',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: 'OK',
            annotations: [],
            logprobs: [],
          }],
        }],
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 2,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))

    const result = await createAdapter().chat('请回复 OK。', { reasoning: false })

    expect(result.content).toBe('OK')
    expect(normalizedUsageFromProviderResponse(result)).toMatchObject({
      inputTokens: 1,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 1,
      cacheMeasuredInputTokens: 1,
      cacheDetailReported: 1,
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.deepseek.example/responses')
    expect(requests[0]?.body).toMatchObject({
      model: DEEPSEEK_RESPONSES_MODEL,
      input: [{ role: 'user', content: '请回复 OK。' }],
      stream: false,
      reasoning: { effort: 'none' },
    })
    expect(requests[0]?.body).not.toHaveProperty('messages')
  })

  it('does not retry an HTTP failure inside the OpenAI client', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'temporary upstream failure', type: 'server_error' },
    }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }))
    const adapter = createDeepSeekAdapter({
      baseUrl: 'https://api.deepseek.example',
      apiKey: 'test-key',
      defaultModel: DEEPSEEK_RESPONSES_MODEL,
      toolSchemaMode: 'compatible',
      transport: testTransport(request),
    })

    await expect(adapter.chat('请回复 OK。', { reasoning: false })).rejects.toThrow()

    expect(request).toHaveBeenCalledOnce()
  })
})

function createAdapter() {
  return createDeepSeekAdapter({
    baseUrl: 'https://api.deepseek.example',
    apiKey: 'test-key',
    defaultModel: DEEPSEEK_RESPONSES_MODEL,
    toolSchemaMode: 'compatible',
    transport: testTransport(),
  })
}

function testTransport(
  request: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
): NonNullable<DeepSeekOptions['transport']> {
  return {
    fetch: request,
    close: async () => undefined,
  }
}

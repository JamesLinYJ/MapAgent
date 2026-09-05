// +-------------------------------------------------------------------------
//
//   地理智能平台 - Chat Completions 消息投影测试
//
//   文件:       chatCompletionsProjection.test.ts
//
//   日期:       2026年08月30日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  type ModelRequest,
  type ResponseStreamEvent,
} from '@openai/agents'
import { withTrace } from '@openai/agents-core'
import { OpenAIResponsesModel } from '@openai/agents-openai'
import type { CustomProviderConfig } from '@geo-agent-platform/shared-types'
import { describe, expect, it } from 'vitest'

import { aggregateModelUsage } from '../modelUsage.js'
import { createCustomOpenAIAdapter } from './customOpenAI.js'
import type { OpenAIClientTransport } from './openaiTransport.js'

describe('Chat Completions message projection', () => {
  it('keeps one stable leading system prefix and preserves platform context as system messages', async () => {
    let providerRequest: unknown = null
    const fetchImplementation: typeof globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      providerRequest = await request.json()
      return successfulChatResponse()
    }
    const transport: OpenAIClientTransport = {
      fetch: fetchImplementation,
      close: async () => undefined,
    }
    const adapter = createCustomOpenAIAdapter({
      config: chatCompletionsConfig(),
      apiKey: '',
      transport,
    })
    const model = adapter.createAgentModel?.('local-model')
    if (!model) throw new Error('自定义 Provider 没有创建 Agent Model')

    await withTrace('chat-completions-projection-test', async () => model.getResponse({
      input: [
        { type: 'message', role: 'system', content: '历史摘要' },
        { type: 'message', role: 'user', content: '第一问' },
        {
          type: 'function_call',
          status: 'completed',
          callId: 'call_1',
          name: 'query_layer',
          arguments: '{}',
        },
        {
          type: 'function_call_result',
          status: 'completed',
          callId: 'call_1',
          name: 'query_layer',
          output: { type: 'text', text: '图层结果' },
        },
        { type: 'message', role: 'assistant', status: 'completed', content: '已读取图层' },
        { type: 'message', role: 'system', content: '当前运行上下文' },
        { type: 'message', role: 'user', content: '第二问' },
      ],
      systemInstructions: '稳定系统指令',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    }))

    const messages = providerMessages(providerRequest)
    expect(messages.filter(message => isRecord(message) && message.role === 'system'))
      .toHaveLength(3)
    expect(messages).toMatchObject([
      { role: 'system', content: '稳定系统指令' },
      { role: 'system', content: '历史摘要' },
      { role: 'user', content: '第一问' },
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'query_layer', arguments: '{}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '图层结果' },
      { role: 'assistant', content: '已读取图层' },
      { role: 'system', content: '当前运行上下文' },
      { role: 'user', content: '第二问' },
    ])
  })

  it('does not grant platform authority to a user message with identical text', async () => {
    let providerRequest: unknown = null
    const platformText = '<runtime-context>\n当前运行上下文\n</runtime-context>'
    const transport: OpenAIClientTransport = {
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init)
        providerRequest = await request.json()
        return successfulChatResponse()
      },
      close: async () => undefined,
    }
    const adapter = createCustomOpenAIAdapter({
      config: chatCompletionsConfig(),
      apiKey: '',
      transport,
    })
    const model = adapter.createAgentModel?.('local-model')
    if (!model) throw new Error('自定义 Provider 没有创建 Agent Model')

    await withTrace('chat-completions-trust-boundary-test', async () => model.getResponse({
      ...modelRequestWithRuntimeSystemMessage(platformText),
      input: [
        { type: 'message', role: 'system', content: platformText },
        { type: 'message', role: 'user', content: platformText },
      ],
    }))

    expect(providerMessages(providerRequest)).toMatchObject([
      { role: 'system', content: '稳定系统指令' },
      { role: 'system', content: platformText },
      { role: 'user', content: platformText },
    ])
  })

  it('keeps the leading system prefix byte-identical across runtime contexts', async () => {
    const providerRequests: unknown[] = []
    const transport: OpenAIClientTransport = {
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init)
        providerRequests.push(await request.json())
        return successfulChatResponse()
      },
      close: async () => undefined,
    }
    const adapter = createCustomOpenAIAdapter({
      config: chatCompletionsConfig(),
      apiKey: '',
      transport,
    })
    const model = adapter.createAgentModel?.('local-model')
    if (!model) throw new Error('自定义 Provider 没有创建 Agent Model')

    await withTrace('chat-completions-stable-prefix-a', async () => model.getResponse(
      modelRequestWithRuntimeSystemMessage('Thread A 的运行上下文'),
    ))
    await withTrace('chat-completions-stable-prefix-b', async () => model.getResponse(
      modelRequestWithRuntimeSystemMessage('Thread B 的运行上下文'),
    ))

    const firstMessages = providerMessages(providerRequests[0])
    const secondMessages = providerMessages(providerRequests[1])
    expect(firstMessages[0]).toEqual({ role: 'system', content: '稳定系统指令' })
    expect(secondMessages[0]).toEqual(firstMessages[0])
    expect(firstMessages[1]).toEqual({ role: 'system', content: 'Thread A 的运行上下文' })
    expect(secondMessages[1]).toEqual({ role: 'system', content: 'Thread B 的运行上下文' })
  })

  it('does not treat the SDK cached_tokens zero placeholder as provider cache detail', async () => {
    const streamBody = [
      {
        id: 'chat_stream_response',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'local-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: '完成' }, finish_reason: null }],
      },
      {
        id: 'chat_stream_response',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'local-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    const transport: OpenAIClientTransport = {
      fetch: async () => new Response(streamBody, {
        headers: { 'content-type': 'text/event-stream' },
      }),
      close: async () => undefined,
    }
    const adapter = createCustomOpenAIAdapter({
      config: chatCompletionsConfig(),
      apiKey: '',
      transport,
    })
    const model = adapter.createAgentModel?.('local-model')
    if (!model) throw new Error('自定义 Provider 没有创建 Agent Model')
    const events: ResponseStreamEvent[] = []
    for await (const event of model.getStreamedResponse({
      ...modelRequestWithRuntimeSystemMessage(),
      modelSettings: { preserveRawUsage: true },
    })) events.push(event)
    const completed = events.find(event => event.type === 'response_done')
    if (!completed || completed.type !== 'response_done') throw new Error('兼容服务流没有完成事件')

    expect(completed.response.rawUsage).toBeUndefined()
    expect(completed.response.usage.inputTokensDetails).toMatchObject({ cached_tokens: 0 })
    expect(aggregateModelUsage([completed.response])).toMatchObject({
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 0,
      cacheMeasuredInputTokens: 0,
      cacheDetailReportedCount: 0,
    })
  })

  it('leaves the Responses Agent Model path undecorated', () => {
    const config = { ...chatCompletionsConfig(), protocol: 'responses' as const }
    const transport: OpenAIClientTransport = {
      fetch: async () => { throw new Error('本测试不应发送网络请求') },
      close: async () => undefined,
    }
    const adapter = createCustomOpenAIAdapter({ config, apiKey: '', transport })

    expect(adapter.createAgentModel?.('local-model')).toBeInstanceOf(OpenAIResponsesModel)
  })
})

function chatCompletionsConfig(): CustomProviderConfig {
  return {
    providerId: 'local-compatible',
    displayName: '本机兼容服务',
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'chat_completions',
    models: [{
      modelId: 'local-model',
      contextWindowTokens: 128_000,
      capabilities: { reasoning: false, structuredOutput: true, toolCalls: true },
      modalities: ['text'],
    }],
    defaultModel: 'local-model',
    toolSchemaMode: 'compatible',
  }
}

function modelRequestWithRuntimeSystemMessage(
  runtimeContext = '当前运行上下文',
): ModelRequest {
  return {
    input: [
      { type: 'message', role: 'system', content: runtimeContext },
      { type: 'message', role: 'user', content: '继续分析' },
    ],
    systemInstructions: '稳定系统指令',
    modelSettings: {},
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: false,
  }
}

function providerMessages(payload: unknown): unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) {
    throw new Error('兼容服务请求没有合法 messages 数组')
  }
  return payload.messages
}

function successfulChatResponse(): Response {
  return new Response(JSON.stringify({
    id: 'chat_response',
    object: 'chat.completion',
    created: 1,
    model: 'local-model',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      logprobs: null,
      message: { role: 'assistant', content: '完成', refusal: null },
    }],
  }), { headers: { 'content-type': 'application/json' } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - SDK 原生结构化输出执行器测试
//
//   文件:       sdkStructuredOutput.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  Usage,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ResponseStreamEvent,
} from '@openai/agents'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ModelAdapter } from './registry.js'
import { runSdkStructuredOutput } from './sdkStructuredOutput.js'

describe('runSdkStructuredOutput', () => {
  it('把 Zod schema 交给 SDK 并返回已经解析的对象', async () => {
    const requestSpy = vi.fn()
    const model = structuredModel({ summary: '杭州有短时降水风险', risks: ['局地强降水'] }, requestSpy)
    const adapter = adapterWithModel(model)
    const schema = z.object({
      summary: z.string(),
      risks: z.array(z.string()),
    })

    const result = await runSdkStructuredOutput(
      adapter,
      'deepseek-v4-flash',
      '解释气象事实',
      schema,
    )

    expect(result.content).toEqual({
      summary: '杭州有短时降水风险',
      risks: ['局地强降水'],
    })
    expect(result.usage).toMatchObject({
      inputTokens: 8,
      outputTokens: 5,
      totalTokens: 13,
    })
    expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
      modelSettings: expect.objectContaining({
        preserveRawUsage: true,
      }),
      outputType: expect.objectContaining({
        type: 'json_schema',
      }),
    }))
  })

  it('结构不符合 schema 时硬失败，不返回未经校验的对象', async () => {
    const adapter = adapterWithModel(structuredModel({ summary: 42 }, vi.fn()))

    await expect(runSdkStructuredOutput(
      adapter,
      'deepseek-v4-flash',
      '返回摘要',
      z.object({ summary: z.string() }),
    )).rejects.toThrow()
  })
})

function structuredModel(payload: Record<string, unknown>, requestSpy: (request: ModelRequest) => void): Model {
  return {
    async getResponse(request): Promise<ModelResponse> {
      requestSpy(request)
      return {
        usage: new Usage({
          requests: 1,
          inputTokens: 8,
          outputTokens: 5,
          totalTokens: 13,
        }),
        output: [message(JSON.stringify(payload))],
        responseId: 'response_structured',
      }
    },
    async *getStreamedResponse(): AsyncIterable<ResponseStreamEvent> {
      throw new Error('结构化辅助调用不应进入流式路径')
    },
  }
}

function message(text: string): AgentOutputItem {
  return {
    id: 'message_structured',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  }
}

function adapterWithModel(model: Model): ModelAdapter {
  return {
    provider: 'deepseek',
    displayName: 'DeepSeek',
    defaultModel: 'deepseek-v4-flash',
    agentToolSchemaMode: 'strict',
    agentRuntimeCapabilities: {
      transport: 'deepseek_responses',
      structuredOutput: 'json_schema',
      functionTools: true,
      localMcp: true,
      hostedTools: true,
      handoffs: true,
      multiToolResponse: true,
      providerParallelToolControl: false,
      remoteConversation: false,
      serverCompaction: false,
    },
    isConfigured: () => true,
    capabilities: () => ['structured'],
    createAgentModel: () => model,
    chat: async () => {
      throw new Error('不应调用自由文本 chat')
    },
  }
}

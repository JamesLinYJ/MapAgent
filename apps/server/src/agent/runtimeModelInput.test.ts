// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runner 模型输入预算控制测试
//
//   文件:       runtimeModelInput.test.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { Usage, type AgentInputItem, type Model } from '@openai/agents'
import { withTrace, type ModelRequest } from '@openai/agents-core'
import {
  OpenAIChatCompletionsModel,
  OpenAIResponsesModel,
  type OpenAIClient,
} from '@openai/agents-openai'
import { describe, expect, it, vi } from 'vitest'
import { defaultRuntimeConfig } from './defaultRuntimeConfig.js'
import {
  assertModelRequestWithinContextBudget,
  estimateModelRequestTokens,
  protectModelTransportFromRunInputMarkers,
  RuntimeModelInputController,
} from './runtimeModelInput.js'

const TEST_SUMMARY_IDENTITY = { provider: 'test', model: 'summary-test' }

describe('RuntimeModelInputController', () => {
  it('compacts against the complete request after late runtime and world injection', async () => {
    const config = {
      ...defaultRuntimeConfig().context,
      contextWindowTokens: 2_500,
      compactRatio: 0.45,
      hardLimitRatio: 0.95,
      preserveRecentTurns: 1,
    }
    const updates: number[] = []
    const persisted = vi.fn(async () => undefined)
    const compacted = vi.fn(async () => undefined)
    const summarize = vi.fn(async () => '旧轮次已经完成数据检查。')
    const controller = new RuntimeModelInputController({
      config,
      summaryIdentity: TEST_SUMMARY_IDENTITY,
      summarize,
      resolveToolOutput: async () => null,
      persistSummary: persisted,
      onCompacted: compacted,
      updateEstimatedTokens: async tokens => { updates.push(tokens) },
    })
    const oldItems: AgentInputItem[] = [
      { type: 'message', role: 'user', content: `旧问题：${'旧'.repeat(460)}` },
      { type: 'message', role: 'assistant', status: 'completed', content: '旧轮次已经完成。' },
    ]
    const runtimeContext: AgentInputItem = {
      type: 'message',
      role: 'system',
      content: `<runtime-context>\n${'运行约束'.repeat(90)}\n</runtime-context>`,
    }
    const worldBaseline: AgentInputItem = {
      type: 'message',
      role: 'system',
      content: `<geo-world-baseline revision="1" state-digest="sha256:test">\n当前世界\n${JSON.stringify({ layers: '图层'.repeat(90) })}\n</geo-world-baseline>`,
    }
    const currentItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: '继续分析当前区域。',
    }
    const request = {
      ...modelRequest([...oldItems, runtimeContext, worldBaseline, currentItem]),
      systemInstructions: '稳定系统约束。'.repeat(20),
      tools: [{
        type: 'function' as const,
        name: 'inspect_dataset',
        description: '工具能力说明'.repeat(70),
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '查询参数'.repeat(35) } },
          additionalProperties: false,
        },
        strict: true,
      }],
    }
    const requestWithoutLateEnvelope = {
      ...modelRequest([...oldItems, currentItem]),
      systemInstructions: request.systemInstructions,
    }
    const compactThreshold = Math.floor(config.contextWindowTokens * config.compactRatio)
    const initialExactEstimate = estimateModelRequestTokens(request)

    expect(estimateModelRequestTokens(requestWithoutLateEnvelope)).toBeLessThan(compactThreshold)
    expect(initialExactEstimate).toBeGreaterThanOrEqual(compactThreshold)

    const finalized = await controller.finalizeRequest(request)
    const finalExactEstimate = estimateModelRequestTokens(finalized)

    expect(summarize).toHaveBeenCalledOnce()
    expect(JSON.stringify(finalized.input)).not.toContain('旧问题')
    expect(JSON.stringify(finalized.input)).toContain('<run-history-summary')
    expect(JSON.stringify(finalized.input)).toContain('<runtime-context>')
    expect(JSON.stringify(finalized.input)).toContain('<geo-world-baseline ')
    expect(JSON.stringify(finalized.input)).toContain('继续分析当前区域')
    expect(finalExactEstimate).toBeLessThan(initialExactEstimate)
    expect(finalExactEstimate).toBeLessThan(
      Math.floor(config.contextWindowTokens * config.hardLimitRatio),
    )
    expect(updates.at(-1)).toBe(finalExactEstimate)
    expect(persisted).toHaveBeenCalledWith(expect.objectContaining({
      estimatedTokensBefore: initialExactEstimate,
      estimatedTokensAfter: finalExactEstimate,
    }))
    expect(compacted).toHaveBeenCalledWith(expect.objectContaining({
      sourceDigest: persisted.mock.calls[0]?.[0].sourceDigest,
      promptVersion: persisted.mock.calls[0]?.[0].promptVersion,
    }))
  })

  it('reserves the measured late request envelope for the next filter decision', async () => {
    const config = {
      ...defaultRuntimeConfig().context,
      contextWindowTokens: 2_500,
      compactRatio: 0.45,
      hardLimitRatio: 0.95,
      preserveRecentTurns: 1,
    }
    const summarize = vi.fn(async () => '已压缩旧轮次。')
    const controller = new RuntimeModelInputController({
      config,
      summaryIdentity: TEST_SUMMARY_IDENTITY,
      summarize,
      resolveToolOutput: async () => null,
      persistSummary: async () => undefined,
      onCompacted: async () => undefined,
      updateEstimatedTokens: async () => undefined,
    })
    const baseInput: AgentInputItem[] = [
      { type: 'message', role: 'user', content: `待压缩旧问题：${'旧'.repeat(460)}` },
      { type: 'message', role: 'assistant', status: 'completed', content: '旧回答完成。' },
      { type: 'message', role: 'user', content: '新的当前问题。' },
    ]
    const runtimeContext: AgentInputItem = {
      type: 'message',
      role: 'system',
      content: `<runtime-context>\n${'动态上下文'.repeat(100)}\n</runtime-context>`,
    }
    const worldBaseline: AgentInputItem = {
      type: 'message',
      role: 'system',
      content: `<geo-world-baseline revision="1" state-digest="sha256:test">\n世界\n${'地理状态'.repeat(80)}\n</geo-world-baseline>`,
    }
    const envelopeRequest = {
      ...modelRequest([...baseInput.slice(0, 2), runtimeContext, worldBaseline, baseInput[2]!]),
      tools: [{
        type: 'function' as const,
        name: 'large_tool',
        description: '工具目录'.repeat(90),
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        strict: true,
      }],
    }
    const compactThreshold = Math.floor(config.contextWindowTokens * config.compactRatio)

    expect(estimateModelRequestTokens(modelRequest(baseInput))).toBeLessThan(compactThreshold)
    expect(estimateModelRequestTokens(envelopeRequest)).toBeGreaterThanOrEqual(compactThreshold)
    await controller.observeFinalRequest(envelopeRequest)
    summarize.mockClear()

    const filtered = await controller.filter({ input: baseInput }, [])

    expect(summarize).toHaveBeenCalledOnce()
    expect(JSON.stringify(filtered.input)).not.toContain('待压缩旧问题')
    expect(JSON.stringify(filtered.input)).toContain('<run-history-summary')
    expect(JSON.stringify(filtered.input)).toContain('新的当前问题')
  })

  it('observes a durable final request without mutating its exact replay payload', async () => {
    const updates: number[] = []
    const controller = new RuntimeModelInputController({
      config: defaultRuntimeConfig().context,
      summaryIdentity: TEST_SUMMARY_IDENTITY,
      summarize: async () => '不应调用',
      resolveToolOutput: async () => null,
      persistSummary: async () => undefined,
      onCompacted: async () => undefined,
      updateEstimatedTokens: async tokens => { updates.push(tokens) },
    })
    const request = {
      ...modelRequest([{ type: 'message', role: 'user', content: '继续执行' }]),
      systemInstructions: '稳定系统约束',
      tools: [{
        type: 'function' as const,
        name: 'read_layer',
        description: '读取图层',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        strict: true,
      }],
    }
    const before = structuredClone(request)

    const observed = await controller.observeFinalRequest(request)

    expect(request).toEqual(before)
    expect(observed).toBe(estimateModelRequestTokens(request))
    expect(updates).toEqual([observed])
  })

  it('fails on the final model-visible request when tool schemas exceed the hard limit', () => {
    const request = {
      ...modelRequest([{ type: 'message', role: 'user', content: '执行分析' }]),
      tools: [{
        type: 'function' as const,
        name: 'large_schema_tool',
        description: '工具说明'.repeat(200),
        parameters: {
          type: 'object',
          properties: { input: { type: 'string', description: '参数说明'.repeat(200) } },
          additionalProperties: false,
        },
        strict: true,
      }],
    }
    let caught: unknown = null

    try {
      assertModelRequestWithinContextBudget(request, {
        contextWindowTokens: 100,
        hardLimitRatio: 0.5,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      code: 'model_request_context_budget_exceeded',
      hardLimitTokens: 50,
    })
  })

  it('compacts only complete old groups and keeps current input plus unresolved calls intact', async () => {
    const config = {
      ...defaultRuntimeConfig().context,
      contextWindowTokens: 2_000,
      compactRatio: 0.2,
      hardLimitRatio: 0.9,
      preserveRecentTurns: 1,
      inlineToolResultMaxChars: 100,
    }
    const persisted = vi.fn(async () => undefined)
    const estimatedUpdates: number[] = []
    const controller = new RuntimeModelInputController({
      config,
      summaryIdentity: TEST_SUMMARY_IDENTITY,
      summarize: async prompt => {
        expect(prompt).toContain('result_old')
        expect(prompt).toContain('ref_dataset')
        expect(prompt).not.toContain('x'.repeat(200))
        expect(prompt).not.toContain('geoAgentRunInput')
        expect(prompt).not.toContain('geo_agent_run_input')
        return '旧轮次已完成数据检查，结果引用为 ref_dataset。'
      },
      resolveToolOutput: async callId => callId === 'call_old'
        ? {
            callId,
            toolName: 'inspect_dataset',
            resultId: 'result_old',
            summary: '数据检查完成',
            valueRefIds: ['ref_dataset'],
            artifactIds: [],
          }
        : null,
      persistSummary: persisted,
      onCompacted: async () => undefined,
      updateEstimatedTokens: async tokens => { estimatedUpdates.push(tokens) },
    })
    const oldPair: AgentInputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: `旧问题：${'旧'.repeat(1_000)}`,
        providerData: {
          geoAgentRunInput: { runId: 'run_compaction', inputSequence: 1 },
        },
      },
      { type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: '先检查旧数据' }] },
      {
        type: 'function_call',
        status: 'completed',
        callId: 'call_old',
        name: 'inspect_dataset',
        arguments: '{}',
      },
      {
        type: 'function_call_result',
        status: 'completed',
        callId: 'call_old',
        name: 'inspect_dataset',
        output: { type: 'text', text: 'x'.repeat(1_000) },
      },
      { type: 'message', role: 'assistant', status: 'completed', content: '旧轮次完成。' },
    ]
    const unresolved: AgentInputItem = {
      type: 'function_call',
      status: 'completed',
      callId: 'call_current',
      name: 'query_layer',
      arguments: '{}',
    }
    const result = await controller.filter({
      input: [
        { type: 'message', role: 'system', content: '系统约束' },
        ...oldPair,
        unresolved,
      ],
    }, [
      { type: 'message', role: 'user', content: '当前问题' },
    ])

    expect(result.input).toContainEqual(expect.objectContaining({
      type: 'message',
      role: 'system',
      content: expect.stringContaining('<run-history-summary'),
    }))
    expect(result.input).toContainEqual(unresolved)
    expect(result.input).toContainEqual({ type: 'message', role: 'user', content: '当前问题' })
    expect(result.input.some(item => item.type === 'function_call_result' && item.callId === 'call_old')).toBe(false)
    expect(result.input.some(item => item.type === 'function_call' && item.callId === 'call_old')).toBe(false)
    expect(persisted).toHaveBeenCalledOnce()
    expect(estimatedUpdates).toEqual([
      expect.any(Number),
    ])
    expect(estimatedUpdates[0]).toBe(persisted.mock.calls[0]?.[0].estimatedTokensAfter)
  })

  it('rechecks window rollover when a persisted summary is reused after restart', async () => {
    const config = {
      ...defaultRuntimeConfig().context,
      contextWindowTokens: 800,
      compactRatio: 0.3,
      hardLimitRatio: 0.95,
      preserveRecentTurns: 1,
    }
    const input: AgentInputItem[] = [
      { type: 'message', role: 'user', content: `旧问题：${'旧'.repeat(900)}` },
      { type: 'message', role: 'assistant', status: 'completed', content: '旧回答。' },
      { type: 'message', role: 'user', content: '继续当前问题。' },
    ]
    const firstPersist = vi.fn(async () => undefined)
    const first = new RuntimeModelInputController({
      config,
      summaryIdentity: TEST_SUMMARY_IDENTITY,
      summarize: async () => '已持久化摘要。',
      resolveToolOutput: async () => null,
      persistSummary: firstPersist,
      onCompacted: async () => undefined,
      updateEstimatedTokens: async () => undefined,
    })
    await first.filter({ input }, [])
    const record = firstPersist.mock.calls[0]?.[0]
    if (!record) throw new Error('测试没有生成持久摘要')

    const replayPersist = vi.fn(async () => undefined)
    const replayRollover = vi.fn(async () => undefined)
    const summarize = vi.fn(async () => '不应重新生成摘要')
    const restored = new RuntimeModelInputController({
      config,
      summaryIdentity: TEST_SUMMARY_IDENTITY,
      summarize,
      resolveToolOutput: async () => null,
      existingSummaries: new Map([[record.sourceDigest, record.summary]]),
      persistSummary: replayPersist,
      onCompacted: replayRollover,
      updateEstimatedTokens: async () => undefined,
    })

    await restored.filter({ input }, [])

    expect(summarize).not.toHaveBeenCalled()
    expect(replayPersist).not.toHaveBeenCalled()
    expect(replayRollover).toHaveBeenCalledWith(expect.objectContaining({
      sourceDigest: record.sourceDigest,
      summary: record.summary,
    }))
  })

  it('fails explicitly when the current input alone exceeds the hard limit', async () => {
    const config = {
      ...defaultRuntimeConfig().context,
      contextWindowTokens: 100,
      compactRatio: 0.5,
      hardLimitRatio: 0.6,
      preserveRecentTurns: 6,
    }
    const controller = new RuntimeModelInputController({
      config,
      summaryIdentity: TEST_SUMMARY_IDENTITY,
      summarize: async () => '不应调用',
      resolveToolOutput: async () => null,
      persistSummary: async () => undefined,
      onCompacted: async () => undefined,
      updateEstimatedTokens: async () => undefined,
    })

    await expect(controller.filter({
      input: [{ type: 'message', role: 'system', content: '系统约束' }],
    }, [
      { type: 'message', role: 'user', content: '当前'.repeat(1_000) },
    ])).rejects.toThrow('没有可安全压缩的完整旧消息组')
  })

  it('does not persist identical context telemetry on every model callback', async () => {
    const updates: number[] = []
    const controller = new RuntimeModelInputController({
      config: defaultRuntimeConfig().context,
      summaryIdentity: TEST_SUMMARY_IDENTITY,
      summarize: async () => '不应调用',
      resolveToolOutput: async () => null,
      persistSummary: async () => undefined,
      onCompacted: async () => undefined,
      updateEstimatedTokens: async tokens => { updates.push(tokens) },
    })
    const modelData = {
      input: [{ type: 'message', role: 'user', content: '查询杭州天气' }] satisfies AgentInputItem[],
    }

    await controller.filter(modelData, [])
    await controller.filter(modelData, [])

    expect(updates).toHaveLength(1)
  })

  it('keeps checkpoint delivery markers in SDK-persisted filter output', async () => {
    const controller = new RuntimeModelInputController({
      config: defaultRuntimeConfig().context,
      summaryIdentity: TEST_SUMMARY_IDENTITY,
      summarize: async () => '不应调用',
      resolveToolOutput: async () => null,
      persistSummary: async () => undefined,
      onCompacted: async () => undefined,
      updateEstimatedTokens: async () => undefined,
    })
    const persistedItem = {
      type: 'message',
      role: 'user',
      content: '把范围改成浙江省',
      providerData: {
        geoAgentRunInput: {
          runId: 'run_1',
          inputSequence: 2,
        },
        providerOption: 'preserved',
      },
    } satisfies AgentInputItem

    const result = await controller.filter({ input: [persistedItem] }, [persistedItem])

    expect(result.input).toHaveLength(2)
    for (const item of result.input) {
      expect(item).toMatchObject({
        providerData: {
          providerOption: 'preserved',
          geoAgentRunInput: { runId: 'run_1', inputSequence: 2 },
        },
      })
    }
    expect(persistedItem.providerData.geoAgentRunInput).toEqual({
      runId: 'run_1',
      inputSequence: 2,
    })
  })

  it('keeps delivery markers out of both OpenAI Responses and Chat request builders', async () => {
    const controller = new RuntimeModelInputController({
      config: defaultRuntimeConfig().context,
      summaryIdentity: TEST_SUMMARY_IDENTITY,
      summarize: async () => '不应调用',
      resolveToolOutput: async () => null,
      persistSummary: async () => undefined,
      onCompacted: async () => undefined,
      updateEstimatedTokens: async () => undefined,
    })
    const checkpointItem = {
      type: 'message',
      role: 'user',
      content: '继续分析浙江省',
      providerData: {
        geoAgentRunInput: {
          runId: 'run_wire',
          inputSequence: 1,
        },
      },
    } satisfies AgentInputItem
    const filtered = await controller.filter({ input: [checkpointItem] }, [])
    const request = modelRequest(filtered.input)
    let protectedRequest: ModelRequest | null = null
    const captureModel: Model = {
      getResponse: async value => {
        protectedRequest = value
        return { usage: new Usage(), output: [] }
      },
      async *getStreamedResponse(value) {
        protectedRequest = value
      },
    }
    await protectModelTransportFromRunInputMarkers(captureModel).getResponse(request)
    if (!protectedRequest) throw new Error('模型边界没有收到请求')

    class InspectableResponsesModel extends OpenAIResponsesModel {
      build(value: ModelRequest): Record<string, unknown> {
        return this._buildResponsesCreateRequest(value, false).requestData
      }
    }
    const responsesRequest = new InspectableResponsesModel(
      {} as unknown as OpenAIClient,
      'gpt-test',
    ).build(protectedRequest)

    const chatCreate = vi.fn(async () => ({
      id: 'chat_response',
      object: 'chat.completion' as const,
      created: 1,
      model: 'gpt-test',
      choices: [{
        index: 0,
        finish_reason: 'stop' as const,
        logprobs: null,
        message: { role: 'assistant' as const, content: 'ok', refusal: null },
      }],
    }))
    const chatModel = new OpenAIChatCompletionsModel({
      chat: { completions: { create: chatCreate } },
    } as unknown as OpenAIClient, 'gpt-test')
    await withTrace('runtime-model-input-wire-test', async () => chatModel.getResponse(protectedRequest))

    expect(JSON.stringify(responsesRequest)).not.toContain('geo_agent_run_input')
    expect(JSON.stringify(responsesRequest)).not.toContain('geoAgentRunInput')
    expect(JSON.stringify(chatCreate.mock.calls[0]?.[0])).not.toContain('geoAgentRunInput')
    expect(JSON.stringify(chatCreate.mock.calls[0]?.[0])).not.toContain('geo_agent_run_input')
    expect(checkpointItem.providerData).toHaveProperty('geoAgentRunInput')
  })

  it('awaits the StepContext observer on the sanitized exact request before provider I/O', async () => {
    let releaseObserver: (() => void) | null = null
    const observerGate = new Promise<void>(resolve => { releaseObserver = resolve })
    let providerCalled = false
    const provider: Model = {
      getResponse: async () => {
        providerCalled = true
        return { usage: new Usage(), output: [] }
      },
      async *getStreamedResponse() {},
    }
    const observed: ModelRequest[] = []
    const protectedModel = protectModelTransportFromRunInputMarkers(provider, async request => {
      observed.push(request)
      await observerGate
    })
    const request = {
      ...modelRequest([{
        type: 'message',
        role: 'user',
        content: '继续分析',
        providerData: {
          geoAgentRunInput: { runId: 'run_observer', inputSequence: 1 },
        },
      }]),
      tools: [{
        type: 'function',
        name: 'query_layer',
        description: '查询图层',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        strict: true,
      }],
    } satisfies ModelRequest

    const pending = protectedModel.getResponse(request)
    await vi.waitFor(() => expect(observed).toHaveLength(1))
    expect(providerCalled).toBe(false)
    expect(observed[0]?.tools.map(tool => tool.name)).toEqual(['query_layer'])
    expect(JSON.stringify(observed[0]?.input)).not.toContain('geoAgentRunInput')
    expect(JSON.stringify(request.input)).toContain('geoAgentRunInput')

    releaseObserver?.()
    await pending
    expect(providerCalled).toBe(true)
  })
})

function modelRequest(input: AgentInputItem[]): ModelRequest {
  return {
    input,
    modelSettings: {},
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: false,
  }
}

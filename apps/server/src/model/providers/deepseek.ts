// +-------------------------------------------------------------------------
//
//   地理智能平台 - DeepSeek OpenAI-compatible 适配器
//
//   文件:       deepseek.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-07-31):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 默认模型边界改为 OpenAI 兼容的 DeepSeek Responses API，仅开放当前受支持的 V4 Flash。
// --------------------------------------------------------------------------

import { OpenAIResponsesModel } from '@openai/agents'
import OpenAI from 'openai'
import type { EasyInputMessage } from 'openai/resources/responses/responses'
import type { ModelCapabilitySnapshot } from '@geo-agent-platform/shared-types'
import type { AgentToolSchemaMode,ModelAdapter } from '../registry.js'
import { normalizedUsageFromProviderResponse } from '../modelUsage.js'
import { abortSignalWithTimeout } from '../../utils/abort.js'
import {
recordModelRequestCompletion,
recordModelRequestFailure,
} from '../../observability/modelRequestTelemetry.js'
import {
OpenAIProviderTransport,
type OpenAIClientTransport,
} from './openaiTransport.js'

export const DEEPSEEK_RESPONSES_MODEL = 'deepseek-v4-flash'

export interface DeepSeekOptions {
  baseUrl: string
  apiKey: string
  defaultModel: string
  displayName?: string
  toolSchemaMode: AgentToolSchemaMode
  transport?: OpenAIClientTransport
}
export function createDeepSeekAdapter(opts: DeepSeekOptions): ModelAdapter {
  const baseUrl = opts.baseUrl.replace(/\/$/, '')
  const transport = opts.apiKey && baseUrl
    ? opts.transport ?? new OpenAIProviderTransport(baseUrl)
    : null
  const client = transport ? new OpenAI({
    baseURL: baseUrl,
    apiKey: opts.apiKey,
    fetch: transport.fetch,
    maxRetries: 0,
  }) : null
  const availableModels = [DEEPSEEK_RESPONSES_MODEL]
  const modelCapabilitySnapshots = [{
    modelId: DEEPSEEK_RESPONSES_MODEL,
    contextWindowTokens: inferContextWindow(DEEPSEEK_RESPONSES_MODEL),
    capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
    modalities: ['text'],
  }] satisfies ModelCapabilitySnapshot[]
  const defaultModelCapabilities = modelCapabilitySnapshots[0]
  if (!defaultModelCapabilities) throw new Error('DeepSeek 模型能力目录为空')

  return {
    provider: 'deepseek',
    displayName: opts.displayName ?? 'DeepSeek',
    defaultModel: opts.defaultModel,
    availableModels,
    modelCapabilitySnapshots,
    contextWindowTokens: defaultModelCapabilities.contextWindowTokens,
    modalities: defaultModelCapabilities.modalities,
    protocol: 'responses',
    agentToolSchemaMode: opts.toolSchemaMode,
    agentRuntimeCapabilities: {
      transport: 'deepseek_responses',
      structuredOutput: 'json_schema',
      functionTools: true,
      deferredTools: false,
      toolNamespaces: false,
      localMcp: true,
      hostedTools: true,
      handoffs: true,
      multiToolResponse: true,
      providerParallelToolControl: false,
      remoteConversation: false,
      serverCompaction: false,
    },
    cacheNamespace: baseUrl,

    isConfigured(): boolean {
      return Boolean(
        baseUrl
        && opts.apiKey
        && opts.defaultModel.trim() === DEEPSEEK_RESPONSES_MODEL,
      )
    },

    createAgentModel(modelName?: string | null) {
      if (!client) throw new Error('DeepSeek provider 未配置 API key')
      const model = requireConfiguredModel(modelName ?? opts.defaultModel, availableModels)
      return new OpenAIResponsesModel(client, model)
    },

    capabilities: () => [
      'chat',
      'structured',
      'stream',
      'reasoning',
      'responses',
      'tool_calls',
      'hosted_web_search',
    ],

    async warmup(): Promise<void> {
      await transport?.warmup?.()
    },

    async close(): Promise<void> {
      await transport?.close()
    },

    async chat(prompt: string, kwargs?: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (!client) throw new Error('DeepSeek provider 未配置 API key')
      const requestedModel = typeof kwargs?.model === 'string' ? kwargs.model : opts.defaultModel
      const model = requireConfiguredModel(requestedModel, availableModels)
      const messages = (kwargs?.messages as Array<{ role: string; content: string }>) ?? [{ role: 'user', content: prompt }]

      const startedAt = performance.now()
      let response
      try {
        response = await client.responses.create({
          model,
          input: messages.map(m => toResponseMessage(m.role, m.content)),
          stream: false,
          reasoning: { effort: kwargs?.reasoning === false ? 'none' : 'high' },
          ...(kwargs?.reasoning === false && typeof kwargs?.temperature === 'number'
            ? { temperature: kwargs.temperature }
            : {}),
        }, {
          signal: abortSignalWithTimeout(kwargs?.signal, 60_000),
        })
      } catch (error) {
        recordModelRequestFailure({
          context: { provider: 'deepseek', model, transport: 'deepseek_responses' },
          responseId: null,
          durationMs: elapsedMilliseconds(startedAt),
          timeToResponseStartedMs: null,
          error,
        })
        throw error
      }

      const usage = normalizedUsageFromProviderResponse({
        raw: response as unknown as Record<string, unknown>,
      })
      recordModelRequestCompletion({
        context: { provider: 'deepseek', model, transport: 'deepseek_responses' },
        responseId: response.id,
        requestId: response._request_id ?? null,
        durationMs: elapsedMilliseconds(startedAt),
        timeToResponseStartedMs: null,
        timeToFirstTextDeltaMs: null,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          cacheHitInputTokens: usage.cacheHitInputTokens,
          cacheMissInputTokens: usage.cacheMissInputTokens,
        },
      })

      return {
        provider: 'deepseek',
        content: response.output_text,
        raw: response as unknown as Record<string, unknown>,
        model,
      }
    },

  }
}

function requireConfiguredModel(model: string | null | undefined, availableModels: readonly string[]): string {
  const selected = model?.trim()
  if (!selected) throw new Error('DeepSeek provider 未配置模型名称')
  if (!availableModels.includes(selected)) {
    const allowed = availableModels.length ? availableModels.join('、') : '未配置'
    throw new Error(`DeepSeek 模型 '${selected}' 不在本服务允许列表中；可用模型：${allowed}。`)
  }
  return selected
}

function inferContextWindow(model: string): number {
  const normalized = model.toLowerCase()
  if (normalized.includes('deepseek-v4')) return 1_000_000
  return 128_000
}

function toResponseMessage(role: string, content: string): EasyInputMessage {
  if (role === 'assistant') return { role: 'assistant', content }
  if (role === 'system') return { role: 'system', content }
  if (role === 'developer') return { role: 'developer', content }
  return { role: 'user', content }
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}

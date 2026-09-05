// +-------------------------------------------------------------------------
//
//   地理智能平台 - 动态 OpenAI-compatible Provider 适配器
//
//   文件:       customOpenAI.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-08-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: Chat Completions 保留 SDK 原生消息角色，固定首部规则与动态系统上下文分层传递。
// --------------------------------------------------------------------------

import {
OpenAIChatCompletionsModel,
OpenAIResponsesModel,
} from '@openai/agents'
import type {
CustomProviderConfig,
ModelCapabilitySnapshot,
} from '@geo-agent-platform/shared-types'
import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions/completions'
import type { EasyInputMessage } from 'openai/resources/responses/responses'

import type { ModelAdapter } from '../registry.js'
import { normalizedUsageFromProviderResponse } from '../modelUsage.js'
import { abortSignalWithTimeout } from '../../utils/abort.js'
import {
recordModelRequestCompletion,
recordModelRequestFailure,
} from '../../observability/modelRequestTelemetry.js'
import {
assertCustomProviderBaseUrl,
createProviderDnsResolver,
} from '../providerEndpointPolicy.js'
import {
BoundedDnsLookupCache,
OpenAIProviderTransport,
type OpenAIClientTransport,
} from './openaiTransport.js'

export interface CustomOpenAIAdapterOptions {
  config: CustomProviderConfig
  apiKey: string
  transport?: OpenAIClientTransport
}

interface ProviderChatResult {
  content: string
  raw: Record<string, unknown>
}

export function createCustomOpenAIAdapter(options: CustomOpenAIAdapterOptions): ModelAdapter {
  const config = options.config
  const modelCapabilitySnapshots = config.models.map(model => ({
    ...model,
    capabilities: { ...model.capabilities },
    modalities: [...model.modalities],
  }))
  const modelsById = new Map(modelCapabilitySnapshots.map(model => [model.modelId, model]))
  const defaultModelCapabilities = requireConfiguredModel(config.defaultModel, modelsById)
  const endpoint = assertCustomProviderBaseUrl(config.baseUrl)
  const baseUrl = endpoint.toString().replace(/\/$/u, '')
  const transport = options.transport ?? new OpenAIProviderTransport(baseUrl, {
    dnsStrategy: 'guarded',
    dnsCache: new BoundedDnsLookupCache({
      resolver: createProviderDnsResolver(),
    }),
  })
  const client = new OpenAI({
    baseURL: baseUrl,
    apiKey: options.apiKey || 'local-provider-without-api-key',
    fetch: transport.fetch,
    maxRetries: 0,
  })

  return {
    provider: config.providerId,
    displayName: config.displayName,
    source: 'custom',
    defaultModel: config.defaultModel,
    availableModels: modelCapabilitySnapshots.map(model => model.modelId),
    modelCapabilitySnapshots,
    contextWindowTokens: defaultModelCapabilities.contextWindowTokens,
    modalities: defaultModelCapabilities.modalities,
    protocol: config.protocol,
    agentToolSchemaMode: config.toolSchemaMode,
    agentRuntimeCapabilities: {
      transport: config.protocol === 'responses' ? 'openai_responses' : 'openai_chat_completions',
      structuredOutput: 'json_schema',
      functionTools: true,
      deferredTools: false,
      toolNamespaces: false,
      localMcp: true,
      hostedTools: false,
      handoffs: true,
      multiToolResponse: true,
      providerParallelToolControl: false,
      remoteConversation: false,
      serverCompaction: false,
    },
    cacheNamespace: `${config.providerId}:${baseUrl}`,

    isConfigured: () => Boolean(baseUrl && modelsById.has(config.defaultModel)),

    resolveModelCapabilities(modelName: string) {
      return requireConfiguredModel(modelName, modelsById)
    },

    createAgentModel(modelName?: string | null) {
      const model = requireConfiguredModel(modelName ?? config.defaultModel, modelsById).modelId
      return config.protocol === 'responses'
        ? new OpenAIResponsesModel(client, model)
        : new OpenAIChatCompletionsModel(client, model)
    },

    capabilities: () => [
      'chat',
      'stream',
      config.protocol,
      ...(defaultModelCapabilities.capabilities.reasoning ? ['reasoning'] : []),
      ...(defaultModelCapabilities.capabilities.structuredOutput ? ['structured'] : []),
      ...(defaultModelCapabilities.capabilities.toolCalls ? ['tool_calls'] : []),
      ...defaultModelCapabilities.modalities.map(modality => `modality_${modality}`),
    ],

    warmup: () => transport.warmup?.() ?? Promise.resolve(),
    close: () => transport.close(),

    async chat(prompt: string, kwargs?: Record<string, unknown>): Promise<Record<string, unknown>> {
      const model = requireConfiguredModel(
        typeof kwargs?.model === 'string' ? kwargs.model : config.defaultModel,
        modelsById,
      ).modelId
      const startedAt = performance.now()
      try {
        const result = config.protocol === 'responses'
          ? await callResponses(client, model, prompt, kwargs)
          : await callChatCompletions(client, model, prompt, kwargs)
        const usage = normalizedUsageFromProviderResponse({ raw: result.raw })
        recordModelRequestCompletion({
          context: { provider: config.providerId, model, transport: config.protocol },
          responseId: null,
          requestId: null,
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
        return { provider: config.providerId, model, content: result.content, raw: result.raw }
      } catch (error) {
        recordModelRequestFailure({
          context: { provider: config.providerId, model, transport: config.protocol },
          responseId: null,
          durationMs: elapsedMilliseconds(startedAt),
          timeToResponseStartedMs: null,
          error,
        })
        throw error
      }
    },
  }
}

async function callResponses(
  client: OpenAI,
  model: string,
  prompt: string,
  kwargs?: Record<string, unknown>,
): Promise<ProviderChatResult> {
  const messages = readMessages(kwargs, prompt).map(message => toResponseMessage(message.role, message.content))
  const response = await client.responses.create({
    model,
    input: messages,
    stream: false,
    max_output_tokens: boundedOutputTokens(kwargs),
  }, { signal: abortSignalWithTimeout(kwargs?.signal, 30_000) })
  return {
    content: response.output_text,
    raw: response as unknown as Record<string, unknown>,
  }
}

async function callChatCompletions(
  client: OpenAI,
  model: string,
  prompt: string,
  kwargs?: Record<string, unknown>,
): Promise<ProviderChatResult> {
  const messages: ChatCompletionMessageParam[] = readMessages(kwargs, prompt).map(message => ({
    role: normalizeChatRole(message.role),
    content: message.content,
  }))
  const response = await client.chat.completions.create({
    model,
    messages,
    stream: false,
    max_tokens: boundedOutputTokens(kwargs),
  }, { signal: abortSignalWithTimeout(kwargs?.signal, 30_000) })
  const content = response.choices[0]?.message.content
  return {
    content: typeof content === 'string' ? content : '',
    raw: response as unknown as Record<string, unknown>,
  }
}

function readMessages(
  kwargs: Record<string, unknown> | undefined,
  fallback: string,
): Array<{ role: string; content: string }> {
  const value = kwargs?.messages
  if (!Array.isArray(value)) return [{ role: 'user', content: fallback }]
  const messages = value.flatMap(item => {
    if (typeof item !== 'object' || item === null) return []
    const role = 'role' in item && typeof item.role === 'string' ? item.role : 'user'
    const content = 'content' in item && typeof item.content === 'string' ? item.content : null
    return content === null ? [] : [{ role, content }]
  })
  return messages.length ? messages : [{ role: 'user', content: fallback }]
}

function toResponseMessage(role: string, content: string): EasyInputMessage {
  if (role === 'assistant') return { role: 'assistant', content }
  if (role === 'system') return { role: 'system', content }
  if (role === 'developer') return { role: 'developer', content }
  return { role: 'user', content }
}

function normalizeChatRole(role: string): 'system' | 'developer' | 'user' | 'assistant' {
  if (role === 'system' || role === 'developer' || role === 'assistant') return role
  return 'user'
}

function boundedOutputTokens(kwargs?: Record<string, unknown>): number {
  const requested = typeof kwargs?.maxOutputTokens === 'number' ? Math.floor(kwargs.maxOutputTokens) : 32
  return Math.min(256, Math.max(1, requested))
}

function requireConfiguredModel(
  model: string,
  modelsById: ReadonlyMap<string, ModelCapabilitySnapshot>,
): ModelCapabilitySnapshot {
  const selected = model.trim()
  if (!selected) throw new Error('自定义 Provider 未配置模型名称。')
  const capabilities = modelsById.get(selected)
  if (!capabilities) {
    throw new Error(`模型 '${selected}' 不在自定义 Provider 的允许清单中。`)
  }
  return capabilities
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}

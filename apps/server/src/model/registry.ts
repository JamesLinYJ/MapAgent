// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型适配器注册表
//
//   文件:       registry.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type {
  AgentRuntimeCapabilities,
  ModelCapabilitySnapshot,
  ModelProviderDescriptor,
} from '../schemas/types.js'
import type { Env } from '../framework/env.js'
import type { Model } from '@openai/agents'
import { createDeepSeekAdapter } from './providers/deepseek.js'
import { createAnthropicAdapter } from './providers/anthropic.js'
import { createGeminiAdapter } from './providers/gemini.js'
import { createOllamaAdapter } from './providers/ollama.js'

export type AgentToolSchemaMode = 'strict' | 'compatible'

/** 模型适配器的静态扩展点；运行时注册表必须为每个 ID 提供实现。 */
export const MODEL_PROVIDER_IDS = ['deepseek', 'anthropic', 'gemini', 'ollama'] as const
export type ModelProviderId = typeof MODEL_PROVIDER_IDS[number]
export const CONFIGURABLE_BUILTIN_PROVIDER_IDS = ['deepseek', 'ollama'] as const
type ConfigurableBuiltinProviderId = typeof CONFIGURABLE_BUILTIN_PROVIDER_IDS[number]

export interface ModelAdapter {
  readonly provider: string
  readonly displayName: string
  readonly source?: 'builtin' | 'custom'
  readonly defaultModel: string | null
  readonly subagentModel?: string
  readonly availableModels?: readonly string[]
  readonly modelCapabilitySnapshots?: readonly ModelCapabilitySnapshot[]
  readonly contextWindowTokens?: number
  readonly modalities?: readonly ('text' | 'image' | 'audio' | 'pdf')[]
  readonly protocol?: 'responses' | 'chat_completions' | null
  readonly agentToolSchemaMode: AgentToolSchemaMode
  readonly agentRuntimeCapabilities: AgentRuntimeCapabilities
  readonly cacheNamespace?: string

  isConfigured(): boolean
  capabilities(): string[]
  resolveModelCapabilities?(modelName: string): ModelCapabilitySnapshot
  warmup?(): Promise<void>
  createAgentModel?(modelName?: string | null): Model
  chat(prompt: string, kwargs?: Record<string, unknown>): Promise<Record<string, unknown>>
  close?(): Promise<void>
}

// --- Registry ---

export class ModelAdapterRegistry {
  private adapters = new Map<string, ModelAdapter>()
  private readonly customProviderIds = new Set<string>()
  private readonly builtinFactories = new Map<ModelProviderId, () => ModelAdapter>()
  readonly defaultProvider: string
  readonly defaultModelName: string | null

  constructor(env: Env) {
    this.defaultProvider = env.DEFAULT_MODEL_PROVIDER ?? ''
    this.defaultModelName = env.DEFAULT_MODEL_NAME ?? null

    const dmf = (p: string) => env.DEFAULT_MODEL_PROVIDER === p ? (env.DEFAULT_MODEL_NAME ?? '') : ''

    const builtinFactories: Array<readonly [ModelProviderId, () => ModelAdapter]> = [
      ['deepseek', () => createDeepSeekAdapter({
        baseUrl: env.DEEPSEEK_BASE_URL ?? '',
        // Provider 密钥只允许由设置页写入数据库，再由自定义 Provider 服务装配。
        // 内置壳不得从进程环境或 SDK 默认凭据回退读取。
        apiKey: '',
        defaultModel: (env.DEEPSEEK_MODEL ?? dmf('deepseek')),
        toolSchemaMode: env.DEEPSEEK_TOOL_SCHEMA_MODE,
      })],
      ['anthropic', () => createAnthropicAdapter({
        baseUrl: env.ANTHROPIC_BASE_URL ?? '',
        apiKey: '',
        defaultModel: (env.ANTHROPIC_MODEL ?? dmf('anthropic')),
        version: env.ANTHROPIC_VERSION ?? '',
      })],
      ['gemini', () => createGeminiAdapter({
        baseUrl: env.GEMINI_BASE_URL ?? '',
        apiKey: '',
        defaultModel: (env.GEMINI_MODEL ?? dmf('gemini')),
      })],
      ['ollama', () => createOllamaAdapter({
        baseUrl: env.OLLAMA_BASE_URL ?? '',
        defaultModel: (env.OLLAMA_MODEL ?? dmf('ollama')),
      })],
    ]
    for (const [providerId, factory] of builtinFactories) {
      this.builtinFactories.set(providerId, factory)
      this.register(factory())
    }
  }

  register(adapter: ModelAdapter): void {
    this.adapters.set(adapter.provider, adapter)
  }

  async installCustom(adapter: ModelAdapter): Promise<void> {
    if (
      MODEL_PROVIDER_IDS.includes(adapter.provider as ModelProviderId)
      && !CONFIGURABLE_BUILTIN_PROVIDER_IDS.includes(adapter.provider as ConfigurableBuiltinProviderId)
    ) {
      throw new Error(`内置 Provider '${adapter.provider}' 不支持在设置页覆盖。`)
    }
    if (adapter.source !== 'custom') {
      throw new Error(`动态 Provider '${adapter.provider}' 必须声明 source=custom。`)
    }
    const previous = this.adapters.get(adapter.provider)
    this.adapters.set(adapter.provider, adapter)
    this.customProviderIds.add(adapter.provider)
    if (previous && previous !== adapter) await previous.close?.().catch(() => undefined)
  }

  async removeCustom(providerId: string): Promise<boolean> {
    if (!this.customProviderIds.has(providerId)) return false
    const adapter = this.adapters.get(providerId)
    this.customProviderIds.delete(providerId)
    const builtinFactory = this.builtinFactories.get(providerId as ModelProviderId)
    if (builtinFactory) this.adapters.set(providerId, builtinFactory())
    else this.adapters.delete(providerId)
    await adapter?.close?.().catch(() => undefined)
    return true
  }

  get(provider: string): ModelAdapter {
    const a = this.adapters.get(provider)
    if (!a) throw new Error(`未注册的 provider: ${provider}`)
    return a
  }

  resolveProvider(provider?: string | null): ModelAdapter {
    const selected = provider ?? this.defaultProvider
    if (!selected) throw new Error('必须显式指定模型 provider，或配置 DEFAULT_MODEL_PROVIDER')
    const adapter = this.adapters.get(selected)
    if (!adapter) throw new Error(`未注册的模型 provider: ${selected}`)
    if (!adapter.isConfigured()) throw new Error(`模型 provider '${selected}' 尚未配置`)
    return adapter
  }

  providers(): string[] {
    return [...this.adapters.keys()].sort()
  }

  descriptors(): ModelProviderDescriptor[] {
    return [...this.adapters.values()].map(a => {
      const models = adapterModelCapabilitySnapshots(a)
      const defaultModelCapabilities = a.defaultModel
        ? models.find(model => model.modelId === a.defaultModel) ?? null
        : null
      const supportsAgentRuntime = Boolean(
        a.createAgentModel
        && defaultModelCapabilities?.capabilities.toolCalls
        && defaultModelCapabilities.capabilities.structuredOutput
        && a.agentRuntimeCapabilities.functionTools
        && a.agentRuntimeCapabilities.structuredOutput !== 'none',
      )
      const labels = supportsAgentRuntime
        ? [
            'agents_sdk_live_supervisor',
            `agents_sdk_transport_${a.agentRuntimeCapabilities.transport}`,
            `tool_schema_${a.agentToolSchemaMode}`,
          ]
        : []

      return {
        provider: a.provider,
        displayName: a.displayName,
        configured: a.isConfigured(),
        source: a.source ?? 'builtin',
        defaultModel: a.defaultModel,
        availableModels: models.map(model => model.modelId),
        models,
        capabilities: [...a.capabilities(), ...labels],
        modalities: [...(defaultModelCapabilities?.modalities ?? a.modalities ?? ['text'])],
        protocol: a.protocol ?? null,
        agentRuntime: a.agentRuntimeCapabilities,
        contextWindowTokens: defaultModelCapabilities?.contextWindowTokens
          ?? a.contextWindowTokens
          ?? inferContextWindow(a.defaultModel),
      }
    })
  }

  /**
   * Provider transport 预热属于启动就绪的一部分。只预热已配置的默认
   * provider；未配置 provider 不触发外部网络，也不改变可选 provider 的
   * 发现和错误语义。
   */
  async warmup(): Promise<void> {
    const provider = this.defaultProvider.trim()
    if (!provider) return
    const adapter = this.adapters.get(provider)
    if (!adapter?.isConfigured()) return
    await adapter.warmup?.()
  }

  async close(): Promise<void> {
    await Promise.all([...this.adapters.values()].map(adapter => adapter.close?.()))
    this.customProviderIds.clear()
  }
}

export function resolveAdapterModelCapabilities(
  adapter: ModelAdapter,
  requestedModel: string | null | undefined,
): ModelCapabilitySnapshot {
  const modelId = requestedModel?.trim() || adapter.defaultModel?.trim()
  if (!modelId) throw new Error(`模型 provider '${adapter.provider}' 未配置模型名称`)
  const resolved = adapter.resolveModelCapabilities?.(modelId)
    ?? adapter.modelCapabilitySnapshots?.find(model => model.modelId === modelId)
  if (resolved) return resolved

  const declaredModels = [...new Set([
    ...(adapter.availableModels ?? []),
    ...(adapter.defaultModel ? [adapter.defaultModel] : []),
    ...(adapter.subagentModel ? [adapter.subagentModel] : []),
  ])]
  if (declaredModels.length && !declaredModels.includes(modelId)) {
    throw new Error(`模型 '${modelId}' 不在 Provider '${adapter.provider}' 的允许清单中。`)
  }
  return {
    modelId,
    contextWindowTokens: adapter.contextWindowTokens ?? inferContextWindow(modelId),
    capabilities: {
      reasoning: adapter.capabilities().includes('reasoning'),
      structuredOutput: adapter.agentRuntimeCapabilities.structuredOutput !== 'none',
      toolCalls: adapter.agentRuntimeCapabilities.functionTools,
    },
    modalities: [...(adapter.modalities ?? ['text'])],
  }
}

function adapterModelCapabilitySnapshots(adapter: ModelAdapter): ModelCapabilitySnapshot[] {
  if (adapter.modelCapabilitySnapshots?.length) return [...adapter.modelCapabilitySnapshots]
  const modelIds = [...new Set([
    ...(adapter.availableModels ?? []),
    ...(adapter.defaultModel ? [adapter.defaultModel] : []),
    ...(adapter.subagentModel ? [adapter.subagentModel] : []),
  ])]
  return modelIds.map(modelId => resolveAdapterModelCapabilities(adapter, modelId))
}

function inferContextWindow(model: string | null): number {
  const normalized = (model ?? '').toLowerCase()
  if (normalized.includes('gemini-2.5')) return 1_000_000
  return 128_000
}

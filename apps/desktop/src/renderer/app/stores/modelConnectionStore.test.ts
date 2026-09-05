// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型路由持久化与回退测试
//
//   文件:       modelConnectionStore.test.ts
//
//   日期:       2026年08月28日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ModelProviderDescriptor } from '@geo-agent-platform/shared-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('model connection selection', () => {
  it('restores a valid non-sensitive provider and model choice', async () => {
    const storage = localStorageFixture({ provider: 'custom-agent', model: 'custom-fast' })
    vi.stubGlobal('window', { localStorage: storage })
    const { useModelConnectionStore } = await import('./modelConnectionStore')

    useModelConnectionStore.getState().applyProviders([
      providerDescriptor('deepseek', 'deepseek-v4-flash'),
      providerDescriptor('custom-agent', 'custom-default', ['custom-fast']),
    ])

    expect(useModelConnectionStore.getState()).toMatchObject({
      provider: 'custom-agent',
      model: 'custom-fast',
    })
    expect(storage.value()).toEqual({ provider: 'custom-agent', model: 'custom-fast' })
  })

  it('falls back to executable DeepSeek and then the first executable Agent provider', async () => {
    const storage = localStorageFixture({ provider: 'missing', model: 'gone' })
    vi.stubGlobal('window', { localStorage: storage })
    const { useModelConnectionStore } = await import('./modelConnectionStore')

    useModelConnectionStore.getState().applyProviders([
      providerDescriptor('first-agent', 'first-model'),
      providerDescriptor('deepseek', 'deepseek-v4-flash'),
    ])
    expect(useModelConnectionStore.getState()).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    })

    useModelConnectionStore.getState().applyProviders([
      providerDescriptor('deepseek', null, [], false),
      providerDescriptor('first-agent', 'first-model'),
    ])
    expect(useModelConnectionStore.getState()).toMatchObject({
      provider: 'first-agent',
      model: 'first-model',
    })
    expect(storage.value()).toEqual({ provider: 'first-agent', model: 'first-model' })
  })

  it('keeps an unavailable service visible without inventing an executable model route', async () => {
    const storage = localStorageFixture({ provider: 'deepseek', model: 'deepseek-v4-flash' })
    vi.stubGlobal('window', { localStorage: storage })
    const { useModelConnectionStore } = await import('./modelConnectionStore')

    useModelConnectionStore.getState().applyProviders([
      providerDescriptor('deepseek', 'deepseek-v4-flash', [], false),
    ])

    expect(useModelConnectionStore.getState()).toMatchObject({
      provider: 'deepseek',
      model: '',
    })
    expect(storage.value()).toBeNull()
  })
})

function localStorageFixture(initial: { provider: string; model: string }) {
  let stored: string | null = JSON.stringify(initial)
  return {
    getItem: vi.fn(() => stored),
    setItem: vi.fn((_key: string, value: string) => {
      stored = value
    }),
    removeItem: vi.fn(() => {
      stored = null
    }),
    value: () => stored ? JSON.parse(stored) as unknown : null,
  }
}

function providerDescriptor(
  provider: string,
  defaultModel: string | null,
  additionalModels: string[] = [],
  configured = true,
): ModelProviderDescriptor {
  const availableModels = defaultModel
    ? [defaultModel, ...additionalModels]
    : additionalModels
  return {
    provider,
    displayName: provider,
    configured,
    source: provider === 'deepseek' ? 'builtin' : 'custom',
    defaultModel,
    availableModels,
    models: availableModels.map(modelId => ({
      modelId,
      contextWindowTokens: 128_000,
      capabilities: { reasoning: false, structuredOutput: true, toolCalls: true },
      modalities: ['text'],
    })),
    capabilities: configured ? ['agents_sdk_live_supervisor', 'responses', 'tool_calls'] : [],
    modalities: ['text'],
    protocol: 'responses',
    contextWindowTokens: 128_000,
    agentRuntime: {
      transport: configured ? 'openai_responses' : 'none',
      structuredOutput: configured ? 'json_schema' : 'none',
      functionTools: configured,
      deferredTools: false,
      toolNamespaces: false,
      localMcp: configured,
      hostedTools: false,
      handoffs: configured,
      multiToolResponse: configured,
      providerParallelToolControl: false,
      remoteConversation: false,
      serverCompaction: false,
    },
  }
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型适配器注册表测试
//
//   文件:       registry.test.ts
//
//   日期:       2026年08月28日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import { parseEnv } from '../framework/env.js'
import { ModelAdapterRegistry, type ModelAdapter } from './registry.js'

describe('ModelAdapterRegistry configurable built-ins', () => {
  it('replaces DeepSeek with a database adapter and restores only the keyless builtin shell', async () => {
    const registry = new ModelAdapterRegistry(testEnv())
    const custom = customAdapter('deepseek')

    await registry.installCustom(custom)
    expect(registry.get('deepseek')).toBe(custom)
    expect(registry.descriptors().find(item => item.provider === 'deepseek')?.source).toBe('custom')

    await expect(registry.removeCustom('deepseek')).resolves.toBe(true)
    expect(custom.close).toHaveBeenCalledOnce()
    expect(registry.get('deepseek')).not.toBe(custom)
    expect(registry.descriptors().find(item => item.provider === 'deepseek')?.source).toBe('builtin')
    expect(registry.descriptors().find(item => item.provider === 'deepseek')?.configured).toBe(false)
  })

  it('allows Ollama overrides but rejects Anthropic and Gemini collisions', async () => {
    const registry = new ModelAdapterRegistry(testEnv())
    await expect(registry.installCustom(customAdapter('ollama'))).resolves.toBeUndefined()
    await expect(registry.installCustom(customAdapter('anthropic'))).rejects.toThrow('不支持在设置页覆盖')
    await expect(registry.installCustom(customAdapter('gemini'))).rejects.toThrow('不支持在设置页覆盖')
    await registry.close()
  })

  it('exposes the Agent route only when the default model declares both required capabilities', async () => {
    const registry = new ModelAdapterRegistry(testEnv())
    await registry.installCustom(agentAdapter('agent-ready', true, true))
    await registry.installCustom(agentAdapter('chat-only', false, false))

    expect(registry.descriptors().find(item => item.provider === 'agent-ready')?.capabilities)
      .toContain('agents_sdk_live_supervisor')
    expect(registry.descriptors().find(item => item.provider === 'chat-only')?.capabilities)
      .not.toContain('agents_sdk_live_supervisor')
    await registry.close()
  })
})

function agentAdapter(provider: string, toolCalls: boolean, structuredOutput: boolean): ModelAdapter {
  const candidate = customAdapter(provider)
  return {
    ...candidate,
    modelCapabilitySnapshots: [{
      modelId: 'model-1',
      contextWindowTokens: 128_000,
      capabilities: { reasoning: false, structuredOutput, toolCalls },
      modalities: ['text'],
    }],
    createAgentModel: vi.fn(() => ({}) as never),
  }
}

function customAdapter(provider: string): ModelAdapter {
  return {
    provider,
    displayName: `Custom ${provider}`,
    source: 'custom',
    defaultModel: 'model-1',
    availableModels: ['model-1'],
    modelCapabilitySnapshots: [{
      modelId: 'model-1',
      contextWindowTokens: 128_000,
      capabilities: { reasoning: false, structuredOutput: true, toolCalls: true },
      modalities: ['text'],
    }],
    protocol: 'responses',
    agentToolSchemaMode: 'compatible',
    agentRuntimeCapabilities: {
      transport: 'openai_responses',
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
    isConfigured: () => true,
    capabilities: () => ['chat'],
    chat: vi.fn(async () => ({ content: 'OK' })),
    close: vi.fn(async () => undefined),
  }
}

function testEnv() {
  return parseEnv({
    API_PORT: '8000',
    API_HOST: '127.0.0.1',
    DATABASE_URL: 'postgres://geo_agent:geo_agent@localhost:5432/geo_agent',
    RUNTIME_ROOT: 'runtime',
    APP_BASE_URL: 'http://localhost:8000',
    BETTER_AUTH_URL: 'http://localhost:8000',
    BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
    ENABLED_TOOL_PROVIDERS: 'geo-platform-plan',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    DEEPSEEK_API_KEY: 'env-secret',
    ANTHROPIC_API_KEY: 'env-anthropic-secret',
    GEMINI_API_KEY: 'env-gemini-secret',
    DEEPSEEK_MODEL: 'deepseek-v4-flash',
  })
}

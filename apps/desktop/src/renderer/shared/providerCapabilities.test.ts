// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型 Provider 能力判定测试
//
//   文件:       providerCapabilities.test.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { ModelProviderDescriptor } from '@geo-agent-platform/shared-types'

import {
  agentRuntimeCapabilitySummary,
  modelRouteUnavailableReason,
  supportsAgentSdkLiveSupervisor,
} from './providerCapabilities'

const deepSeekProvider: ModelProviderDescriptor = {
  provider: 'deepseek',
  displayName: 'DeepSeek',
  configured: true,
  source: 'builtin',
  defaultModel: 'deepseek-v4-flash',
  availableModels: ['deepseek-v4-flash'],
  models: [{
    modelId: 'deepseek-v4-flash',
    contextWindowTokens: 128_000,
    capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
    modalities: ['text'],
  }],
  capabilities: ['agents_sdk_live_supervisor', 'responses', 'tool_calls'],
  modalities: ['text'],
  protocol: 'responses',
  contextWindowTokens: 128000,
  agentRuntime: {
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
}

describe('providerCapabilities', () => {
  it('describes the real DeepSeek Agent runtime boundary', () => {
    expect(supportsAgentSdkLiveSupervisor(deepSeekProvider)).toBe(true)
    expect(agentRuntimeCapabilitySummary(deepSeekProvider)).toBe(
      'DeepSeek 响应接口 · 支持同轮多工具响应 · 由平台本地安全闸门控制并发 · 支持服务端联网搜索 · 服务端连续会话、服务端上下文压缩不可用',
    )
  })

  it('requires the explicit live-supervisor capability instead of inferring it from transport labels', () => {
    expect(supportsAgentSdkLiveSupervisor({
      ...deepSeekProvider,
      capabilities: ['responses', 'tool_calls'],
    })).toBe(false)
  })

  it('does not imply Agent support when no transport is available', () => {
    expect(agentRuntimeCapabilitySummary({
      ...deepSeekProvider,
      agentRuntime: {
        ...deepSeekProvider.agentRuntime,
        transport: 'none',
      },
    })).toBe('该模型服务当前未接入智能分析。')
  })

  it('does not advertise runtime capabilities before the service is configured', () => {
    expect(agentRuntimeCapabilitySummary({
      ...deepSeekProvider,
      configured: false,
    })).toBe('该模型服务尚未配置。')
  })

  it('derives one unavailable reason from provider readiness and the selected model', () => {
    expect(modelRouteUnavailableReason(null, '')).toBe('尚未选择模型服务')
    expect(modelRouteUnavailableReason({
      ...deepSeekProvider,
      configured: false,
    }, 'deepseek-v4-flash')).toBe('DeepSeek 尚未配置')
    expect(modelRouteUnavailableReason(deepSeekProvider, '')).toBe('尚未选择可用模型')
    expect(modelRouteUnavailableReason(deepSeekProvider, 'removed-model'))
      .toBe('模型 removed-model 当前不可用')
    expect(modelRouteUnavailableReason(deepSeekProvider, 'deepseek-v4-flash')).toBeNull()
  })
})

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Provider 配置模板测试
//
//   文件:       providerTemplates.test.ts
//
//   日期:       2026年08月28日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { customProviderConfigSchema } from '@geo-agent-platform/shared-types'
import { describe, expect, it } from 'vitest'

import {
  createModelSnapshot,
  createProviderTemplateValues,
} from './providerTemplates'
import { providerTestNotice } from './providerTestPresentation'

describe('provider setup templates', () => {
  it('uses the approved DeepSeek, OpenAI and Ollama connection defaults', () => {
    expect(createProviderTemplateValues('deepseek').config).toMatchObject({
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      protocol: 'responses',
      defaultModel: 'deepseek-v4-flash',
    })
    expect(createProviderTemplateValues('openai').config).toMatchObject({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'responses',
      models: [],
      defaultModel: '',
    })
    expect(createProviderTemplateValues('ollama').config).toMatchObject({
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      protocol: 'chat_completions',
      models: [],
      defaultModel: '',
    })
  })

  it('gives unknown models conservative editable capability defaults', () => {
    expect(createModelSnapshot('vendor-model', 'custom')).toEqual({
      modelId: 'vendor-model',
      contextWindowTokens: 128_000,
      capabilities: {
        reasoning: false,
        structuredOutput: true,
        toolCalls: true,
      },
      modalities: ['text'],
    })
  })

  it('marks the preferred DeepSeek v4 model as reasoning capable with a 1M context window', () => {
    expect(createModelSnapshot('deepseek-v4-flash', 'deepseek')).toMatchObject({
      contextWindowTokens: 1_000_000,
      capabilities: { reasoning: true },
    })
  })

  it('accepts a reachable HTTP or private-network service without requiring Agent capabilities', () => {
    const model = createModelSnapshot('chat-only-model', 'custom')
    model.capabilities.toolCalls = false
    model.capabilities.structuredOutput = false

    expect(customProviderConfigSchema.safeParse({
      ...createProviderTemplateValues('custom').config,
      providerId: 'lan-provider',
      displayName: '局域网模型',
      baseUrl: 'http://192.168.1.25:8000/v1',
      models: [model],
      defaultModel: model.modelId,
    }).success).toBe(true)
  })

  it('returns field-specific Chinese validation errors', () => {
    const result = customProviderConfigSchema.safeParse({
      ...createProviderTemplateValues('custom').config,
      providerId: '',
      displayName: '',
      baseUrl: '',
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.map(issue => issue.message)).toEqual(expect.arrayContaining([
      '请输入服务标识',
      '请输入显示名称',
      '请输入接口地址',
      '请至少添加一个模型',
      '请选择默认模型',
    ]))
  })

  it('presents optional test results without turning warnings into save blockers', () => {
    expect(providerTestNotice({
      mode: 'connectivity',
      connectivityOk: true,
      modelCallOk: null,
      testedModel: null,
      models: [],
      latencyMs: 12.4,
      testedAt: '2026-08-31T08:00:00.000Z',
      warning: null,
    })).toBe('连接成功，用时 12 毫秒。')

    expect(providerTestNotice({
      mode: 'model_call',
      connectivityOk: true,
      modelCallOk: false,
      testedModel: '自由模型',
      models: [],
      latencyMs: 30,
      testedAt: '2026-08-31T08:00:00.000Z',
      warning: '服务未返回正文',
    })).toContain('这不会阻止保存')
  })
})

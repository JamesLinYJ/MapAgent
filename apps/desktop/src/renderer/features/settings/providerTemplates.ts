// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型 Provider 配置模板
//
//   文件:       providerTemplates.ts
//
//   日期:       2026年08月28日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  CustomProviderConfig,
  CustomProviderRecord,
  ModelCapabilitySnapshot,
} from '@geo-agent-platform/shared-types'

export type ProviderTemplateId = 'deepseek' | 'openai' | 'ollama' | 'custom'

export interface ProviderTemplateDefinition {
  id: ProviderTemplateId
  label: string
  description: string
  endpointHint: string
  apiKeyRecommended: boolean
  providerIdLocked: boolean
}

export interface ProviderWizardValues {
  config: CustomProviderConfig
  apiKey: string
  clearApiKey: boolean
}

export const PROVIDER_TEMPLATES: readonly ProviderTemplateDefinition[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: '官方响应接口，直接配置现有 DeepSeek 服务。',
    endpointHint: 'https://api.deepseek.com',
    apiKeyRecommended: true,
    providerIdLocked: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: '官方响应接口，通过模型目录选择可用模型。',
    endpointHint: 'https://api.openai.com/v1',
    apiKeyRecommended: true,
    providerIdLocked: true,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    description: '本机兼容接口，访问密钥可选。',
    endpointHint: 'http://127.0.0.1:11434/v1',
    apiKeyRecommended: false,
    providerIdLocked: true,
  },
  {
    id: 'custom',
    label: '自定义兼容服务',
    description: '配置其他响应接口或对话补全兼容端点。',
    endpointHint: 'https://api.provider.example/v1',
    apiKeyRecommended: false,
    providerIdLocked: false,
  },
] as const

export function providerTemplate(id: ProviderTemplateId): ProviderTemplateDefinition {
  const template = PROVIDER_TEMPLATES.find(candidate => candidate.id === id)
  if (!template) throw new Error(`未知模型服务模板 '${id}'。`)
  return template
}

export function createProviderTemplateValues(id: ProviderTemplateId): ProviderWizardValues {
  const deepSeekModel = createModelSnapshot('deepseek-v4-flash', id)
  const config: CustomProviderConfig = id === 'deepseek'
    ? {
        providerId: 'deepseek',
        displayName: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        protocol: 'responses',
        models: [deepSeekModel],
        defaultModel: deepSeekModel.modelId,
        toolSchemaMode: 'compatible',
      }
    : id === 'openai'
      ? {
          providerId: 'openai',
          displayName: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          protocol: 'responses',
          models: [],
          defaultModel: '',
          toolSchemaMode: 'compatible',
        }
      : id === 'ollama'
        ? {
            providerId: 'ollama',
            displayName: 'Ollama',
            baseUrl: 'http://127.0.0.1:11434/v1',
            protocol: 'chat_completions',
            models: [],
            defaultModel: '',
            toolSchemaMode: 'compatible',
          }
        : {
            providerId: '',
            displayName: '',
            baseUrl: '',
            protocol: 'responses',
            models: [],
            defaultModel: '',
            toolSchemaMode: 'compatible',
          }
  return { config, apiKey: '', clearApiKey: false }
}

export function createProviderRecordValues(record: CustomProviderRecord): ProviderWizardValues {
  return {
    config: {
      providerId: record.providerId,
      displayName: record.displayName,
      baseUrl: record.baseUrl,
      protocol: record.protocol,
      models: record.models.map(cloneModelSnapshot),
      defaultModel: record.defaultModel,
      toolSchemaMode: record.toolSchemaMode,
    },
    apiKey: '',
    clearApiKey: false,
  }
}

export function inferProviderTemplate(providerId: string): ProviderTemplateId {
  if (providerId === 'deepseek' || providerId === 'openai' || providerId === 'ollama') return providerId
  return 'custom'
}

export function createModelSnapshot(
  modelId: string,
  templateId: ProviderTemplateId,
): ModelCapabilitySnapshot {
  const deepSeekV4 = templateId === 'deepseek' && /^deepseek-v4(?:-|$)/u.test(modelId)
  return {
    modelId,
    contextWindowTokens: deepSeekV4 ? 1_000_000 : 128_000,
    capabilities: {
      reasoning: deepSeekV4,
      structuredOutput: true,
      toolCalls: true,
    },
    modalities: ['text'],
  }
}

function cloneModelSnapshot(model: ModelCapabilitySnapshot): ModelCapabilitySnapshot {
  return {
    ...model,
    capabilities: { ...model.capabilities },
    modalities: [...model.modalities],
  }
}

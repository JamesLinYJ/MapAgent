// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型服务与运行配置 API 测试
//
//   文件:       configurationApi.test.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  agentRuntimeConfigSchema,
  type CustomProviderConfig,
} from '@geo-agent-platform/shared-types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestControl = vi.hoisted(() => vi.fn())

vi.mock('./transport', () => ({ requestControl }))

import {
  deleteCustomProvider,
  saveCustomProvider,
  testCustomProvider,
} from './customProviderApi'
import {
  getRuntimeConfig,
  updateRuntimeConfig,
} from './toolApi'

beforeEach(() => {
  requestControl.mockReset()
  requestControl.mockResolvedValue({})
})

describe('configuration API contracts', () => {
  it('sends an explicit Provider revision for create, edit and delete', async () => {
    const config = providerConfig()

    await saveCustomProvider({ config, expectedRevision: null })
    await saveCustomProvider({
      config,
      expectedRevision: 4,
      credentialHandle: 'credential-handle',
      clearApiKey: false,
    })
    await deleteCustomProvider(config.providerId, 5)

    expect(requestControl).toHaveBeenNthCalledWith(1, 'provider:custom:upsert', {
      config,
      expectedRevision: null,
    })
    expect(requestControl).toHaveBeenNthCalledWith(2, 'provider:custom:upsert', {
      config,
      expectedRevision: 4,
      credentialHandle: 'credential-handle',
    })
    expect(requestControl).toHaveBeenNthCalledWith(3, 'provider:custom:delete', {
      providerId: config.providerId,
      expectedRevision: 5,
    })
  })

  it('keeps Provider testing separate from saving', async () => {
    const config = providerConfig()

    await testCustomProvider({
      config,
      mode: 'model_call',
      credentialHandle: 'temporary-handle',
    })

    expect(requestControl).toHaveBeenCalledOnce()
    expect(requestControl).toHaveBeenCalledWith('provider:custom:test', {
      config,
      mode: 'model_call',
      credentialHandle: 'temporary-handle',
    })
  })

  it('reads and updates the versioned runtime configuration document', async () => {
    const config = runtimeConfig()

    await getRuntimeConfig()
    await updateRuntimeConfig(config, 7)

    expect(requestControl).toHaveBeenNthCalledWith(1, 'runtime-config:get')
    expect(requestControl).toHaveBeenNthCalledWith(2, 'runtime-config:update', {
      config,
      expectedRevision: 7,
    })
  })
})

function providerConfig(): CustomProviderConfig {
  return {
    providerId: 'local-model',
    displayName: '本机模型',
    baseUrl: 'http://127.0.0.1:9000/v1',
    protocol: 'responses',
    models: [{
      modelId: 'local-model-v1',
      contextWindowTokens: 128_000,
      capabilities: {
        reasoning: false,
        structuredOutput: true,
        toolCalls: true,
      },
      modalities: ['text'],
    }],
    defaultModel: 'local-model-v1',
    toolSchemaMode: 'compatible',
  }
}

function runtimeConfig() {
  return agentRuntimeConfigSchema.parse({})
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 自定义模型 Provider 服务
//
//   文件:       customProviderService.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  customProviderConfigSchema,
  customProviderIdSchema,
  customProviderRecordSchema,
  customProviderSaveResultSchema,
  customProviderTestResultSchema,
  type CustomProviderConfig,
  type CustomProviderRecord,
  type CustomProviderSaveResult,
  type CustomProviderTestMode,
  type CustomProviderTestResult,
  type ProviderModelDiscovery,
} from '@geo-agent-platform/shared-types'

import type { AuthContext } from '../security/types.js'
import type {
  CustomProviderStore,
  StoredCustomProvider,
} from '../store/postgres/customProviderStore.js'
import { StoreVersionConflictError } from '../store/storeErrors.js'
import { ProviderCredentialStagingService } from './customProviderCredentials.js'
import type { ModelAdapter, ModelAdapterRegistry } from './registry.js'
import {
  CONFIGURABLE_BUILTIN_PROVIDER_IDS,
  MODEL_PROVIDER_IDS,
} from './registry.js'
import { createCustomOpenAIAdapter } from './providers/customOpenAI.js'
import {
  discoverCustomProviderModels,
  probeCustomProviderConnection,
  type CustomProviderConnectionProbe,
  type CustomProviderModelDiscoveryInput,
} from './customProviderModelDiscovery.js'

type CustomProviderRepository = Pick<CustomProviderStore, 'list' | 'get' | 'upsert' | 'delete'>
type CustomProviderRegistry = Pick<ModelAdapterRegistry, 'installCustom' | 'removeCustom' | 'descriptors'>
type AdapterFactory = (input: { config: CustomProviderConfig; apiKey: string }) => ModelAdapter
type ModelDiscovery = (input: CustomProviderModelDiscoveryInput) => Promise<ProviderModelDiscovery>
type ConnectionProbe = (input: CustomProviderModelDiscoveryInput) => Promise<CustomProviderConnectionProbe>

const MINIMAL_MODEL_CALL_OUTPUT_TOKENS = 128

export class CustomProviderService {
  constructor(
    private readonly repository: CustomProviderRepository,
    private readonly registry: CustomProviderRegistry,
    readonly credentials: ProviderCredentialStagingService,
    private readonly adapterFactory: AdapterFactory = createCustomOpenAIAdapter,
    private readonly modelDiscovery: ModelDiscovery = discoverCustomProviderModels,
    private readonly connectionProbe: ConnectionProbe = probeCustomProviderConnection,
  ) {}

  async loadPersistedProviders(): Promise<void> {
    for (const stored of await this.repository.list()) {
      const apiKey = stored.credential ?? ''
      await this.registry.installCustom(this.adapterFactory({ config: publicConfig(stored), apiKey }))
    }
  }

  async list(): Promise<CustomProviderRecord[]> {
    return (await this.repository.list()).map(publicRecord)
  }

  async discoverModels(input: {
    providerId: string
    baseUrl: string
    credentialHandle?: string | null
    auth: AuthContext
  }): Promise<ProviderModelDiscovery> {
    const providerId = customProviderIdSchema.parse(input.providerId)
    const existing = await this.repository.get(providerId)
    const apiKey = input.credentialHandle
      ? this.credentials.resolve(input.credentialHandle, input.auth)
      : existing?.credential ?? ''
    return this.modelDiscovery({
      baseUrl: input.baseUrl,
      apiKey,
    })
  }

  async save(input: {
    config: CustomProviderConfig
    expectedRevision: number | null
    credentialHandle?: string | null
    clearApiKey?: boolean
    auth: AuthContext
  }): Promise<CustomProviderSaveResult> {
    const config = customProviderConfigSchema.parse(input.config)
    if (input.credentialHandle && input.clearApiKey) {
      throw new Error('新 API Key 与清除操作不能同时使用。')
    }
    if (isNonConfigurableBuiltin(config.providerId)) {
      throw new Error(`内置 Provider '${config.providerId}' 不支持在设置页覆盖。`)
    }
    const existing = await this.repository.get(config.providerId)
    if ((existing?.revision ?? null) !== input.expectedRevision) {
      throw new StoreVersionConflictError(
        `模型服务 '${config.providerId}'`,
        input.expectedRevision,
        existing?.revision ?? null,
      )
    }
    const clearApiKey = Boolean(input.clearApiKey)
    const secret = input.credentialHandle
      ? this.credentials.resolve(input.credentialHandle, input.auth)
      : clearApiKey
        ? ''
        : existing?.credential ?? ''
    const candidate = this.adapterFactory({ config, apiKey: secret })
    let installed = false
    try {
      const credential = input.credentialHandle
        ? secret
        : clearApiKey
          ? null
          : existing?.credential ?? null
      const stored = await this.repository.upsert({
        ...config,
        credential,
        createdByUserId: existing?.createdByUserId ?? input.auth.userId,
        lastValidatedAt: existing?.lastValidatedAt ?? null,
      }, input.expectedRevision)
      await this.registry.installCustom(candidate)
      installed = true
      if (input.credentialHandle) this.credentials.consume(input.credentialHandle, input.auth)
      const descriptor = this.registry.descriptors().find(item => item.provider === config.providerId)
      if (!descriptor) throw new Error(`自定义 Provider '${config.providerId}' 注册后没有描述信息。`)
      return customProviderSaveResultSchema.parse({
        provider: publicRecord(stored),
        descriptor,
        validation: null,
      })
    } finally {
      if (!installed) await candidate.close?.().catch(() => undefined)
    }
  }

  async test(input: {
    config: CustomProviderConfig
    mode: CustomProviderTestMode
    credentialHandle?: string | null
    auth: AuthContext
  }): Promise<CustomProviderTestResult> {
    const config = customProviderConfigSchema.parse(input.config)
    const existing = await this.repository.get(config.providerId)
    const apiKey = input.credentialHandle
      ? this.credentials.resolve(input.credentialHandle, input.auth)
      : existing?.credential ?? ''
    const candidate = this.adapterFactory({ config, apiKey })
    const startedAt = performance.now()
    let models: ProviderModelDiscovery['models'] = []
    try {
      if (input.mode === 'connectivity') {
        await this.connectionProbe({ baseUrl: config.baseUrl, apiKey })
      } else if (input.mode === 'models') {
        const discovered = await this.modelDiscovery({ baseUrl: config.baseUrl, apiKey })
        models = discovered.models
      } else {
        await candidate.chat('请简短回复连接成功。', {
          model: config.defaultModel,
          reasoning: false,
          maxOutputTokens: MINIMAL_MODEL_CALL_OUTPUT_TOKENS,
        })
      }
      return customProviderTestResultSchema.parse({
        mode: input.mode,
        connectivityOk: true,
        modelCallOk: input.mode === 'model_call' ? true : null,
        testedModel: input.mode === 'model_call' ? config.defaultModel : null,
        models,
        latencyMs: elapsedMilliseconds(startedAt),
        testedAt: new Date().toISOString(),
        warning: null,
      })
    } catch (error) {
      return customProviderTestResultSchema.parse({
        mode: input.mode,
        connectivityOk: false,
        modelCallOk: input.mode === 'model_call' ? false : null,
        testedModel: input.mode === 'model_call' ? config.defaultModel : null,
        models: [],
        latencyMs: elapsedMilliseconds(startedAt),
        testedAt: new Date().toISOString(),
        warning: error instanceof Error ? error.message : String(error),
      })
    } finally {
      await candidate.close?.().catch(() => undefined)
    }
  }

  async delete(providerId: string, expectedRevision: number): Promise<boolean> {
    if (isNonConfigurableBuiltin(providerId)) throw new Error('不能删除该内置模型 Provider。')
    const deleted = await this.repository.delete(providerId, expectedRevision)
    if (deleted) await this.registry.removeCustom(providerId)
    return deleted
  }
}

function isNonConfigurableBuiltin(providerId: string): boolean {
  return MODEL_PROVIDER_IDS.includes(providerId as (typeof MODEL_PROVIDER_IDS)[number])
    && !CONFIGURABLE_BUILTIN_PROVIDER_IDS.includes(
      providerId as (typeof CONFIGURABLE_BUILTIN_PROVIDER_IDS)[number],
    )
}

function publicConfig(stored: StoredCustomProvider): CustomProviderConfig {
  return customProviderConfigSchema.parse({
    providerId: stored.providerId,
    displayName: stored.displayName,
    baseUrl: stored.baseUrl,
    protocol: stored.protocol,
    models: stored.models,
    defaultModel: stored.defaultModel,
    toolSchemaMode: stored.toolSchemaMode,
  })
}

function publicRecord(stored: StoredCustomProvider): CustomProviderRecord {
  return customProviderRecordSchema.parse({
    ...publicConfig(stored),
    revision: stored.revision,
    hasApiKey: Boolean(stored.credential),
    createdByUserId: stored.createdByUserId,
    lastValidatedAt: stored.lastValidatedAt,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  })
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}

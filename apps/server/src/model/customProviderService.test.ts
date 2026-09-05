import { describe, expect, it, vi } from 'vitest'

import type { CustomProviderConfig } from '@geo-agent-platform/shared-types'

import type { AuthContext } from '../security/types.js'
import type { StoredCustomProvider } from '../store/postgres/customProviderStore.js'
import { StoreVersionConflictError } from '../store/storeErrors.js'
import { ProviderCredentialStagingService } from './customProviderCredentials.js'
import { CustomProviderService } from './customProviderService.js'
import { resolveAdapterModelCapabilities, type ModelAdapter } from './registry.js'

describe('CustomProviderService', () => {
  it('saves without network validation, persists the plaintext credential, and installs through the registry', async () => {
    const records = new Map<string, StoredCustomProvider>()
    const repository = repositoryFor(records)
    const installed: ModelAdapter[] = []
    const registry = registryFor(installed)
    const credentials = new ProviderCredentialStagingService()
    const auth = fakeAuth()
    const staged = credentials.stage('sk-sensitive-provider-key', auth)
    const chat = vi.fn(async () => ({ content: 'OK' }))
    const service = new CustomProviderService(
      repository,
      registry,
      credentials,
      () => adapter(chat),
    )

    const result = await service.save({
      config: config(),
      expectedRevision: null,
      credentialHandle: staged.credentialHandle,
      auth,
    })

    expect(chat).not.toHaveBeenCalled()
    expect(result.provider.hasApiKey).toBe(true)
    expect(result.provider.revision).toBe(1)
    expect(result.validation).toBeNull()
    expect(result.provider.models).toEqual([
      expect.objectContaining({ modelId: 'model-1', contextWindowTokens: 128_000, modalities: ['text', 'image'] }),
      expect.objectContaining({ modelId: 'model-2', contextWindowTokens: 32_000, modalities: ['text'] }),
    ])
    expect(installed).toHaveLength(1)
    expect(records.get('my-provider')?.credential).toBe('sk-sensitive-provider-key')
    expect(() => credentials.resolve(staged.credentialHandle, auth)).toThrow('不存在或已经过期')
  })

  it('does not let an optional failed test block a later save', async () => {
    const records = new Map<string, StoredCustomProvider>()
    const repository = repositoryFor(records)
    const installed: ModelAdapter[] = []
    const service = new CustomProviderService(
      repository,
      registryFor(installed),
      new ProviderCredentialStagingService(),
      () => adapter(vi.fn(async () => { throw new Error('provider unavailable') })),
    )

    const auth = fakeAuth()
    const testResult = await service.test({ config: config(), mode: 'model_call', auth })
    expect(testResult).toMatchObject({ connectivityOk: false, modelCallOk: false })
    expect(testResult.warning).toContain('provider unavailable')

    await expect(service.save({ config: config(), expectedRevision: null, auth })).resolves.toBeDefined()
    expect(records.size).toBe(1)
    expect(installed).toHaveLength(1)
  })

  it('accepts a successful model call even when the provider returns no text', async () => {
    const records = new Map<string, StoredCustomProvider>()
    const installed: ModelAdapter[] = []
    const chat = vi.fn(async () => ({ content: '', raw: { id: 'response_1' } }))
    const service = new CustomProviderService(
      repositoryFor(records),
      registryFor(installed),
      new ProviderCredentialStagingService(),
      () => adapter(chat),
    )

    await expect(service.test({
      config: config(),
      mode: 'model_call',
      auth: fakeAuth(),
    })).resolves.toMatchObject({ connectivityOk: true, modelCallOk: true })
    expect(chat).toHaveBeenCalledWith('请简短回复连接成功。', {
      model: 'model-1',
      reasoning: false,
      maxOutputTokens: 128,
    })
    expect(records.size).toBe(0)
    expect(installed).toHaveLength(0)
  })

  it('keeps connection, model discovery, and model call as independent test modes', async () => {
    const discovery = vi.fn(async () => { throw new Error('没有模型目录') })
    const connectionProbe = vi.fn(async () => ({
      latencyMs: 7,
      testedAt: '2026-08-31T00:00:00.000Z',
    }))
    const service = new CustomProviderService(
      repositoryFor(new Map()),
      registryFor([]),
      new ProviderCredentialStagingService(),
      () => adapter(vi.fn(async () => ({ content: '' }))),
      discovery,
      connectionProbe,
    )
    const auth = fakeAuth()

    await expect(service.test({ config: config(), mode: 'connectivity', auth }))
      .resolves.toMatchObject({ connectivityOk: true, modelCallOk: null, models: [] })
    expect(connectionProbe).toHaveBeenCalledOnce()
    expect(discovery).not.toHaveBeenCalled()

    await expect(service.test({ config: config(), mode: 'models', auth }))
      .resolves.toMatchObject({ connectivityOk: false, modelCallOk: null, models: [] })
    expect(discovery).toHaveBeenCalledOnce()
  })

  it('discovers models with the stored credential or a staged replacement without consuming it', async () => {
    const records = new Map<string, StoredCustomProvider>()
    const credentials = new ProviderCredentialStagingService()
    const auth = fakeAuth()
    const storedConfig = config()
    const now = new Date().toISOString()
    records.set(storedConfig.providerId, {
      ...storedConfig,
      revision: 1,
      credential: 'stored-secret',
      createdByUserId: auth.userId,
      lastValidatedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    const discovery = vi.fn(async () => ({
      models: [{ modelId: 'model-1', ownedBy: 'provider' }],
      latencyMs: 12,
      testedAt: now,
    }))
    const service = new CustomProviderService(
      repositoryFor(records),
      registryFor([]),
      credentials,
      () => adapter(vi.fn(async () => ({ content: 'OK' }))),
      discovery,
    )

    await service.discoverModels({
      providerId: storedConfig.providerId,
      baseUrl: storedConfig.baseUrl,
      auth,
    })
    expect(discovery).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'stored-secret' }))

    const staged = credentials.stage('replacement-secret', auth)
    await service.discoverModels({
      providerId: storedConfig.providerId,
      baseUrl: storedConfig.baseUrl,
      credentialHandle: staged.credentialHandle,
      auth,
    })
    expect(discovery).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'replacement-secret' }))
    expect(credentials.resolve(staged.credentialHandle, auth)).toBe('replacement-secret')
  })

  it('retains, replaces, and explicitly clears a saved API key', async () => {
    const records = new Map<string, StoredCustomProvider>()
    const credentials = new ProviderCredentialStagingService()
    const auth = fakeAuth()
    const usedSecrets: string[] = []
    const installed: ModelAdapter[] = []
    const service = new CustomProviderService(
      repositoryFor(records),
      registryFor(installed),
      credentials,
      ({ apiKey }) => {
        usedSecrets.push(apiKey)
        return adapter(vi.fn(async () => ({ content: 'OK' })))
      },
    )

    const original = credentials.stage('original-secret', auth)
    await service.save({
      config: config(),
      expectedRevision: null,
      credentialHandle: original.credentialHandle,
      auth,
    })
    const originalCredential = records.get('my-provider')?.credential
    expect(originalCredential).not.toBeNull()

    await service.save({ config: config({ displayName: 'Renamed' }), expectedRevision: 1, auth })
    expect(records.get('my-provider')?.credential).toEqual(originalCredential)

    const replacement = credentials.stage('replacement-secret', auth)
    await service.save({
      config: config(),
      expectedRevision: 2,
      credentialHandle: replacement.credentialHandle,
      auth,
    })
    expect(records.get('my-provider')?.credential).toBe('replacement-secret')

    const cleared = await service.save({
      config: config(),
      expectedRevision: 3,
      clearApiKey: true,
      auth,
    })
    expect(cleared.provider.hasApiKey).toBe(false)
    expect(records.get('my-provider')?.credential).toBeNull()
    expect(usedSecrets).toEqual([
      'original-secret',
      'original-secret',
      'replacement-secret',
      '',
    ])

    const conflicting = credentials.stage('conflicting-secret', auth)
    await expect(service.save({
      config: config(),
      expectedRevision: 4,
      credentialHandle: conflicting.credentialHandle,
      clearApiKey: true,
      auth,
    })).rejects.toThrow('不能同时使用')
  })

  it('rejects a stale provider revision without overwriting the saved record', async () => {
    const records = new Map<string, StoredCustomProvider>()
    const service = new CustomProviderService(
      repositoryFor(records),
      registryFor([]),
      new ProviderCredentialStagingService(),
      () => adapter(vi.fn(async () => ({ content: 'OK' }))),
    )
    const auth = fakeAuth()

    await service.save({ config: config({ displayName: 'First' }), expectedRevision: null, auth })
    await expect(service.save({
      config: config({ displayName: 'Stale overwrite' }),
      expectedRevision: null,
      auth,
    })).rejects.toMatchObject({ code: 'version_conflict' })
    expect(records.get('my-provider')).toMatchObject({ displayName: 'First', revision: 1 })
  })

  it('requires the current revision when deleting a provider', async () => {
    const records = new Map<string, StoredCustomProvider>()
    const repository = repositoryFor(records)
    const installed: ModelAdapter[] = []
    const registry = registryFor(installed)
    const service = new CustomProviderService(
      repository,
      registry,
      new ProviderCredentialStagingService(),
      ({ config: providerConfig }) => adapter(
        vi.fn(async () => ({ content: 'OK' })),
        providerConfig.providerId,
        providerConfig.displayName,
      ),
    )

    await service.save({ config: config(), expectedRevision: null, auth: fakeAuth() })
    await expect(service.delete('my-provider', 2)).rejects.toMatchObject({ code: 'version_conflict' })
    expect(records.has('my-provider')).toBe(true)
    await expect(service.delete('my-provider', 1)).resolves.toBe(true)
    expect(records.has('my-provider')).toBe(false)
    expect(registry.removeCustom).toHaveBeenCalledWith('my-provider')
  })

  it('resolves context, modalities, and capabilities from the selected model snapshot', () => {
    const candidate = adapter(vi.fn(async () => ({ content: 'OK' })))

    expect(resolveAdapterModelCapabilities(candidate, 'model-2')).toEqual({
      modelId: 'model-2',
      contextWindowTokens: 32_000,
      capabilities: { reasoning: false, structuredOutput: true, toolCalls: true },
      modalities: ['text', 'image'],
    })
  })
})

function repositoryFor(records: Map<string, StoredCustomProvider>) {
  return {
    list: vi.fn(async () => [...records.values()]),
    get: vi.fn(async (providerId: string) => records.get(providerId) ?? null),
    upsert: vi.fn(async (
      record: Omit<StoredCustomProvider, 'revision' | 'createdAt' | 'updatedAt'>,
      expectedRevision: number | null,
    ) => {
      const existing = records.get(record.providerId)
      if ((existing?.revision ?? null) !== expectedRevision) {
        throw new StoreVersionConflictError(
          `模型服务 '${record.providerId}'`,
          expectedRevision,
          existing?.revision ?? null,
        )
      }
      const now = new Date().toISOString()
      const saved: StoredCustomProvider = {
        ...record,
        revision: expectedRevision === null ? 1 : expectedRevision + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      records.set(record.providerId, saved)
      return saved
    }),
    delete: vi.fn(async (providerId: string, expectedRevision: number) => {
      const existing = records.get(providerId)
      if (!existing) return false
      if (existing.revision !== expectedRevision) {
        throw new StoreVersionConflictError(
          `模型服务 '${providerId}'`,
          expectedRevision,
          existing.revision,
        )
      }
      return records.delete(providerId)
    }),
  }
}

function registryFor(installed: ModelAdapter[]) {
  return {
    installCustom: vi.fn(async (candidate: ModelAdapter) => { installed.push(candidate) }),
    removeCustom: vi.fn(async () => true),
    descriptors: vi.fn(() => installed.map(candidate => ({
      provider: candidate.provider,
      displayName: candidate.displayName,
      configured: true,
      source: 'custom' as const,
      defaultModel: candidate.defaultModel,
      availableModels: [...(candidate.availableModels ?? [])],
      models: [...(candidate.modelCapabilitySnapshots ?? [])],
      capabilities: candidate.capabilities(),
      modalities: ['text' as const],
      protocol: 'responses' as const,
      contextWindowTokens: candidate.contextWindowTokens ?? 128_000,
      agentRuntime: candidate.agentRuntimeCapabilities,
    }))),
  }
}

function adapter(
  chat: ModelAdapter['chat'],
  provider = 'my-provider',
  displayName = 'My Provider',
): ModelAdapter {
  return {
    provider,
    displayName,
    source: 'custom',
    defaultModel: 'model-1',
    availableModels: ['model-1', 'model-2'],
    modelCapabilitySnapshots: [{
      modelId: 'model-1',
      contextWindowTokens: 128_000,
      capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
      modalities: ['text'],
    }, {
      modelId: 'model-2',
      contextWindowTokens: 32_000,
      capabilities: { reasoning: false, structuredOutput: true, toolCalls: true },
      modalities: ['text', 'image'],
    }],
    contextWindowTokens: 128_000,
    modalities: ['text'],
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
    warmup: vi.fn(async () => undefined),
    chat,
    close: vi.fn(async () => undefined),
  }
}

function config(overrides: Partial<CustomProviderConfig> = {}): CustomProviderConfig {
  return {
    providerId: 'my-provider',
    displayName: 'My Provider',
    baseUrl: 'https://api.provider.com/v1',
    protocol: 'responses',
    models: [{
      modelId: 'model-1',
      contextWindowTokens: 128_000,
      capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
      modalities: ['text', 'image'],
    }, {
      modelId: 'model-2',
      contextWindowTokens: 32_000,
      capabilities: { reasoning: false, structuredOutput: true, toolCalls: true },
      modalities: ['text'],
    }],
    defaultModel: 'model-1',
    toolSchemaMode: 'compatible',
    ...overrides,
  }
}

function fakeAuth(): AuthContext {
  return {
    userId: 'user_1',
    subject: 'user_1',
    email: 'user@example.com',
    displayName: 'User',
    authSessionId: 'session_1',
    authSessionExpiresAt: null,
    csrfToken: 'csrf',
    defaultWorkspaceId: 'workspace_1',
    roles: [{ workspaceId: 'workspace_1', role: 'platform_admin' }],
  }
}

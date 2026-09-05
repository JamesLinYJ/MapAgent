// +-------------------------------------------------------------------------
//
//   地理智能平台 - 自定义 Provider 本机兼容桩全流程测试
//
//   文件:       customProviderLifecycle.integration.test.ts
//
//   日期:       2026年08月28日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CustomProviderConfig } from '@geo-agent-platform/shared-types'

import type { Env } from '../framework/env.js'
import type { AuthContext } from '../security/types.js'
import type { StoredCustomProvider } from '../store/postgres/customProviderStore.js'
import { StoreVersionConflictError } from '../store/storeErrors.js'
import { ProviderCredentialStagingService } from './customProviderCredentials.js'
import { CustomProviderService } from './customProviderService.js'
import { ModelAdapterRegistry } from './registry.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => error ? reject(error) : resolve())
  })))
})

describe('custom Provider lifecycle with a local OpenAI-compatible stub', () => {
  it('discovers, saves, uses, reloads, edits, and removes an Ollama override', async () => {
    const requests: string[] = []
    const baseUrl = await startOpenAICompatibleStub(requests)
    const records = new Map<string, StoredCustomProvider>()
    const repository = repositoryFor(records)
    const registry = new ModelAdapterRegistry({} as Env)
    const service = new CustomProviderService(
      repository,
      registry,
      new ProviderCredentialStagingService(),
    )
    const config = ollamaOverride(baseUrl)

    const discovery = await service.discoverModels({
      providerId: 'ollama',
      baseUrl,
      auth: fakeAuth(),
    })
    expect(discovery.models).toEqual([{ modelId: 'stub-agent', ownedBy: 'local-stub' }])

    const tested = await service.test({ config, mode: 'model_call', auth: fakeAuth() })
    expect(tested).toMatchObject({ connectivityOk: true, modelCallOk: true })

    const saved = await service.save({ config, expectedRevision: null, auth: fakeAuth() })
    expect(saved.provider).toMatchObject({ providerId: 'ollama', hasApiKey: false })
    expect(registry.descriptors().filter(item => item.provider === 'ollama')).toHaveLength(1)
    expect(registry.get('ollama').source).toBe('custom')
    await expect(registry.resolveProvider('ollama').chat('lifecycle use'))
      .resolves.toMatchObject({ content: 'OK' })

    const reloadedRegistry = new ModelAdapterRegistry({} as Env)
    const reloadedService = new CustomProviderService(
      repository,
      reloadedRegistry,
      new ProviderCredentialStagingService(),
    )
    await reloadedService.loadPersistedProviders()
    expect(reloadedRegistry.get('ollama').source).toBe('custom')
    await expect(reloadedRegistry.resolveProvider('ollama').chat('after restart'))
      .resolves.toMatchObject({ content: 'OK' })

    await expect(reloadedService.save({
      config: { ...config, displayName: 'Ollama 过期草稿' },
      expectedRevision: null,
      auth: fakeAuth(),
    })).rejects.toMatchObject({ code: 'version_conflict' })
    expect(records.get('ollama')).toMatchObject({ displayName: 'Ollama 本机', revision: 1 })

    await reloadedService.save({
      config: { ...config, displayName: 'Ollama 本机编辑版' },
      expectedRevision: 1,
      auth: fakeAuth(),
    })
    expect(records.get('ollama')?.displayName).toBe('Ollama 本机编辑版')
    await expect(reloadedService.delete('ollama', 2)).resolves.toBe(true)
    expect(records.has('ollama')).toBe(false)
    expect(reloadedRegistry.get('ollama').source).toBeUndefined()
    expect(reloadedRegistry.get('ollama').isConfigured()).toBe(false)

    expect(requests).toContain('/v1/models')
    expect(requests.filter(pathname => pathname === '/v1/chat/completions').length)
      .toBeGreaterThanOrEqual(3)
    await registry.close()
    await reloadedRegistry.close()
  })
})

async function startOpenAICompatibleStub(requests: string[]): Promise<string> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    requests.push(pathname)
    response.setHeader('content-type', 'application/json')
    if (request.method === 'GET' && pathname === '/v1/models') {
      response.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'stub-agent', object: 'model', owned_by: 'local-stub' }],
      }))
      return
    }
    if (request.method === 'POST' && pathname === '/v1/chat/completions') {
      response.end(JSON.stringify({
        id: 'chatcmpl_local_stub',
        object: 'chat.completion',
        created: 1,
        model: 'stub-agent',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'OK' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: { message: 'not found' } }))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}/v1`
}

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
      const stored: StoredCustomProvider = {
        ...record,
        revision: expectedRevision === null ? 1 : expectedRevision + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      records.set(record.providerId, stored)
      return stored
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

function ollamaOverride(baseUrl: string): CustomProviderConfig {
  return {
    providerId: 'ollama',
    displayName: 'Ollama 本机',
    baseUrl,
    protocol: 'chat_completions',
    models: [{
      modelId: 'stub-agent',
      contextWindowTokens: 128_000,
      capabilities: { reasoning: false, structuredOutput: true, toolCalls: true },
      modalities: ['text'],
    }],
    defaultModel: 'stub-agent',
    toolSchemaMode: 'compatible',
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

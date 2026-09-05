// +-------------------------------------------------------------------------
//
//   地理智能平台 - 自定义 Provider 模型发现测试
//
//   文件:       customProviderModelDiscovery.test.ts
//
//   日期:       2026年08月28日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { OpenAIClientTransport } from './providers/openaiTransport.js'
import {
  discoverCustomProviderModels,
  probeCustomProviderConnection,
} from './customProviderModelDiscovery.js'

describe('discoverCustomProviderModels', () => {
  it('treats any HTTP response as connected without requiring a model directory', async () => {
    const request = vi.fn(async () => new Response('not found', { status: 404 }))
    await expect(probeCustomProviderConnection({
      baseUrl: 'http://special-dns.local:8080/proxy/v1',
      apiKey: '',
    }, {
      createTransport: () => transport(request),
      now: increasingClock(2_000, 2_009),
    })).resolves.toMatchObject({ latencyMs: 9 })
    expect(request).toHaveBeenCalledWith(
      'http://special-dns.local:8080/proxy/v1/models',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    )
  })

  it('reads, deduplicates, and bounds an authenticated public model directory', async () => {
    const models = Array.from({ length: 205 }, (_, index) => ({
      id: `model-${index}`,
      owned_by: index % 2 ? 'provider' : null,
    }))
    models.splice(2, 0, { id: 'model-0', owned_by: 'duplicate' })
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer staged-secret' })
      return jsonResponse({ data: models })
    })
    const close = vi.fn(async () => undefined)

    const result = await discoverCustomProviderModels({
      baseUrl: 'https://api.provider.com/v1',
      apiKey: 'staged-secret',
    }, {
      createTransport: () => transport(request, close),
      now: increasingClock(1_000, 1_025),
    })

    expect(request).toHaveBeenCalledWith(
      'https://api.provider.com/v1/models',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    )
    expect(result.models).toHaveLength(200)
    expect(result.models[0]).toEqual({ modelId: 'model-0', ownedBy: null })
    expect(result.latencyMs).toBe(25)
    expect(JSON.stringify(result)).not.toContain('staged-secret')
    expect(close).toHaveBeenCalledOnce()
  })

  it('allows an unauthenticated loopback model directory', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).not.toHaveProperty('authorization')
      return jsonResponse({ data: [{ id: 'qwen-local' }] })
    })

    await expect(discoverCustomProviderModels({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
    }, { createTransport: () => transport(request) })).resolves.toMatchObject({
      models: [{ modelId: 'qwen-local', ownedBy: null }],
    })
  })

  it.each([
    [401, 'API Key 无效'],
    [403, 'API Key 无效'],
    [404, '/models 接口'],
    [429, '正在限流'],
  ])('returns a stable message for HTTP %s', async (status, expected) => {
    await expect(discoverCustomProviderModels({
      baseUrl: 'https://api.provider.com/v1',
      apiKey: 'secret',
    }, {
      createTransport: () => transport(vi.fn(async () => new Response('hidden body', { status }))),
    })).rejects.toThrow(expected)
  })

  it('rejects malformed and oversized model directories without exposing the body', async () => {
    await expect(discoverCustomProviderModels({
      baseUrl: 'https://api.provider.com/v1',
      apiKey: '',
    }, {
      createTransport: () => transport(vi.fn(async () => jsonResponse({ unexpected: 'secret body' }))),
    })).rejects.toThrow('格式无效')

    await expect(discoverCustomProviderModels({
      baseUrl: 'https://api.provider.com/v1',
      apiKey: '',
    }, {
      createTransport: () => transport(vi.fn(async () => new Response('{}', {
        headers: { 'content-length': String(513 * 1_024) },
      }))),
    })).rejects.toThrow('512 KiB')
  })

  it('maps transport timeouts to a stable Chinese error', async () => {
    await expect(discoverCustomProviderModels({
      baseUrl: 'https://api.provider.com/v1',
      apiKey: '',
    }, {
      createTransport: () => transport(vi.fn(async () => {
        throw new DOMException('timed out', 'TimeoutError')
      })),
    })).rejects.toThrow('模型发现超时')
  })
})

function transport(
  request: typeof globalThis.fetch,
  close = vi.fn(async () => undefined),
): OpenAIClientTransport {
  return { fetch: request, close }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function increasingClock(...values: number[]): () => number {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)] ?? 0
}

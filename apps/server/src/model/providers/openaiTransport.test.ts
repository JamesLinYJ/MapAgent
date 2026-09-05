// +-------------------------------------------------------------------------
//
//   地理智能平台 - OpenAI 兼容 Transport 测试
//
//   文件:       openaiTransport.test.ts
//
//   日期:       2026年08月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { LookupAddress, LookupOneOptions } from 'node:dns'
import { createServer, type Server } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BoundedDnsLookupCache,
  createBoundedSystemIpv4Resolver,
  OpenAIProviderTransport,
  selectOpenAIDnsStrategy,
  type DnsAddressResolver,
} from './openaiTransport.js'

const caches: BoundedDnsLookupCache[] = []
const transports: OpenAIProviderTransport[] = []
const servers: Server[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const transport of transports.splice(0)) await transport.close()
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  for (const cache of caches.splice(0)) cache.close()
})

describe('BoundedDnsLookupCache', () => {
  it('coalesces concurrent cold lookups for one hostname', async () => {
    const pending = deferred<LookupAddress[]>()
    const resolver = vi.fn(() => pending.promise)
    const cache = createCache(resolver)

    const first = cache.prime('api.deepseek.example')
    const second = cache.prime('api.deepseek.example')

    expect(resolver).toHaveBeenCalledOnce()
    pending.resolve([{ address: '203.0.113.10', family: 4 }])
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
  })

  it('serves cache hits without another DNS query and rotates resolved addresses', async () => {
    const resolver = vi.fn(async () => [
      { address: '203.0.113.10', family: 4 as const },
      { address: '203.0.113.11', family: 4 as const },
    ])
    const cache = createCache(resolver)

    const first = await lookupOne(cache, 'api.deepseek.example')
    const second = await lookupOne(cache, 'api.deepseek.example')

    expect(resolver).toHaveBeenCalledOnce()
    expect(first.address).toBe('203.0.113.10')
    expect(second.address).toBe('203.0.113.11')
  })

  it('refreshes cached addresses in the background before hard expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'))
    const resolver = vi.fn<DnsAddressResolver>()
      .mockResolvedValueOnce([{ address: '203.0.113.10', family: 4 }])
      .mockResolvedValueOnce([{ address: '203.0.113.20', family: 4 }])
    const cache = createCache(resolver, { ttlMs: 1_000, refreshAfterMs: 500 })

    await cache.prime('api.deepseek.example')
    await vi.advanceTimersByTimeAsync(500)

    expect(resolver).toHaveBeenCalledTimes(2)
    await expect(lookupOne(cache, 'api.deepseek.example')).resolves.toMatchObject({
      address: '203.0.113.20',
    })
  })

  it('propagates a cold DNS failure to every coalesced caller', async () => {
    const failure = Object.assign(new Error('temporary DNS failure'), { code: 'EAI_AGAIN' })
    const resolver = vi.fn(async () => Promise.reject(failure))
    const cache = createCache(resolver)

    const first = cache.prime('api.deepseek.example')
    const second = cache.prime('api.deepseek.example')

    await expect(first).rejects.toBe(failure)
    await expect(second).rejects.toBe(failure)
    expect(resolver).toHaveBeenCalledOnce()
  })

  it('keeps a known address after refresh failure but stops serving it at hard expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'))
    const failure = Object.assign(new Error('refresh DNS failure'), { code: 'EAI_AGAIN' })
    const resolver = vi.fn<DnsAddressResolver>()
      .mockResolvedValueOnce([{ address: '203.0.113.10', family: 4 }])
      .mockRejectedValue(failure)
    const cache = createCache(resolver, {
      ttlMs: 1_000,
      refreshAfterMs: 500,
    })

    await cache.prime('api.deepseek.example')
    await vi.advanceTimersByTimeAsync(500)
    await expect(lookupOne(cache, 'api.deepseek.example')).resolves.toMatchObject({
      address: '203.0.113.10',
    })

    await vi.advanceTimersByTimeAsync(500)
    await expect(lookupOne(cache, 'api.deepseek.example')).rejects.toBe(failure)
  })

  it('caps hard expiry at the minimum authoritative DNS TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'))
    const failure = Object.assign(new Error('authoritative refresh failed'), { code: 'ETIMEOUT' })
    const resolver = vi.fn<DnsAddressResolver>()
      .mockResolvedValueOnce([
        { address: '203.0.113.10', family: 4, ttl: 2 },
        { address: '203.0.113.11', family: 4, ttl: 5 },
      ])
      .mockRejectedValue(failure)
    const cache = createCache(resolver, {
      ttlMs: 60_000,
      refreshAfterMs: 30_000,
    })

    await cache.prime('api.deepseek.example', 4)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(lookupOne(cache, 'api.deepseek.example', 4)).resolves.toMatchObject({
      address: '203.0.113.10',
    })

    await vi.advanceTimersByTimeAsync(1_000)
    await expect(lookupOne(cache, 'api.deepseek.example', 4)).rejects.toBe(failure)
  })

  it('evicts the least recently used hostname when the cache reaches its bound', async () => {
    const resolver = vi.fn(async (hostname: string) => [{
      address: hostname === 'first.example' ? '203.0.113.10' : '203.0.113.20',
      family: 4 as const,
    }])
    const cache = createCache(resolver, { maxEntries: 1 })

    await cache.prime('first.example')
    await cache.prime('second.example')
    await cache.prime('first.example')

    expect(resolver).toHaveBeenCalledTimes(3)
  })
})

describe('createBoundedSystemIpv4Resolver', () => {
  it('uses bounded c-ares options and reads the current OS servers for every resolution', async () => {
    let configuredServers = ['fdfe::10', '198.18.0.2']
    const getServers = vi.fn(() => [...configuredServers])
    const constructorOptions: unknown[] = []
    const appliedServers: string[][] = []
    const resolve4 = vi.fn((
      _hostname: string,
      _options: { ttl: true },
      callback: (error: NodeJS.ErrnoException | null, records: Array<{ address: string; ttl: number }>) => void,
    ) => callback(null, [{ address: '203.0.113.10', ttl: 5 }]))
    const resolver = createBoundedSystemIpv4Resolver({
      getServers,
      createResolver: options => {
        constructorOptions.push(options)
        return {
          setServers: servers => appliedServers.push([...servers]),
          resolve4,
        }
      },
    })

    await expect(resolver('api.deepseek.example', 4)).resolves.toEqual([
      { address: '203.0.113.10', family: 4, ttl: 5 },
    ])
    configuredServers = ['192.168.110.2']
    await resolver('api.deepseek.example', 4)

    expect(constructorOptions).toEqual([
      { timeout: 500, tries: 1 },
      { timeout: 500, tries: 1 },
    ])
    expect(getServers).toHaveBeenCalledTimes(2)
    expect(appliedServers).toEqual([
      ['fdfe::10', '198.18.0.2'],
      ['192.168.110.2'],
    ])
    expect(resolve4).toHaveBeenCalledWith(
      'api.deepseek.example',
      { ttl: true },
      expect.any(Function),
    )
  })

  it('propagates the c-ares failure object unchanged', async () => {
    const failure = Object.assign(new Error('c-ares timeout'), { code: 'ETIMEOUT' })
    const resolver = createBoundedSystemIpv4Resolver({
      getServers: () => ['192.0.2.53'],
      createResolver: () => ({
        setServers: () => undefined,
        resolve4: (_hostname, _options, callback) => callback(failure, []),
      }),
    })

    await expect(resolver('api.deepseek.example', 4)).rejects.toBe(failure)
  })
})

describe('OpenAIProviderTransport', () => {
  it('exposes DNS priming as startup readiness before the first fetch', async () => {
    const pending = deferred<LookupAddress[]>()
    const resolver = vi.fn(() => pending.promise)
    const cache = createCache(resolver)
    const fetchImplementation = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    const transport = new OpenAIProviderTransport('https://api.deepseek.com', {
      dnsCache: cache,
      fetchImplementation,
    })
    transports.push(transport)

    const warmup = transport.warmup?.()
    expect(fetchImplementation).not.toHaveBeenCalled()
    pending.resolve([{ address: '203.0.113.10', family: 4 }])
    await warmup
    await transport.fetch('https://api.deepseek.com/responses')

    expect(resolver).toHaveBeenCalledOnce()
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it('automatically primes the canonical DeepSeek host and propagates its failure before fetch', async () => {
    const failure = Object.assign(new Error('DNS prime failed'), { code: 'EAI_AGAIN' })
    const resolver = vi.fn(async () => Promise.reject(failure))
    const cache = createCache(resolver)
    const fetchImplementation = vi.fn<typeof globalThis.fetch>()
    const transport = new OpenAIProviderTransport('https://api.deepseek.com', {
      dnsCache: cache,
      fetchImplementation,
    })
    transports.push(transport)

    expect(resolver).toHaveBeenCalledOnce()
    expect(resolver).toHaveBeenCalledWith('api.deepseek.com', 4)
    await expect(transport.fetch('https://api.deepseek.com/responses')).rejects.toBe(failure)
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('passes a normal request body through without pre-buffering it', async () => {
    const body = new Blob(['large-provider-request'])
    const fetchImplementation = vi.fn(async (_input, init) => {
      expect(init?.body).toBe(body)
      return new Response('{"ok":true}', { status: 200 })
    })
    const transport = new OpenAIProviderTransport('http://127.0.0.1:11434', {
      fetchImplementation,
    })
    transports.push(transport)

    const response = await transport.fetch('http://127.0.0.1:11434/responses', {
      method: 'POST',
      body,
    })

    expect(response.status).toBe(200)
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it.each([
    ['localhost', 'http://localhost:11434'],
    ['IPv4 literal', 'http://127.0.0.1:11434'],
    ['IPv6 literal', 'http://[::1]:11434'],
    ['hosts-file alias', 'http://deepseek.internal:11434'],
  ])('keeps %s on system DNS without bounded IPv4 priming', async (_label, baseUrl) => {
    const resolver = vi.fn<DnsAddressResolver>(async () => [{ address: '203.0.113.10', family: 4 }])
    const cache = createCache(resolver)
    const fetchImplementation = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    const transport = new OpenAIProviderTransport(baseUrl, {
      dnsCache: cache,
      fetchImplementation,
    })
    transports.push(transport)

    const response = await transport.fetch(`${baseUrl}/health`)

    expect(response.status).toBe(200)
    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(resolver).not.toHaveBeenCalled()
  })

  it('allows an explicit bounded IPv4 opt-in for a custom host', () => {
    expect(selectOpenAIDnsStrategy('api.deepseek.example', 'bounded-ipv4')).toBe('bounded-ipv4')
    expect(selectOpenAIDnsStrategy('api.deepseek.com', 'system')).toBe('system')
  })

  it('uses the primed IPv4 cache for the actual Undici connection', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试 HTTP server 未监听 TCP 端口。')

    const resolver = vi.fn<DnsAddressResolver>(async () => [{ address: '127.0.0.1', family: 4 }])
    const cache = createCache(resolver)
    const transport = new OpenAIProviderTransport(`http://api.deepseek.example:${address.port}`, {
      dnsCache: cache,
      dnsStrategy: 'bounded-ipv4',
    })
    transports.push(transport)

    const response = await transport.fetch(`http://api.deepseek.example:${address.port}/health`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(resolver.mock.calls).toEqual([['api.deepseek.example', 4]])
  })

  it('blocks a verified endpoint from redirecting a provider request to another origin', async () => {
    let redirectedRequests = 0
    const redirectedServer = createServer((_request, response) => {
      redirectedRequests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"secret":"loopback service"}')
    })
    servers.push(redirectedServer)
    const redirectedPort = await listenOnLoopback(redirectedServer)

    const providerServer = createServer((_request, response) => {
      response.writeHead(302, {
        location: `http://127.0.0.1:${redirectedPort}/internal`,
      })
      response.end()
    })
    servers.push(providerServer)
    const providerPort = await listenOnLoopback(providerServer)
    const providerOrigin = `http://127.0.0.1:${providerPort}`
    const transport = new OpenAIProviderTransport(providerOrigin)
    transports.push(transport)

    await expect(transport.fetch(`${providerOrigin}/responses`))
      .rejects.toThrow('跨来源重定向')
    expect(redirectedRequests).toBe(0)
  })

  it('preserves same-origin provider redirects', async () => {
    const paths: string[] = []
    const methods: string[] = []
    const bodies: string[] = []
    const providerServer = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        paths.push(request.url ?? '')
        methods.push(request.method ?? '')
        bodies.push(body)
        if (request.url === '/responses') {
          response.writeHead(307, { location: '/v1/responses' })
          response.end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
      })
    })
    servers.push(providerServer)
    const providerPort = await listenOnLoopback(providerServer)
    const providerOrigin = `http://127.0.0.1:${providerPort}`
    const transport = new OpenAIProviderTransport(providerOrigin)
    transports.push(transport)

    const response = await transport.fetch(`${providerOrigin}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"test"}',
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(paths).toEqual(['/responses', '/v1/responses'])
    expect(methods).toEqual(['POST', 'POST'])
    expect(bodies).toEqual(['{"model":"test"}', '{"model":"test"}'])
  })
})

function createCache(
  resolver: DnsAddressResolver,
  overrides: Partial<ConstructorParameters<typeof BoundedDnsLookupCache>[0]> = {},
): BoundedDnsLookupCache {
  const cache = new BoundedDnsLookupCache({
    resolver,
    ttlMs: 60_000,
    refreshAfterMs: 30_000,
    maxEntries: 8,
    maxAddressesPerHostname: 8,
    ...overrides,
  })
  caches.push(cache)
  return cache
}

function lookupOne(
  cache: BoundedDnsLookupCache,
  hostname: string,
  family = 0,
): Promise<LookupAddress> {
  return new Promise((resolve, reject) => {
    cache.lookup(hostname, { all: false, family } as LookupOneOptions, (error, address, resolvedFamily) => {
      if (error) reject(error)
      else resolve({ address: String(address), family: Number(resolvedFamily) })
    })
  })
}

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试 HTTP server 未监听 TCP 端口。')
  return address.port
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

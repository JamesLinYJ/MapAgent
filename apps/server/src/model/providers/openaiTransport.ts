// +-------------------------------------------------------------------------
//
//   地理智能平台 - OpenAI 兼容 HTTP Transport
//
//   文件:       openaiTransport.ts
//
//   日期:       2026年08月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  getServers as getSystemDnsServers,
  Resolver,
  type LookupAddress,
  type LookupOptions,
  type RecordWithTtl,
  type ResolverOptions,
} from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'

import {
  Agent,
  fetch as undiciFetch,
  type Dispatcher,
} from 'undici'

type DnsLookupFamily = 0 | 4 | 6

export interface DnsResolvedAddress extends LookupAddress {
  ttl?: number
}

export type DnsAddressResolver = (
  hostname: string,
  family: DnsLookupFamily,
) => Promise<readonly DnsResolvedAddress[]>

interface Ipv4Resolver {
  setServers(servers: string[]): void
  resolve4(
    hostname: string,
    options: { ttl: true },
    callback: (error: NodeJS.ErrnoException | null, addresses: RecordWithTtl[]) => void,
  ): void
}

export interface SystemIpv4ResolverDependencies {
  getServers?: () => string[]
  createResolver?: (options: ResolverOptions) => Ipv4Resolver
}

export interface DnsLookupCacheOptions {
  resolver?: DnsAddressResolver
  ttlMs?: number
  refreshAfterMs?: number
  maxEntries?: number
  maxAddressesPerHostname?: number
}

interface DnsCacheEntry {
  addresses: DnsResolvedAddress[]
  cursor: number
  expiresAt: number
  refreshTimer: NodeJS.Timeout | null
}

const DEFAULT_DNS_TTL_MS = 120_000
const DEFAULT_DNS_REFRESH_AFTER_MS = 30_000
const DEFAULT_DNS_MAX_ENTRIES = 32
const DEFAULT_DNS_MAX_ADDRESSES = 8

/**
 * Node's connector-compatible DNS lookup with a bounded process-local cache.
 *
 * Fresh entries remain usable while a timer refreshes them in the background.
 * A hard TTL never serves an expired entry: the next connector waits for one
 * coalesced resolution and receives its error unchanged when DNS fails.
 */
export class BoundedDnsLookupCache {
  private readonly resolver: DnsAddressResolver
  private readonly ttlMs: number
  private readonly refreshAfterMs: number
  private readonly maxEntries: number
  private readonly maxAddressesPerHostname: number
  private readonly entries = new Map<string, DnsCacheEntry>()
  private readonly inFlight = new Map<string, Promise<DnsCacheEntry>>()
  private closed = false

  readonly lookup: LookupFunction

  constructor(options: DnsLookupCacheOptions = {}) {
    this.resolver = options.resolver ?? createBoundedSystemIpv4Resolver()
    this.ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_DNS_TTL_MS, 'ttlMs')
    this.refreshAfterMs = positiveInteger(
      options.refreshAfterMs ?? DEFAULT_DNS_REFRESH_AFTER_MS,
      'refreshAfterMs',
    )
    this.maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_DNS_MAX_ENTRIES, 'maxEntries')
    this.maxAddressesPerHostname = positiveInteger(
      options.maxAddressesPerHostname ?? DEFAULT_DNS_MAX_ADDRESSES,
      'maxAddressesPerHostname',
    )
    if (this.refreshAfterMs >= this.ttlMs) {
      throw new Error('DNS refreshAfterMs 必须小于 ttlMs。')
    }
    this.lookup = ((
      hostname: string,
      rawOptions: LookupOptions | number,
      callback: (
        error: NodeJS.ErrnoException | null,
        address?: string | LookupAddress[],
        family?: number,
      ) => void,
    ): void => {
      const options = normalizeLookupOptions(rawOptions)
      void this.lookupAddresses(hostname, options.family).then(addresses => {
        if (options.all) {
          callback(null, addresses)
          return
        }
        const selected = addresses[0]
        if (!selected) {
          callback(noAddressError(hostname, options.family))
          return
        }
        callback(null, selected.address, selected.family)
      }, error => callback(nodeError(error)))
    }) as LookupFunction
  }

  async prime(hostname: string, family: DnsLookupFamily = 0): Promise<void> {
    const normalized = normalizeHostname(hostname)
    await this.entryFor(cacheKey(normalized, family), normalized, family)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const entry of this.entries.values()) {
      if (entry.refreshTimer) clearTimeout(entry.refreshTimer)
    }
    this.entries.clear()
  }

  private async lookupAddresses(hostname: string, family: number): Promise<LookupAddress[]> {
    const normalized = normalizeHostname(hostname)
    const normalizedFamily = dnsFamily(family)
    const key = cacheKey(normalized, normalizedFamily)
    const entry = await this.entryFor(key, normalized, normalizedFamily)
    const candidates = normalizedFamily === 4 || normalizedFamily === 6
      ? entry.addresses.filter(address => address.family === normalizedFamily)
      : entry.addresses
    if (!candidates.length) throw noAddressError(normalized, normalizedFamily)

    const start = entry.cursor % candidates.length
    entry.cursor = (entry.cursor + 1) % candidates.length
    this.touch(key, entry)
    return [...candidates.slice(start), ...candidates.slice(0, start)]
  }

  private entryFor(
    key: string,
    hostname: string,
    family: DnsLookupFamily,
  ): Promise<DnsCacheEntry> {
    if (this.closed) return Promise.reject(cacheClosedError())
    const cached = this.entries.get(key)
    if (cached && Date.now() < cached.expiresAt) {
      this.touch(key, cached)
      return Promise.resolve(cached)
    }
    const pending = this.inFlight.get(key)
    if (pending) return pending
    if (cached) this.deleteEntry(key, cached)
    return this.resolveAndStore(key, hostname, family)
  }

  private resolveAndStore(
    key: string,
    hostname: string,
    family: DnsLookupFamily,
  ): Promise<DnsCacheEntry> {
    const existing = this.inFlight.get(key)
    if (existing) return existing
    const pending = this.resolver(hostname, family).then(rawAddresses => {
      if (this.closed) throw cacheClosedError()
      const addresses = normalizeAddresses(rawAddresses, this.maxAddressesPerHostname)
      if (!addresses.length) throw noAddressError(hostname, 0)

      const previous = this.entries.get(key)
      if (previous?.refreshTimer) clearTimeout(previous.refreshTimer)
      const entry: DnsCacheEntry = {
        addresses,
        cursor: previous?.cursor ?? 0,
        expiresAt: Date.now() + effectiveDnsTtlMs(addresses, this.ttlMs),
        refreshTimer: null,
      }
      this.entries.delete(key)
      this.entries.set(key, entry)
      this.evictOverflow()
      const effectiveLifetime = entry.expiresAt - Date.now()
      this.scheduleRefresh(
        key,
        hostname,
        family,
        entry,
        Math.min(this.refreshAfterMs, Math.max(1, Math.floor(effectiveLifetime / 2))),
      )
      return entry
    })
    this.inFlight.set(key, pending)
    void pending.then(
      () => this.clearInFlight(key, pending),
      () => this.clearInFlight(key, pending),
    )
    return pending
  }

  private scheduleRefresh(
    key: string,
    hostname: string,
    family: DnsLookupFamily,
    entry: DnsCacheEntry,
    delayMs: number,
  ): void {
    if (this.closed || this.entries.get(key) !== entry) return
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer)
    const remainingLifetime = entry.expiresAt - Date.now()
    if (remainingLifetime <= 0) {
      this.deleteEntry(key, entry)
      return
    }
    entry.refreshTimer = setTimeout(() => {
      entry.refreshTimer = null
      // A failed refresh does not trigger another timer. The known addresses
      // remain usable only until their hard TTL; the next post-expiry lookup
      // performs one fresh resolution and receives its failure unchanged.
      void this.resolveAndStore(key, hostname, family).catch(() => undefined)
    }, Math.min(delayMs, remainingLifetime))
    entry.refreshTimer.unref()
  }

  private touch(key: string, entry: DnsCacheEntry): void {
    if (this.entries.get(key) !== entry) return
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value as [string, DnsCacheEntry] | undefined
      if (!oldest) return
      this.deleteEntry(oldest[0], oldest[1])
    }
  }

  private deleteEntry(key: string, entry: DnsCacheEntry): void {
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer)
    if (this.entries.get(key) === entry) this.entries.delete(key)
  }

  private clearInFlight(key: string, pending: Promise<DnsCacheEntry>): void {
    if (this.inFlight.get(key) === pending) this.inFlight.delete(key)
  }
}

export interface OpenAIProviderTransportOptions {
  dnsCache?: BoundedDnsLookupCache
  dispatcher?: Dispatcher
  fetchImplementation?: typeof globalThis.fetch
  dnsStrategy?: OpenAIDnsStrategy
}

export type OpenAIDnsStrategy = 'system' | 'bounded-ipv4' | 'guarded'

export interface OpenAIClientTransport {
  readonly fetch: typeof globalThis.fetch
  /** 等待连接建立前的 DNS 预热，避免首个用户请求承担冷解析延迟。 */
  warmup?(): Promise<void>
  close(): Promise<void>
}

/** One dispatcher and one DNS cache live for the complete provider lifetime. */
export class OpenAIProviderTransport implements OpenAIClientTransport {
  readonly fetch: typeof globalThis.fetch

  private readonly dnsCache: BoundedDnsLookupCache | null
  private readonly dispatcher: Dispatcher
  private readonly ownsDispatcher: boolean
  private initialPrime: Promise<void> | null
  private closePromise: Promise<void> | null = null

  constructor(baseUrl: string, options: OpenAIProviderTransportOptions = {}) {
    const origin = new URL(baseUrl)
    if (origin.protocol !== 'https:' && origin.protocol !== 'http:') {
      throw new Error(`OpenAI 兼容 transport 不支持协议 '${origin.protocol}'。`)
    }
    const dnsStrategy = selectOpenAIDnsStrategy(origin.hostname, options.dnsStrategy)
    if (dnsStrategy === 'guarded' && !options.dnsCache) {
      throw new Error('guarded OpenAI transport 必须提供受保护的 DNS resolver。')
    }
    this.dnsCache = dnsStrategy === 'system'
      ? null
      : options.dnsCache ?? new BoundedDnsLookupCache()
    this.ownsDispatcher = !options.dispatcher
    this.dispatcher = options.dispatcher ?? new Agent({
      maxOrigins: 4,
      connections: 4,
      pipelining: 1,
      clientTtl: 300_000,
      connect: {
        ...(this.dnsCache ? {
          lookup: this.dnsCache.lookup,
          ...(dnsStrategy === 'bounded-ipv4' ? { family: 4 as const } : {}),
        } : {}),
        timeout: 15_000,
        keepAlive: true,
        keepAliveInitialDelay: 1_000,
      },
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 120_000,
    })

    const requestFetch = options.fetchImplementation
      ?? dispatchingFetch(bindDispatcherToOrigin(this.dispatcher, origin.origin))
    if (this.dnsCache) {
      const prime = this.dnsCache.prime(origin.hostname, dnsStrategy === 'bounded-ipv4' ? 4 : 0)
      // The rejected promise remains intact for the first provider request. This
      // observer only prevents an unhandled-rejection race before that request.
      void prime.catch(() => undefined)
      this.initialPrime = prime
    } else {
      this.initialPrime = null
    }
    this.fetch = async (input, init) => {
      await this.warmup()
      assertInitialProviderOrigin(input, origin.origin)
      return requestFetch(input, init)
    }
  }

  async warmup(): Promise<void> {
    const initialPrime = this.initialPrime
    if (!initialPrime) return
    try {
      await initialPrime
    } finally {
      if (this.initialPrime === initialPrime) this.initialPrime = null
    }
  }

  async close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.dnsCache?.close()
      if (this.ownsDispatcher) await this.dispatcher.close()
    })()
    await this.closePromise
  }
}

class ProviderOriginViolationError extends Error {
  override readonly name = 'ProviderOriginViolationError'
}

/**
 * Undici dispatches every redirect hop through the same dispatcher before it
 * opens a socket. Binding the dispatcher to the verified origin therefore
 * keeps native streaming and redirect replay without pre-buffering the body.
 */
function bindDispatcherToOrigin(
  dispatcher: Dispatcher,
  verifiedOrigin: string,
): Dispatcher {
  return dispatcher.compose(dispatch => (options, handler) => {
    let requestedOrigin: string
    try {
      if (!options.origin) throw new Error('missing origin')
      requestedOrigin = new URL(options.origin).origin
    } catch {
      throw new ProviderOriginViolationError('OpenAI 兼容 transport 拒绝缺失或无效的请求来源。')
    }
    if (requestedOrigin !== verifiedOrigin) {
      throw new ProviderOriginViolationError(
        `OpenAI 兼容 transport 拒绝跨来源重定向：`
        + `'${verifiedOrigin}' -> '${requestedOrigin}'。`,
      )
    }
    return dispatch(options, handler)
  })
}

function assertInitialProviderOrigin(
  input: Parameters<typeof globalThis.fetch>[0],
  verifiedOrigin: string,
): void {
  const requestedOrigin = new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url,
  ).origin
  if (requestedOrigin !== verifiedOrigin) {
    throw new ProviderOriginViolationError(
      `OpenAI 兼容 transport 拒绝访问未验证来源 '${requestedOrigin}'；`
      + `已验证来源为 '${verifiedOrigin}'。`,
    )
  }
}

export function selectOpenAIDnsStrategy(
  hostname: string,
  requested?: OpenAIDnsStrategy,
): OpenAIDnsStrategy {
  if (requested) return requested
  return normalizeHostname(hostname) === 'api.deepseek.com' ? 'bounded-ipv4' : 'system'
}

function dispatchingFetch(dispatcher: Dispatcher): typeof globalThis.fetch {
  return async (input, init) => {
    try {
      return await undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        { ...init, dispatcher } as Parameters<typeof undiciFetch>[1],
      ) as unknown as Response
    } catch (error) {
      const violation = findProviderOriginViolation(error)
      if (violation) throw violation
      throw error
    }
  }
}

function findProviderOriginViolation(error: unknown): ProviderOriginViolationError | null {
  const visited = new Set<unknown>()
  let current = error
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof ProviderOriginViolationError) return current
    visited.add(current)
    current = current.cause
  }
  return null
}

/**
 * Resolve A records with a short, bounded c-ares timeout while preserving the
 * user's current OS-configured name-server order. A fresh Resolver is created
 * for every cache miss/refresh so network configuration changes are observed.
 */
export function createBoundedSystemIpv4Resolver(
  dependencies: SystemIpv4ResolverDependencies = {},
): DnsAddressResolver {
  const readServers = dependencies.getServers ?? getSystemDnsServers
  const createResolver = dependencies.createResolver
    ?? ((options: ResolverOptions): Ipv4Resolver => new Resolver(options))

  return async hostname => {
    const resolver = createResolver({ timeout: 500, tries: 1 })
    resolver.setServers(readServers())
    return await new Promise<DnsResolvedAddress[]>((resolve, reject) => {
      resolver.resolve4(hostname, { ttl: true }, (error, records) => {
        if (error) {
          reject(error)
          return
        }
        resolve(records.map(record => ({
          address: record.address,
          family: 4,
          ttl: record.ttl,
        })))
      })
    })
  }
}

function normalizeAddresses(
  addresses: readonly DnsResolvedAddress[],
  limit: number,
): DnsResolvedAddress[] {
  const unique = new Map<string, DnsResolvedAddress>()
  for (const candidate of addresses) {
    const family = candidate.family === 6 ? 6 : candidate.family === 4 ? 4 : isIP(candidate.address)
    if (family !== 4 && family !== 6) continue
    const key = `${family}:${candidate.address}`
    const ttl = Number.isFinite(candidate.ttl) && Number(candidate.ttl) >= 0
      ? Math.floor(Number(candidate.ttl))
      : undefined
    if (!unique.has(key)) {
      unique.set(key, {
        address: candidate.address,
        family,
        ...(ttl === undefined ? {} : { ttl }),
      })
    }
    if (unique.size >= limit) break
  }
  return [...unique.values()]
}

function effectiveDnsTtlMs(addresses: readonly DnsResolvedAddress[], configuredTtlMs: number): number {
  let effectiveTtlMs = configuredTtlMs
  for (const address of addresses) {
    if (!Number.isFinite(address.ttl) || Number(address.ttl) < 0) continue
    effectiveTtlMs = Math.min(effectiveTtlMs, Number(address.ttl) * 1_000)
  }
  return effectiveTtlMs
}

function normalizeLookupOptions(options: LookupOptions | number): { all: boolean; family: number } {
  if (typeof options === 'number') return { all: false, family: options }
  const family = typeof options.family === 'number'
    ? options.family
    : options.family === 'IPv4'
      ? 4
      : options.family === 'IPv6'
        ? 6
        : 0
  return { all: 'all' in options && options.all === true, family }
}

function dnsFamily(value: number): DnsLookupFamily {
  return value === 4 || value === 6 ? value : 0
}

function cacheKey(hostname: string, family: DnsLookupFamily): string {
  return `${family}:${hostname}`
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/u, '')
  if (!normalized) throw Object.assign(new Error('DNS hostname 不能为空。'), { code: 'EINVAL' })
  return normalized
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`DNS ${label} 必须为正整数。`)
  return value
}

function noAddressError(hostname: string, family: number): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`DNS 没有为 '${hostname}' 返回${family === 4 || family === 6 ? ` IPv${family}` : ''}地址。`),
    { code: 'ENOTFOUND', hostname },
  )
}

function cacheClosedError(): NodeJS.ErrnoException {
  return Object.assign(new Error('DNS cache 已关闭。'), { code: 'UND_ERR_CLOSED' })
}

function nodeError(value: unknown): NodeJS.ErrnoException {
  return errorValue(value) as NodeJS.ErrnoException
}

function errorValue(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

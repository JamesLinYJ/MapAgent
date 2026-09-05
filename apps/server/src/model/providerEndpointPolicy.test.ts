import { describe, expect, it, vi } from 'vitest'

import {
  assertCustomProviderBaseUrl,
  createProviderDnsResolver,
} from './providerEndpointPolicy.js'

describe('custom Provider endpoint policy', () => {
  it('accepts HTTP and HTTPS addresses without restricting the destination network', () => {
    expect(assertCustomProviderBaseUrl('http://api.example.org/v1').protocol).toBe('http:')
    expect(assertCustomProviderBaseUrl('http://192.168.1.10:8000/v1').hostname).toBe('192.168.1.10')
    expect(assertCustomProviderBaseUrl('https://127.0.0.1/v1').hostname).toBe('127.0.0.1')
    expect(assertCustomProviderBaseUrl('http://169.254.169.254/latest').hostname).toBe('169.254.169.254')
    expect(assertCustomProviderBaseUrl('https://api.provider.com/v1').hostname).toBe('api.provider.com')
  })

  it('keeps only URL-shape restrictions needed by the compatible client', () => {
    expect(() => assertCustomProviderBaseUrl('ftp://api.provider.com/v1')).toThrow('不支持协议')
    expect(() => assertCustomProviderBaseUrl('https://user:secret@api.provider.com/v1')).toThrow('用户凭据')
    expect(() => assertCustomProviderBaseUrl('https://api.provider.com/v1?key=value')).toThrow('查询参数')
    expect(() => assertCustomProviderBaseUrl('https://api.provider.com/v1#section')).toThrow('片段')
  })

  it('returns every resolved address, including private, loopback, and proxy addresses', async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
      { address: '198.18.2.163', family: 4 },
    ])
    const resolver = createProviderDnsResolver({ lookup: lookup as never })

    await expect(resolver('api.provider.com', 0)).resolves.toEqual([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
      { address: '198.18.2.163', family: 4 },
    ])
  })

  it('accepts DNS changes and literal addresses without applying a range policy', async () => {
    const lookup = vi.fn()
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.8', family: 4 }])
    const resolver = createProviderDnsResolver({ lookup: lookup as never })

    await expect(resolver('api.provider.com', 0)).resolves.toEqual([{ address: '8.8.8.8', family: 4 }])
    await expect(resolver('api.provider.com', 0)).resolves.toEqual([{ address: '10.0.0.8', family: 4 }])
    await expect(resolver('192.168.1.25', 0)).resolves.toEqual([{ address: '192.168.1.25', family: 4 }])
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('reports a hostname that resolves to no address', async () => {
    const resolver = createProviderDnsResolver({
      lookup: vi.fn().mockResolvedValue([]) as never,
    })

    await expect(resolver('empty.provider.test', 0)).rejects.toThrow('没有可用地址')
  })
})

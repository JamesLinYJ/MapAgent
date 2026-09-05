import { describe, expect, it } from 'vitest'

import { clientIp, SlidingWindowRateLimiter } from './rateLimiter.js'

describe('rate limiter boundaries', () => {
  it('uses the transport peer address instead of spoofable forwarding headers', () => {
    const request = new Request('http://api.example.test/api/v1/data', {
      headers: {
        'x-forwarded-for': '198.51.100.10',
        'x-real-ip': '198.51.100.11',
      },
    })

    expect(clientIp(request, { remoteAddress: '127.0.0.1' })).toBe('127.0.0.1')
    expect(clientIp(request)).toBe('unknown')
  })

  it('keeps the local sliding-window behavior explicit and bounded', () => {
    const limiter = new SlidingWindowRateLimiter(2, 60_000)

    expect(limiter.consume('client')).toBe(true)
    expect(limiter.consume('client')).toBe(true)
    expect(limiter.consume('client')).toBe(false)
    expect(limiter.remaining('client')).toBe(0)
  })
})

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 应用实例锁测试
//
//   文件:       applicationInstanceLock.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import { PLATFORM_MACHINE_ID } from '@geo-agent-platform/shared-types/product-identity'

import type { Database } from './connection.js'
import {
  ApplicationInstanceLock,
  ApplicationInstanceLockedError,
} from './applicationInstanceLock.js'

describe('ApplicationInstanceLock', () => {
  it('holds a dedicated PostgreSQL connection until explicit release', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const release = vi.fn()
    const client = { query, release, on: vi.fn() }
    const db = { pool: { connect: vi.fn().mockResolvedValue(client) } } as unknown as Database
    const lock = new ApplicationInstanceLock(db)

    await lock.acquire()

    expect(lock.isHeld()).toBe(true)
    expect(query).toHaveBeenCalledWith("SET lock_timeout = '15000ms'")
    expect(query).toHaveBeenCalledWith(
      'SELECT pg_advisory_lock(hashtext($1), hashtext($2))',
      [PLATFORM_MACHINE_ID, 'api-single-writer-v1'],
    )
    expect(release).not.toHaveBeenCalled()

    await lock.release()

    expect(lock.isHeld()).toBe(false)
    expect(query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock(hashtext($1), hashtext($2))',
      [PLATFORM_MACHINE_ID, 'api-single-writer-v1'],
    )
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('maps PostgreSQL lock timeout to a stable single-instance error', async () => {
    const release = vi.fn()
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('lock timeout'), { code: '55P03' }))
    const db = {
      pool: { connect: vi.fn().mockResolvedValue({ query, release, on: vi.fn() }) },
    } as unknown as Database
    const lock = new ApplicationInstanceLock(db, 50)

    await expect(lock.acquire()).rejects.toBeInstanceOf(ApplicationInstanceLockedError)
    expect(lock.isHeld()).toBe(false)
    expect(release).toHaveBeenCalledTimes(1)
  })
})

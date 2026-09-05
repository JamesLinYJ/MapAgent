// +-------------------------------------------------------------------------
//
//   地理智能平台 - 应用实例数据库锁
//
//   文件:       applicationInstanceLock.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { PoolClient } from 'pg'
import { PLATFORM_MACHINE_ID } from '@geo-agent-platform/shared-types/product-identity'

import { errorLogPayload, logger } from '../observability/logger.js'
import { applicationInstanceLockHeld } from '../observability/metrics.js'
import type { Database } from './connection.js'

const LOCK_NAMESPACE = PLATFORM_MACHINE_ID
const LOCK_RESOURCE = 'api-single-writer-v1'

export class ApplicationInstanceLockedError extends Error {
  constructor() {
    super('平台 API 已有一个实例持有平台写锁。请先停止该实例，再重新启动。')
    this.name = 'ApplicationInstanceLockedError'
  }
}

// PostgreSQL session advisory lock 是平台单写实例的事实源。连接异常终止时
// 数据库会自动释放锁，因此不会留下需要人工删除的 stale 文件锁。
export class ApplicationInstanceLock {
  private client: PoolClient | null = null

  constructor(
    private readonly db: Database,
    private readonly acquireTimeoutMs = 15_000,
  ) {}

  async acquire(): Promise<void> {
    if (this.client) return
    const client = await this.db.pool.connect()
    try {
      await client.query(`SET lock_timeout = '${this.acquireTimeoutMs}ms'`)
      await client.query(
        'SELECT pg_advisory_lock(hashtext($1), hashtext($2))',
        [LOCK_NAMESPACE, LOCK_RESOURCE],
      )
      client.on('error', error => {
        this.client = null
        applicationInstanceLockHeld.set(0)
        logger.fatal({ error: errorLogPayload(error) }, 'application instance lock connection lost')
      })
      this.client = client
      applicationInstanceLockHeld.set(1)
    } catch (error) {
      client.release()
      if (isLockTimeout(error)) throw new ApplicationInstanceLockedError()
      throw error
    }
  }

  async release(): Promise<void> {
    const client = this.client
    if (!client) return
    this.client = null
    try {
      await client.query(
        'SELECT pg_advisory_unlock(hashtext($1), hashtext($2))',
        [LOCK_NAMESPACE, LOCK_RESOURCE],
      )
    } finally {
      client.release()
      applicationInstanceLockHeld.set(0)
    }
  }

  isHeld(): boolean {
    return this.client !== null
  }
}

function isLockTimeout(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '55P03'
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostGIS 健康探针
//
//   文件:       postGisHealthProbe.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { sql } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { errorLogPayload, logger } from '../../observability/logger.js'

export interface PostGisHealthStatus {
  available: boolean
  error: string | null
}

/** 只检查 PostGIS 扩展可用性，不承担图层业务查询。 */
export class PostGisHealthProbe {
  constructor(private readonly db: Database) {}

  async status(): Promise<PostGisHealthStatus> {
    try {
      // PostGIS 扩展函数是健康检查允许使用的原生 SQL。
      const result = await this.db.execute(sql`SELECT PostGIS_Version() AS version`)
      return result.rows[0]?.version
        ? { available: true, error: null }
        : { available: false, error: 'PostGIS 扩展未返回版本信息' }
    } catch (error) {
      logger.warn({ error: errorLogPayload(error) }, 'postgis extension probe failed')
      return { available: false, error: 'PostGIS 扩展不可用' }
    }
  }
}

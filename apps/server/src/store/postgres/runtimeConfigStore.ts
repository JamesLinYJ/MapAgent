// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行时配置存储
//
//   文件:       runtimeConfigStore.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { and, eq } from 'drizzle-orm'
import type { Database } from '../../db/connection.js'
import { platformRuntimeConfig } from '../../db/schema.js'
import { decodeRequiredRecord } from '../../db/valueDecoders.js'
import { StoreVersionConflictError } from '../storeErrors.js'

export interface StoredRuntimeConfigDocument {
  config: Record<string, unknown>
  revision: number
  updatedAt: string
}

// 运行时配置是平台控制面资源。这里仅负责持久化，不决定权限；
// 权限在 HTTP/WS 控制面通过 AuthorizationService 统一判断。
export class RuntimeConfigStore {
  constructor(private readonly db: Database) {}

  async getRuntimeConfig(configKey: string): Promise<StoredRuntimeConfigDocument | null> {
    const rows = await this.db
      .select({
        payloadJson: platformRuntimeConfig.payloadJson,
        revision: platformRuntimeConfig.revision,
        updatedAt: platformRuntimeConfig.updatedAt,
      })
      .from(platformRuntimeConfig)
      .where(eq(platformRuntimeConfig.configKey, configKey))
      .limit(1)
    const row = rows[0]
    return row ? {
      config: decodeRequiredRecord(row.payloadJson, 'platform_runtime_config.payload_json'),
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
    } : null
  }

  async upsertRuntimeConfig(
    configKey: string,
    payload: Record<string, unknown>,
    expectedRevision: number,
  ): Promise<StoredRuntimeConfigDocument> {
    const updatedAt = new Date()
    const rows = expectedRevision === 0
      ? await this.db.insert(platformRuntimeConfig).values({
        configKey,
        revision: 1,
        updatedAt,
        payloadJson: payload,
      }).onConflictDoNothing({ target: platformRuntimeConfig.configKey }).returning()
      : await this.db.update(platformRuntimeConfig).set({
        revision: expectedRevision + 1,
        updatedAt,
        payloadJson: payload,
      }).where(and(
        eq(platformRuntimeConfig.configKey, configKey),
        eq(platformRuntimeConfig.revision, expectedRevision),
      )).returning()
    const saved = rows[0]
    if (!saved) {
      const current = await this.getRuntimeConfig(configKey)
      throw new StoreVersionConflictError(
        `运行配置 '${configKey}'`,
        expectedRevision,
        current?.revision ?? null,
      )
    }
    return {
      config: decodeRequiredRecord(saved.payloadJson, 'platform_runtime_config.payload_json'),
      revision: saved.revision,
      updatedAt: saved.updatedAt.toISOString(),
    }
  }
}

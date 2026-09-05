// +-------------------------------------------------------------------------
//
//   地理智能平台 - 自定义模型 Provider 存储
//
//   文件:       customProviderStore.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, asc, eq } from 'drizzle-orm'
import {
  customProviderConfigSchema,
  type CustomProviderConfig,
} from '@geo-agent-platform/shared-types'

import type { Database } from '../../db/connection.js'
import { platformModelProviders } from '../../db/schema.js'
import { StoreVersionConflictError } from '../storeErrors.js'

type CustomProviderRow = typeof platformModelProviders.$inferSelect

export interface StoredCustomProvider extends CustomProviderConfig {
  revision: number
  credential: string | null
  createdByUserId: string
  lastValidatedAt: string | null
  createdAt: string
  updatedAt: string
}

export class CustomProviderStore {
  constructor(private readonly db: Database) {}

  async list(): Promise<StoredCustomProvider[]> {
    const rows = await this.db
      .select()
      .from(platformModelProviders)
      .orderBy(asc(platformModelProviders.providerId))
    return rows.map(mapRow)
  }

  async get(providerId: string): Promise<StoredCustomProvider | null> {
    const rows = await this.db
      .select()
      .from(platformModelProviders)
      .where(eq(platformModelProviders.providerId, providerId))
      .limit(1)
    return rows[0] ? mapRow(rows[0]) : null
  }

  async upsert(
    record: Omit<StoredCustomProvider, 'revision' | 'createdAt' | 'updatedAt'>,
    expectedRevision: number | null,
  ): Promise<StoredCustomProvider> {
    const now = new Date()
    const values = {
        providerId: record.providerId,
        revision: 1,
        displayName: record.displayName,
        baseUrl: record.baseUrl,
        protocol: record.protocol,
        modelsJson: record.models,
        defaultModel: record.defaultModel,
        toolSchemaMode: record.toolSchemaMode,
        apiKey: record.credential,
        createdByUserId: record.createdByUserId,
        lastValidatedAt: record.lastValidatedAt ? new Date(record.lastValidatedAt) : null,
        createdAt: now,
        updatedAt: now,
    } satisfies typeof platformModelProviders.$inferInsert
    const rows = expectedRevision === null
      ? await this.db.insert(platformModelProviders)
        .values(values)
        .onConflictDoNothing({ target: platformModelProviders.providerId })
        .returning()
      : await this.db.update(platformModelProviders).set({
        revision: expectedRevision + 1,
        displayName: record.displayName,
        baseUrl: record.baseUrl,
        protocol: record.protocol,
        modelsJson: record.models,
        defaultModel: record.defaultModel,
        toolSchemaMode: record.toolSchemaMode,
        apiKey: record.credential,
        lastValidatedAt: record.lastValidatedAt ? new Date(record.lastValidatedAt) : null,
        updatedAt: now,
      }).where(and(
        eq(platformModelProviders.providerId, record.providerId),
        eq(platformModelProviders.revision, expectedRevision),
      )).returning()
    const saved = rows[0]
    if (!saved) {
      const current = await this.get(record.providerId)
      throw new StoreVersionConflictError(
        `模型服务 '${record.providerId}'`,
        expectedRevision,
        current?.revision ?? null,
      )
    }
    return mapRow(saved)
  }

  async delete(providerId: string, expectedRevision: number): Promise<boolean> {
    const rows = await this.db
      .delete(platformModelProviders)
      .where(and(
        eq(platformModelProviders.providerId, providerId),
        eq(platformModelProviders.revision, expectedRevision),
      ))
      .returning({ providerId: platformModelProviders.providerId })
    if (!rows.length) {
      const current = await this.get(providerId)
      if (current) {
        throw new StoreVersionConflictError(
          `模型服务 '${providerId}'`,
          expectedRevision,
          current.revision,
        )
      }
    }
    return rows.length > 0
  }
}

function mapRow(row: CustomProviderRow): StoredCustomProvider {
  const config = customProviderConfigSchema.parse({
    providerId: row.providerId,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    protocol: row.protocol,
    models: row.modelsJson,
    defaultModel: row.defaultModel,
    toolSchemaMode: row.toolSchemaMode,
  })
  return {
    ...config,
    revision: row.revision,
    credential: row.apiKey,
    createdByUserId: row.createdByUserId,
    lastValidatedAt: row.lastValidatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

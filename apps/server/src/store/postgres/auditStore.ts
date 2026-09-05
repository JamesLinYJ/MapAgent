// +-------------------------------------------------------------------------
//
//   地理智能平台 - 审计事件存储
//
//   文件:       auditStore.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { auditEventSchema, type AuditEvent } from '@geo-agent-platform/shared-types/platform'
import { desc } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { decodeRequiredRecord } from '../../db/valueDecoders.js'
import { platformAuditEvents } from '../../db/schema.js'
import { makeId } from '../../utils/ids.js'

export interface AuditEventInput {
  actorUserId: string | null
  workspaceId: string | null
  action: string
  objectType: string
  objectId: string | null
  outcome: 'allowed' | 'denied' | 'error'
  metadata: Record<string, unknown>
}

export class AuditStore {
  constructor(private readonly db: Database) {}

  async recordEvent(input: AuditEventInput): Promise<void> {
    await this.db.insert(platformAuditEvents).values({
      auditEventId: makeId('audit'),
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      outcome: input.outcome,
      metadataJson: input.metadata,
      createdAt: new Date(),
    })
  }

  async listRecent(limit = 500): Promise<AuditEvent[]> {
    const safeLimit = Math.min(1_000, Math.max(1, Math.trunc(limit)))
    const rows = await this.db.select().from(platformAuditEvents)
      .orderBy(desc(platformAuditEvents.createdAt))
      .limit(safeLimit)
    return rows.map(row => auditEventSchema.parse({
      auditEventId: row.auditEventId,
      actorUserId: row.actorUserId,
      workspaceId: row.workspaceId,
      action: row.action,
      objectType: row.objectType,
      objectId: row.objectId,
      outcome: row.outcome,
      metadata: decodeRequiredRecord(row.metadataJson, 'platform_audit_events.metadata_json'),
      createdAt: row.createdAt.toISOString(),
    }))
  }
}

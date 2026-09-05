// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话资源持久化
//
//   文件:       sessionRepository.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { SessionRecord } from '../../schemas/types.js'
import type { Database } from '../../db/connection.js'
import { platformSessions } from '../../db/schema.js'
import type { SessionRepository } from './conversationPersistencePorts.js'

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly db: Database) {}

  async saveSession(session: SessionRecord): Promise<void> {
    const values = {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      createdByUserId: session.createdByUserId,
      visibility: session.visibility,
      status: session.status,
      latestThreadId: session.latestThreadId,
      latestRunId: session.latestRunId,
      latestUploadedLayerKey: session.latestUploadedLayerKey,
      latestMeteorologicalDatasetId: session.latestMeteorologicalDatasetId,
      createdAt: new Date(session.createdAt),
      updatedAt: new Date(),
    }
    await this.db.insert(platformSessions).values(values).onConflictDoUpdate({
      target: platformSessions.sessionId,
      set: { ...values, sessionId: undefined },
    })
  }
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话资源存储
//
//   文件:       sessionStore.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { SessionRecord } from '../schemas/types.js'
import { makeId, nowUtc } from '../utils/ids.js'
import type { ConversationProjectionIndex } from './conversationProjectionIndex.js'
import type { SessionRepository } from './postgres/conversationPersistencePorts.js'

export interface ResourceOwner {
  workspaceId: string
  userId: string
}

export const DEFAULT_SESSION_ID = '__default__'

// SessionStore 只拥有 session manifest 的创建、读取和更新。线程/运行的
// 投影更新由对应 resource store 调用这里完成，避免 facade 继续承载会话规则。
export class SessionStore {
  constructor(
    private readonly index: ConversationProjectionIndex,
    private readonly repository: SessionRepository,
  ) {}

  values(): IterableIterator<SessionRecord> {
    return this.index.sessionValues()
  }

  async create(owner?: ResourceOwner | null): Promise<SessionRecord> {
    const session = this.createRecord(makeId('session'), owner ?? null)
    await this.persist(session)
    return session
  }

  async getOrCreateUserDefault(owner: ResourceOwner): Promise<SessionRecord> {
    const sessionId = `session_${owner.workspaceId}_${owner.userId}`.replace(/[^A-Za-z0-9_]+/gu, '_')
    try {
      return this.get(sessionId)
    } catch {
      const session = this.createRecord(sessionId, owner)
      await this.persist(session)
      return session
    }
  }

  async getOrCreateDefault(): Promise<SessionRecord> {
    try {
      return this.get(DEFAULT_SESSION_ID)
    } catch {
      const session = this.createRecord(DEFAULT_SESSION_ID, null)
      await this.persist(session)
      return session
    }
  }

  get(sessionId: string): SessionRecord {
    return this.index.getSession(sessionId)
  }

  async update(sessionId: string, fields: Partial<SessionRecord>): Promise<SessionRecord> {
    const next = { ...this.get(sessionId), ...fields }
    await this.persist(next)
    return next
  }

  acceptPersisted(session: SessionRecord): void {
    this.index.setSession(session)
  }

  private async persist(session: SessionRecord): Promise<void> {
    await this.repository.saveSession(session)
    this.index.setSession(session)
  }

  private createRecord(sessionId: string, owner: ResourceOwner | null): SessionRecord {
    return {
      id: sessionId,
      createdAt: nowUtc(),
      status: 'active',
      workspaceId: owner?.workspaceId ?? null,
      createdByUserId: owner?.userId ?? null,
      visibility: 'workspace',
      latestThreadId: null,
      latestRunId: null,
      latestUploadedLayerKey: null,
      latestMeteorologicalDatasetId: null,
    }
  }
}

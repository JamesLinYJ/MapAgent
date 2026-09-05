// +-------------------------------------------------------------------------
//
//   地理智能平台 - Better Auth 会话仓储
//
//   文件:       authSessionRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//   来源:       platformIdentityStore.ts 的认证会话资源边界
// --------------------------------------------------------------------------

import { eq } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { authSession } from '../../db/schema.js'

export interface AuthSessionRecord {
  authUserId: string
  expiresAt: Date
}

/** Better Auth 会话记录的读取与撤销边界，不承载平台用户策略。 */
export class AuthSessionRepository {
  constructor(private readonly db: Database) {}

  async get(authSessionId: string): Promise<AuthSessionRecord | null> {
    const rows = await this.db.select({
      authUserId: authSession.userId,
      expiresAt: authSession.expiresAt,
    }).from(authSession)
      .where(eq(authSession.id, authSessionId))
      .limit(1)
    return rows[0] ?? null
  }

  async revokeByAuthUserId(authUserId: string): Promise<void> {
    await this.db.delete(authSession).where(eq(authSession.userId, authUserId))
  }
}

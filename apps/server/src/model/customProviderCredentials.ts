// +-------------------------------------------------------------------------
//
//   地理智能平台 - 自定义 Provider 临时凭据边界
//
//   文件:       customProviderCredentials.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'

import type { AuthContext } from '../security/types.js'

const HANDLE_TTL_MS = 5 * 60 * 1_000
const MAX_STAGED_CREDENTIALS = 128

interface StagedCredential {
  secret: string
  userId: string
  authSessionId: string
  expiresAtMs: number
}

export class ProviderCredentialStagingService {
  private readonly staged = new Map<string, StagedCredential>()

  stage(secret: string, auth: AuthContext, nowMs = Date.now()): { credentialHandle: string; expiresAt: string } {
    if (!secret.trim()) throw new Error('Provider 凭据不能为空。')
    this.prune(nowMs)
    while (this.staged.size >= MAX_STAGED_CREDENTIALS) {
      const oldest = this.staged.keys().next().value as string | undefined
      if (!oldest) break
      this.staged.delete(oldest)
    }
    const credentialHandle = `provider_credential_${randomUUID()}`
    const expiresAtMs = nowMs + HANDLE_TTL_MS
    this.staged.set(credentialHandle, {
      secret,
      userId: auth.userId,
      authSessionId: auth.authSessionId,
      expiresAtMs,
    })
    return { credentialHandle, expiresAt: new Date(expiresAtMs).toISOString() }
  }

  resolve(credentialHandle: string, auth: AuthContext, nowMs = Date.now()): string {
    this.prune(nowMs)
    const staged = this.staged.get(credentialHandle)
    if (!staged) throw new Error('Provider 凭据句柄不存在或已经过期，请重新输入。')
    if (staged.userId !== auth.userId || staged.authSessionId !== auth.authSessionId) {
      throw new Error('Provider 凭据句柄不属于当前登录会话。')
    }
    return staged.secret
  }

  consume(credentialHandle: string, auth: AuthContext, nowMs = Date.now()): void {
    this.resolve(credentialHandle, auth, nowMs)
    this.staged.delete(credentialHandle)
  }

  private prune(nowMs: number): void {
    for (const [handle, staged] of this.staged) {
      if (staged.expiresAtMs <= nowMs) this.staged.delete(handle)
    }
  }
}

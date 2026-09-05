// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 麦克风一次性授权 Gate
//
//   文件:       microphonePermissionGate.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

const DEFAULT_GRANT_TTL_MS = 60_000

/**
 * 每次原生确认只授权当前 WebContents 的下一次有效 audio 请求。检查阶段只读，
 * 实际 permission request 才消费；窗口销毁和超时都会使授权失效。
 */
export class MicrophonePermissionGate {
  private readonly grants = new Map<number, number>()
  private readonly observedOwners = new Set<number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly grantTtlMs = DEFAULT_GRANT_TTL_MS,
  ) {
    if (!Number.isInteger(grantTtlMs) || grantTtlMs <= 0) {
      throw new Error('麦克风授权有效期必须是正整数毫秒。')
    }
  }

  /**
   * 返回 true 表示调用方应安装一次窗口 destroyed 监听。
   */
  grant(ownerWebContentsId: number): boolean {
    requireOwnerId(ownerWebContentsId)
    this.grants.set(ownerWebContentsId, this.now() + this.grantTtlMs)
    if (this.observedOwners.has(ownerWebContentsId)) return false
    this.observedOwners.add(ownerWebContentsId)
    return true
  }

  hasActiveGrant(ownerWebContentsId: number): boolean {
    requireOwnerId(ownerWebContentsId)
    const expiresAt = this.grants.get(ownerWebContentsId)
    if (expiresAt === undefined) return false
    if (expiresAt <= this.now()) {
      this.grants.delete(ownerWebContentsId)
      return false
    }
    return true
  }

  consume(ownerWebContentsId: number): boolean {
    if (!this.hasActiveGrant(ownerWebContentsId)) return false
    this.grants.delete(ownerWebContentsId)
    return true
  }

  revoke(ownerWebContentsId: number): void {
    requireOwnerId(ownerWebContentsId)
    this.grants.delete(ownerWebContentsId)
  }

  revokeAll(): void {
    this.grants.clear()
  }

  releaseOwner(ownerWebContentsId: number): void {
    requireOwnerId(ownerWebContentsId)
    this.grants.delete(ownerWebContentsId)
    this.observedOwners.delete(ownerWebContentsId)
  }
}

function requireOwnerId(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('麦克风授权必须绑定有效的 WebContents。')
  }
}

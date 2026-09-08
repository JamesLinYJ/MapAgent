// +-------------------------------------------------------------------------
//   地理智能平台 - 实时推送的当前身份与资源授权
//   文件: deliveryAuthorization.ts
//   日期: 2026年09月08日
//   AI 协助: OpenAI ChatGPT (GPT-6 Astra Pro)
// --------------------------------------------------------------------------

import type { AuthContext, AuthRoleBinding } from '../security/types.js'
import type { WsDeliveryScope } from './WsOutboundGuard.js'

export interface WsDeliverySecurity {
  auth: {
    isAuthContextActive(auth: AuthContext): Promise<boolean>
    listUserRoles(userId: string): Promise<AuthRoleBinding[]>
  }
  authorization: {
    can(auth: AuthContext, object: 'run' | 'thread', action: 'read',
      scope: { workspaceId: string; resourceId: string }): Promise<boolean>
  }
}

export interface WsDeliveryResources {
  getRun(id: string): { workspaceId?: string | null }
  getThread(id: string): { workspaceId?: string | null }
}

export function wsAuthNotExpired(auth: AuthContext | undefined, now = Date.now()): boolean {
  if (!auth) return false
  if (auth.authSessionExpiresAt === null) return true
  const expiry = Date.parse(auth.authSessionExpiresAt)
  return Number.isFinite(expiry) && expiry > now
}

export function createWsDeliveryAuthorizer(
  auth: AuthContext | undefined,
  security: WsDeliverySecurity,
  resources: WsDeliveryResources,
): (scopes: readonly WsDeliveryScope[]) => Promise<boolean> {
  return async scopes => {
    if (!auth || !wsAuthNotExpired(auth)) return false
    const roles = await security.auth.listUserRoles(auth.userId)
    if (!roles.length) return false
    const currentAuth = { ...auth, roles }
    const checked = new Set<string>()
    for (const scope of scopes) {
      const key = `${scope.object}:${scope.resourceId}`
      if (checked.has(key)) continue
      checked.add(key)
      const resource = scope.object === 'run'
        ? resources.getRun(scope.resourceId)
        : resources.getThread(scope.resourceId)
      if (!resource.workspaceId) return false
      // 推送不是新的用户操作：使用无审计副作用的 can，避免每个流式
      // 文本片段都写入一条审计记录；角色和资源归属均从当前事实读取。
      if (!await security.authorization.can(currentAuth, scope.object, 'read', {
        workspaceId: resource.workspaceId,
        resourceId: scope.resourceId,
      })) return false
    }
    return wsAuthNotExpired(auth) && await security.auth.isAuthContextActive(auth)
  }
}

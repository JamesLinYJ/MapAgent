// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 出站授权策略
//
//   文件:       deliveryAuthorization.ts
//   日期:       2026年09月08日
//   协助:       OpenAI ChatGPT
// --------------------------------------------------------------------------

import { AuthorizationError } from '../security/authorizationService.js'
import type { SecurityServices } from '../security/routes.js'
import type { AuthContext } from '../security/types.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import type { WsDeliveryAuthorize } from './WsDeliveryGate.js'

/** 推送没有入站命令可触发重新鉴权，因此必须在实际交付时重新读取会话与角色。 */
export function createWsDeliveryAuthorizer(input: {
  auth: AuthContext | null
  security: SecurityServices
  store: Pick<PlatformPersistenceFacade, 'getRun' | 'getThread'>
}): WsDeliveryAuthorize {
  return async scopes => {
    const { auth, security, store } = input
    if (!auth || !(await security.auth.isAuthContextActive(auth))) {
      throw new AuthorizationError('登录会话已失效，停止实时推送。')
    }
    const roles = await security.auth.listUserRoles(auth.userId)
    if (!roles.length) throw new AuthorizationError('工作区权限已失效，停止实时推送。')
    const currentAuth: AuthContext = { ...auth, roles }
    const checked = new Set<string>()
    for (const scope of scopes) {
      if (scope.object === 'connection') continue
      const key = `${scope.object}:${scope.resourceId}`
      if (checked.has(key)) continue
      checked.add(key)
      const resource = scope.object === 'run'
        ? store.getRun(scope.resourceId)
        : store.getThread(scope.resourceId)
      if (!resource.workspaceId || !(await security.authorization.can(currentAuth, scope.object, 'read', {
        workspaceId: resource.workspaceId,
        userId: resource.createdByUserId ?? null,
        visibility: resource.visibility ?? null,
        resourceId: scope.resourceId,
      }))) {
        throw new AuthorizationError('订阅资源权限已失效，停止实时推送。')
      }
    }
  }
}

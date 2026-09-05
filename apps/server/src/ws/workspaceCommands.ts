// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 工作区命令
//
//   文件:       workspaceCommands.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import type { AuthContext } from '../security/types.js'
import type { SecurityServices } from '../security/routes.js'
import type { WsCommandRegistry } from './commandRegistry.js'

export function registerWorkspaceCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'workspace:bootstrap',
    handler: async (payload, context) => {
      const auth = requireAuth(context.auth)
      const session = await resolveBootstrapSession(
        context.dependencies.store,
        auth,
        context.dependencies.security,
        payload.sessionId ?? null,
        payload.workspaceId ?? null,
      )
      return {
        session,
        threads: context.dependencies.store.listThreadsForSession(session.id),
        providers: context.dependencies.modelRegistry.descriptors(),
        tools: context.dependencies.toolRegistry.descriptors(),
        auth: context.dependencies.security.auth.toAuthMe(auth),
      }
    },
  })
}

async function resolveBootstrapSession(
  store: PlatformPersistenceFacade,
  auth: AuthContext,
  security: SecurityServices,
  requestedSessionId: string | null,
  requestedWorkspaceId: string | null,
) {
  if (!requestedSessionId || requestedSessionId === PlatformPersistenceFacade.DEFAULT_SESSION_ID) {
    return store.getOrCreateUserDefaultSession({
      workspaceId: requestedWorkspaceId ?? auth.defaultWorkspaceId,
      userId: auth.userId,
    })
  }
  const session = store.getSession(requestedSessionId)
  if (requestedWorkspaceId && session.workspaceId !== requestedWorkspaceId) {
    throw new Error('请求的工作区与会话归属不一致。')
  }
  await security.authorization.assertResourceWorkspace(auth, 'session', 'read', {
    workspaceId: session.workspaceId,
    createdByUserId: session.createdByUserId,
    visibility: session.visibility,
    resourceId: session.id,
  })
  return session
}

function requireAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 自定义 Provider 控制命令
//
//   文件:       customProviderCommands.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AuthContext } from '../security/types.js'
import type { WsCommandRegistry } from './commandRegistry.js'

export function registerCustomProviderCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'provider:custom:list',
    handler: (_payload, context) => requireService(context.dependencies.customProviderService).list(),
  })

  registry.register({
    type: 'provider:credential:stage',
    handler: (payload, context) => requireService(context.dependencies.customProviderService)
      .credentials.stage(payload.secret, requireAuth(context.auth)),
  })

  registry.register({
    type: 'provider:custom:discover-models',
    handler: (payload, context) => requireService(context.dependencies.customProviderService)
      .discoverModels({
        providerId: payload.providerId,
        baseUrl: payload.baseUrl,
        ...(payload.credentialHandle !== undefined ? { credentialHandle: payload.credentialHandle } : {}),
        auth: requireAuth(context.auth),
      }),
  })

  registry.register({
    type: 'provider:custom:test',
    handler: (payload, context) => requireService(context.dependencies.customProviderService).test({
      config: payload.config,
      mode: payload.mode,
      ...(payload.credentialHandle !== undefined ? { credentialHandle: payload.credentialHandle } : {}),
      auth: requireAuth(context.auth),
    }),
  })

  registry.register({
    type: 'provider:custom:upsert',
    handler: (payload, context) => requireService(context.dependencies.customProviderService).save({
      config: payload.config,
      expectedRevision: payload.expectedRevision,
      ...(payload.credentialHandle !== undefined ? { credentialHandle: payload.credentialHandle } : {}),
      ...(payload.clearApiKey !== undefined ? { clearApiKey: payload.clearApiKey } : {}),
      auth: requireAuth(context.auth),
    }),
  })

  registry.register({
    type: 'provider:custom:delete',
    handler: async (payload, context) => ({
      deleted: await requireService(context.dependencies.customProviderService)
        .delete(payload.providerId, payload.expectedRevision),
      providerId: payload.providerId,
    }),
  })
}

function requireService<T>(service: T | undefined): T {
  if (!service) throw new Error('自定义 Provider 服务未装配。')
  return service
}

function requireAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}

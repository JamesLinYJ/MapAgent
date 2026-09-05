// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 线程命令
//
//   文件:       threadCommands.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { optionalPositiveInteger } from './payload.js'
import { subscribeToThread } from './subscriptions.js'
import type { WsCommandRegistry } from './commandRegistry.js'

export function registerThreadCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'thread:list',
    handler: (payload, context) => context.dependencies.store.listThreadsForSession(payload.sessionId),
  })

  registry.register({
    type: 'thread:get',
    handler: async (payload, context) => ({
      thread: context.dependencies.store.getThread(payload.threadId),
      manifest: await context.dependencies.store.getThreadManifest(payload.threadId),
    }),
  })

  registry.register({
    type: 'thread:create',
    handler: (payload, context) => context.dependencies.store.createThread(payload.sessionId, payload.title ?? null),
  })

  registry.register({
    type: 'thread:update',
    handler: (payload, context) => context.dependencies.store.updateThread(payload.threadId, { title: payload.title }),
  })

  registry.register({
    type: 'thread:delete',
    handler: async (payload, context) => {
      await context.dependencies.store.deleteThread(payload.threadId)
      return { deleted: true, threadId: payload.threadId }
    },
  })

  registry.register({
    type: 'thread:history',
    handler: (payload, context) => context.dependencies.store.listThreadHistory(
      payload.threadId,
      payload.cursor ?? null,
      optionalPositiveInteger(payload.limit, 'limit'),
    ),
  })

  registry.register({
    type: 'thread:fork',
    handler: (payload, context) => context.dependencies.store.forkThread(
      payload.threadId,
      payload.entryId,
      payload.title ?? null,
    ),
  })

  registry.register({
    type: 'thread:trash:list',
    handler: (payload, context) => context.dependencies.store.listTrash(payload.sessionId),
  })

  registry.register({
    type: 'thread:trash:restore',
    handler: (payload, context) => context.dependencies.store.restoreThread(payload.threadId),
  })

  registry.register({
    type: 'thread:trash:purge',
    handler: async (payload, context) => {
      await context.dependencies.store.purgeThread(payload.threadId)
      return { purged: true, threadId: payload.threadId }
    },
  })

  registry.register({
    type: 'thread:subscribe',
    handler: async (payload, context) => {
      subscribeToThread(
        context.ws,
        payload.threadId,
        context.dependencies.store,
        context.dependencies.events,
        context.subscriptions,
      )
      return {
        thread: context.dependencies.store.getThread(payload.threadId),
        manifest: await context.dependencies.store.getThreadManifest(payload.threadId),
      }
    },
  })

  registry.register({
    type: 'thread:unsubscribe',
    handler: (payload, context) => {
      const key = `thread:${payload.threadId}`
      context.subscriptions.get(key)?.()
      context.subscriptions.delete(key)
      return { unsubscribed: true, threadId: payload.threadId }
    },
  })
}

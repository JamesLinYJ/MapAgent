// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 控制面资源命令
//
//   文件:       controlCommands.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { AzureSpeechService } from '../speech/azureSpeechService.js'
import { StoreNotFoundError } from '../store/storeErrors.js'
import type { WsCommandRegistry } from './commandRegistry.js'

export function registerControlCommands(registry: WsCommandRegistry): void {
  registry.register({
    type: 'tool-catalog:list',
    handler: (_payload, context) => context.dependencies.store.toolCatalog.listToolCatalogEntries(),
  })

  registry.register({
    type: 'tool-catalog:upsert',
    handler: (payload, context) => context.dependencies.store.toolCatalog.upsertToolCatalogEntry({
      toolKind: payload.toolKind,
      toolName: payload.toolName,
      payload: payload.payload,
      sortOrder: payload.sortOrder ?? 0,
    }),
  })

  registry.register({
    type: 'tool-catalog:delete',
    handler: async (payload, context) => {
      await context.dependencies.store.toolCatalog.deleteToolCatalogEntry(payload.toolKind, payload.toolName)
      return { deleted: true }
    },
  })

  registry.register({
    type: 'runtime-config:update',
    handler: async (payload, context) => {
      const stored = await context.dependencies.store.runtimeConfiguration.upsertRuntimeConfig(
        'agent-runtime',
        payload.config,
        payload.expectedRevision,
      )
      return {
        config: payload.config,
        revision: stored.revision,
        origin: 'database' as const,
        updatedAt: stored.updatedAt,
      }
    },
  })

  registry.register({
    type: 'speech:authorization',
    handler: (_payload, context) => new AzureSpeechService(context.dependencies.env).issueAuthorization(),
  })

  registry.register({
    type: 'file:delete',
    handler: async (payload, context) => {
      const deleted = await context.dependencies.fileLifecycle.delete(payload.fileId, payload.threadId)
      if (!deleted) throw new StoreNotFoundError(`文件 '${payload.fileId}' 不存在`)
      return { deleted: true, id: payload.fileId }
    },
  })

  registry.register({
    type: 'layer:list',
    handler: (payload, context) => {
      const auth = context.auth
      if (!auth) throw new Error('WebSocket 命令需要登录。')
      return context.dependencies.managedLayers.listVisibleLayers(
        auth.defaultWorkspaceId,
        payload.sessionId ?? null,
        payload.threadId ?? null,
      )
    },
  })

  registry.register({
    type: 'layer:update',
    handler: (payload, context) => context.dependencies.managedLayers.updateLayerMetadata(payload.layerKey, payload.update),
  })

  registry.register({
    type: 'layer:delete',
    handler: async (payload, context) => {
      const deleted = await context.dependencies.managedLayers.deleteLayer(payload.layerKey)
      if (!deleted) throw new StoreNotFoundError(`图层 '${payload.layerKey}' 不存在`)
      return { deleted: true, layerKey: payload.layerKey }
    },
  })
}

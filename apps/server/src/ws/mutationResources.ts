// +-------------------------------------------------------------------------
//
//   地理智能平台 - WS 写命令资源键
//
//   文件:       mutationResources.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { WsWriteCommand } from '@geo-agent-platform/shared-types'

import type {
  MutationResourceResolver,
  WsCommandContext,
  WsCommandRegistry,
} from './commandRegistry.js'
import { optionalString, requiredString } from './payload.js'

const resourceResolvers = {
  'thread:create': byField('session', 'sessionId'),
  'thread:update': byField('thread', 'threadId'),
  'thread:delete': byField('thread', 'threadId'),
  'thread:fork': byField('thread', 'threadId'),
  'thread:compact': byField('thread', 'threadId'),
  'thread:memory:update': byField('thread', 'threadId'),
  'thread:memory:rebuild': byField('thread', 'threadId'),
  'thread:trash:restore': byField('thread', 'threadId'),
  'thread:trash:purge': byField('thread', 'threadId'),
  'run:start': payload => {
    const threadId = optionalString(payload.threadId)
    return threadId
      ? [identifiedResource('thread', threadId)]
      : [identifiedResource('session', requiredString(payload, 'sessionId'))]
  },
  'run:cancel': byField('run', 'runId'),
  'run:resume': byField('run', 'runId'),
  'run:steer': byField('run', 'runId'),
  'run:respond-decision': byField('run', 'runId'),
  'subagent:follow-up': byField('run', 'runId'),
  'subagent:cancel': byField('run', 'runId'),
  'tool:run': (payload, context) => {
    const runId = optionalString(payload.runId)
    if (runId) return [identifiedResource('run', runId)]
    const threadId = optionalString(payload.threadId)
    if (threadId) return [identifiedResource('thread', threadId)]
    const sessionId = optionalString(payload.sessionId)
    return sessionId
      ? [identifiedResource('session', sessionId)]
      : [workspaceResource(context, 'tool-execution')]
  },
  'tool-catalog:upsert': globalSingleton('tool-catalog'),
  'tool-catalog:delete': globalSingleton('tool-catalog'),
  'runtime-config:update': globalSingleton('runtime-config'),
  'provider:credential:stage': globalSingleton('provider-credential-staging'),
  'provider:custom:discover-models': byField('provider', 'providerId'),
  'provider:custom:test': nestedProviderConfig,
  'provider:custom:upsert': nestedProviderConfig,
  'provider:custom:delete': byField('provider', 'providerId'),
  'speech:authorization': workspaceSingleton('speech-authorization'),
  'memory:write': workspaceSingleton('memory'),
  'memory:delete': workspaceSingleton('memory'),
  'memory:extract': byField('thread', 'threadId'),
  'memory:dream': workspaceSingleton('memory'),
  'memory:session:rebuild': byField('thread', 'threadId'),
  'file:delete': payload => [
    identifiedResource('thread', requiredString(payload, 'threadId')),
    identifiedResource('file', requiredString(payload, 'fileId')),
  ],
  'layer:update': byField('layer', 'layerKey'),
  'layer:delete': byField('layer', 'layerKey'),
  'map-scene:update': byField('thread', 'threadId'),
  'automation:create': workspaceSingleton('automation-catalog'),
  'automation:update': byField('automation', 'automationId'),
  'automation:publish': byField('automation', 'automationId'),
  'automation:disable': byField('automation', 'automationId'),
  'automation:start': byField('automation', 'automationId'),
  'automation:cancel': byField('automation-run', 'automationRunId'),
  'automation:respond-approval': byField('automation-run', 'automationRunId'),
  'scheduled-task:create': workspaceSingleton('scheduled-task-catalog'),
  'scheduled-task:update': byField('scheduled-task', 'taskId'),
  'scheduled-task:delete': byField('scheduled-task', 'taskId'),
  'background-task:promote': byField('background-task', 'taskId'),
  'background-task:cancel': byField('background-task', 'taskId'),
} satisfies Record<WsWriteCommand, MutationResourceResolver>

/** 所有 shared-types 中标记为 write 的命令都必须在此显式声明互斥粒度。 */
export function registerWsMutationResources(registry: WsCommandRegistry): void {
  for (const [type, resolver] of Object.entries(resourceResolvers)) {
    registry.setMutationResources(type as WsWriteCommand, resolver)
  }
}

/** 供架构测试验证跨连接资源身份；生产注册仍只消费同一映射。 */
export function wsMutationResourceKeys(
  type: WsWriteCommand,
  payload: Record<string, unknown>,
  context: WsCommandContext,
): readonly string[] {
  return resourceResolvers[type](payload, context)
}

function byField(resource: string, field: string): MutationResourceResolver {
  return payload => [identifiedResource(resource, requiredString(payload, field))]
}

function workspaceSingleton(resource: string): MutationResourceResolver {
  return (_payload, context) => [workspaceResource(context, resource)]
}

function globalSingleton(resource: string): MutationResourceResolver {
  return () => [JSON.stringify(['global', resource])]
}

function nestedProviderConfig(payload: Record<string, unknown>): string[] {
  const config = requireRecord(payload.config, 'config')
  return [identifiedResource('provider', requiredString(config, 'providerId'))]
}

function workspaceResource(context: WsCommandContext, resource: string): string {
  const workspaceId = context.auth?.defaultWorkspaceId ?? 'anonymous'
  return JSON.stringify(['workspace', workspaceId, resource])
}

/**
 * 资源 ID 是控制面互斥身份，不能混入发起者的默认工作区。否则两个拥有同一
 * 跨工作区资源权限、但默认工作区不同的连接会绕过同一资源锁。
 */
function identifiedResource(resource: string, id: string): string {
  return JSON.stringify(['resource', resource, id])
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`字段 '${field}' 必须是对象。`)
  }
  return value as Record<string, unknown>
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 授权策略
//
//   文件:       security.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 集中维护 WS 控制命令的 CSRF 与 RBAC 规则。handler 只负责连接和分发，
// 每个命令在进入业务执行前必须经过这里的会话活跃性和资源 scope 校验。

import { StoreNotFoundError } from '../store/storeErrors.js'
import type { AuthContext } from '../security/types.js'
import { isLocalDesktopEmail } from '../security/localDesktopPrincipal.js'
import { assertDirectToolRunAllowed } from '../security/toolExecutionPolicy.js'
import type { WsCommandContext,WsCommandRegistry } from './commandRegistry.js'
import type { WsDependencies } from './dependencies.js'
import { optionalString,requiredString } from './payload.js'

function requireWsAuth(auth: AuthContext | null): AuthContext {
  if (!auth) throw new Error('WebSocket 命令需要登录。')
  return auth
}

type AuthorizationPolicy = (
  payload: Record<string, unknown>,
  context: WsCommandContext,
  auth: AuthContext,
) => Promise<void> | void

export function registerWsAuthorizationPolicies(registry: WsCommandRegistry): void {
  const set = (type: Parameters<WsCommandRegistry['setAuthorize']>[0], policy: AuthorizationPolicy) => {
    registry.setAuthorize(type, async (payload, context) => policy(payload, context, await requireActiveAuth(context)))
  }

  set('workspace:bootstrap', workspaceBootstrapRead)
  set('session:get-default', workspaceRead)
  set('session:get', sessionRead)
  set('thread:list', sessionRead)
  set('thread:trash:list', sessionRead)
  set('run:list', sessionRead)
  set('thread:create', (payload, context, auth) => authorizeSession(context.dependencies, auth, requiredString(payload, 'sessionId'), 'create', 'thread'))
  set('thread:get', threadRead)
  set('thread:history', threadRead)
  set('thread:context', threadRead)
  set('thread:memory:get', threadRead)
  set('memory:session:get', threadRead)
  set('thread:subscribe', threadRead)
  set('thread:update', threadUpdate)
  set('thread:compact', threadUpdate)
  set('thread:memory:update', threadUpdate)
  set('thread:memory:rebuild', threadUpdate)
  set('memory:session:rebuild', threadUpdate)
  set('thread:delete', (payload, context, auth) => authorizeThread(context.dependencies, auth, requiredString(payload, 'threadId'), 'delete'))
  set('thread:trash:restore', (payload, context, auth) => authorizeTrashedThread(context.dependencies, auth, requiredString(payload, 'threadId'), 'update'))
  set('thread:trash:purge', (payload, context, auth) => authorizeTrashedThread(context.dependencies, auth, requiredString(payload, 'threadId'), 'delete'))
  set('thread:fork', threadRead)
  set('run:start', authorizeRunStart)
  set('run:get', runRead)
  set('run:subscribe', runRead)
  set('run:cancel', runExecute)
  set('run:steer', runExecute)
  set('run:resume', runExecute)
  set('run:respond-decision', (payload, context, auth) => authorizeRun(context.dependencies, auth, requiredString(payload, 'runId'), 'approve'))
  set('subagent:list', runRead)
  set('subagent:get', runRead)
  set('subagent:follow-up', runExecute)
  set('subagent:cancel', runExecute)
  set('tool:list', (_payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'tool', 'read', { workspaceId: auth.defaultWorkspaceId }))
  set('tool:run', (payload, context, auth) => assertDirectToolRunAllowed(auth, context.dependencies.security.authorization, context.dependencies.toolRegistry, requiredString(payload, 'toolName')))
  set('tool-catalog:list', workspaceRead)
  set('skill:list', workspaceRead)
  set('skill:search', workspaceRead)
  set('runtime-config:get', workspaceRead)
  set('provider:list', workspaceRead)
  set('provider:custom:list', runtimeConfigurationRead)
  set('provider:credential:stage', runtimeConfigurationUpdate)
  set('provider:custom:discover-models', runtimeConfigurationUpdate)
  set('provider:custom:test', runtimeConfigurationUpdate)
  set('provider:custom:upsert', runtimeConfigurationUpdate)
  set('provider:custom:delete', runtimeConfigurationUpdate)
  set('system:get', workspaceRead)
  set('usage:summary', workspaceRead)
  set('usage:thread-summary', threadRead)
  set('tool-catalog:upsert', runtimeConfigurationUpdate)
  set('tool-catalog:delete', runtimeConfigurationUpdate)
  set('runtime-config:update', runtimeConfigurationUpdate)
  set('speech:authorization', (_payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'speech', 'execute', { workspaceId: auth.defaultWorkspaceId }))
  set('memory:list', memoryRead)
  set('memory:read', memoryRead)
  set('memory:search', memoryRead)
  set('memory:instructions:list', memoryRead)
  set('memory:write', (_payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'memory', 'create', { workspaceId: auth.defaultWorkspaceId, userId: auth.userId }))
  set('memory:delete', (_payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'memory', 'delete', { workspaceId: auth.defaultWorkspaceId, userId: auth.userId }))
  set('memory:extract', memoryExecute)
  set('memory:dream', memoryExecute)
  set('file:list', authorizeFileList)
  set('file:delete', authorizeFileDelete)
  set('layer:list', (_payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'layer', 'read', { workspaceId: auth.defaultWorkspaceId }))
  set('layer:update', (payload, context, auth) => authorizeLayer(context.dependencies, auth, requiredString(payload, 'layerKey'), 'update'))
  set('layer:delete', (payload, context, auth) => authorizeLayer(context.dependencies, auth, requiredString(payload, 'layerKey'), 'delete'))
  set('map-scene:update', (payload, context, auth) => authorizeThread(
    context.dependencies,
    auth,
    requiredString(payload, 'threadId'),
    'update',
  ))
  set('automation:list', (_payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'automation', 'read', { workspaceId: auth.defaultWorkspaceId }))
  set('automation:validate', (_payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'automation', 'create', { workspaceId: auth.defaultWorkspaceId }))
  set('automation:create', (_payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'automation', 'create', { workspaceId: auth.defaultWorkspaceId }))
  set('automation:update', (payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'automation', 'update', { workspaceId: auth.defaultWorkspaceId, resourceId: requiredString(payload, 'automationId') }))
  set('automation:publish', (payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'automation', 'update', { workspaceId: auth.defaultWorkspaceId, resourceId: requiredString(payload, 'automationId') }))
  set('automation:disable', (payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'automation', 'delete', { workspaceId: auth.defaultWorkspaceId, resourceId: requiredString(payload, 'automationId') }))
  set('automation:history', (payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'automation', 'read', { workspaceId: auth.defaultWorkspaceId, resourceId: requiredString(payload, 'automationId') }))
  set('automation:start', (payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'automation', 'execute', { workspaceId: auth.defaultWorkspaceId, resourceId: requiredString(payload, 'automationId') }))
  set('automation:cancel', (payload, context, auth) => authorizeAutomationRun(context.dependencies, auth, requiredString(payload, 'automationRunId'), 'execute'))
  set('automation:run:get', (payload, context, auth) => authorizeAutomationRun(context.dependencies, auth, requiredString(payload, 'automationRunId'), 'read'))
  set('automation:respond-approval', (payload, context, auth) => authorizeAutomationRun(context.dependencies, auth, requiredString(payload, 'automationRunId'), 'approve'))
  set('scheduled-task:list', (_payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'scheduled_task', 'read', { workspaceId: auth.defaultWorkspaceId }))
  set('scheduled-task:create', (payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'scheduled_task', 'create', { workspaceId: auth.defaultWorkspaceId, resourceId: optionalString(payload.targetId) ?? null }))
  set('scheduled-task:update', (payload, context, auth) => authorizeScheduledTask(context.dependencies, auth, requiredString(payload, 'taskId'), 'update'))
  set('scheduled-task:delete', (payload, context, auth) => authorizeScheduledTask(context.dependencies, auth, requiredString(payload, 'taskId'), 'delete'))
  set('background-task:list', (_payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'scheduled_task', 'read', { workspaceId: auth.defaultWorkspaceId }))
  set('background-task:promote', (payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'scheduled_task', 'update', { workspaceId: auth.defaultWorkspaceId, resourceId: requiredString(payload, 'taskId') }))
  set('background-task:cancel', (payload, context, auth) => context.dependencies.security.authorization.enforce(auth, 'scheduled_task', 'delete', { workspaceId: auth.defaultWorkspaceId, resourceId: requiredString(payload, 'taskId') }))
  set('run:unsubscribe', noop)
  set('thread:unsubscribe', noop)
}

async function requireActiveAuth(context: WsCommandContext): Promise<AuthContext> {
  const auth = requireWsAuth(context.auth)
  if (!(await context.dependencies.security.auth.isAuthContextActive(auth))) {
    throw new Error('登录会话已失效，请重新登录。')
  }
  // WebSocket 连接可能长时间存活，握手时的角色快照不能作为排队后授权事实。
  // 每次入队前和真正执行前都重新读取角色，使撤权在 handler 前立即生效。
  const roles = await context.dependencies.security.auth.listUserRoles(auth.userId)
  if (roles.length === 0) throw new Error('当前账号已失去工作区权限，请重新登录。')
  return { ...auth, roles }
}

async function workspaceRead(_payload: Record<string, unknown>, context: WsCommandContext, auth: AuthContext): Promise<void> {
  await context.dependencies.security.authorization.enforce(auth, 'workspace', 'read', { workspaceId: auth.defaultWorkspaceId })
}

async function workspaceBootstrapRead(payload: Record<string, unknown>, context: WsCommandContext, auth: AuthContext): Promise<void> {
  const requestedSessionId = optionalString(payload.sessionId)
  if (requestedSessionId) {
    const session = context.dependencies.store.getSession(requestedSessionId)
    await context.dependencies.security.authorization.assertResourceWorkspace(auth, 'session', 'read', {
      workspaceId: session.workspaceId,
      createdByUserId: session.createdByUserId,
      visibility: session.visibility,
      resourceId: session.id,
    })
    await context.dependencies.security.authorization.enforce(auth, 'tool', 'read', {
      workspaceId: session.workspaceId ?? auth.defaultWorkspaceId,
    })
    return
  }
  const workspaceId = optionalString(payload.workspaceId) ?? auth.defaultWorkspaceId
  await context.dependencies.security.authorization.enforce(auth, 'workspace', 'read', { workspaceId })
  await context.dependencies.security.authorization.enforce(auth, 'tool', 'read', { workspaceId })
}

function sessionRead(payload: Record<string, unknown>, context: WsCommandContext, auth: AuthContext): Promise<void> {
  return authorizeSession(context.dependencies, auth, requiredString(payload, 'sessionId'), 'read')
}

function threadRead(payload: Record<string, unknown>, context: WsCommandContext, auth: AuthContext): Promise<void> {
  return authorizeThread(context.dependencies, auth, requiredString(payload, 'threadId'), 'read')
}

function threadUpdate(payload: Record<string, unknown>, context: WsCommandContext, auth: AuthContext): Promise<void> {
  return authorizeThread(context.dependencies, auth, requiredString(payload, 'threadId'), 'update')
}

async function authorizeRunStart(payload: Record<string, unknown>, context: WsCommandContext, auth: AuthContext): Promise<void> {
  const threadId = optionalString(payload.threadId)
  if (threadId) return authorizeThread(context.dependencies, auth, threadId, 'create', 'run')
  return authorizeSession(context.dependencies, auth, requiredString(payload, 'sessionId'), 'create', 'run')
}

function runRead(payload: Record<string, unknown>, context: WsCommandContext, auth: AuthContext): Promise<void> {
  return authorizeRun(context.dependencies, auth, requiredString(payload, 'runId'), 'read')
}

function runExecute(payload: Record<string, unknown>, context: WsCommandContext, auth: AuthContext): Promise<void> {
  return authorizeRun(context.dependencies, auth, requiredString(payload, 'runId'), 'execute')
}

function runtimeConfigurationRead(
  _payload: Record<string, unknown>,
  context: WsCommandContext,
  auth: AuthContext,
): Promise<void> {
  return authorizeRuntimeConfiguration(context, auth, 'read')
}

function runtimeConfigurationUpdate(
  _payload: Record<string, unknown>,
  context: WsCommandContext,
  auth: AuthContext,
): Promise<void> {
  return authorizeRuntimeConfiguration(context, auth, 'update')
}

async function authorizeRuntimeConfiguration(
  context: WsCommandContext,
  auth: AuthContext,
  action: 'read' | 'update',
): Promise<void> {
  const scope = { workspaceId: auth.defaultWorkspaceId }
  const metadata = { wsCommand: context.msg.type }
  // 本机 Desktop 身份由操作系统保护的根密钥派生，只在 loopback Broker
  // 中可用。它获得本机运行配置的窄权限，但不获得用户、成员或审计管理权。
  if (isLocalDesktopEmail(auth.email)) {
    await context.dependencies.security.authorization.audit(
      auth,
      'runtime_config',
      action,
      scope,
      'allowed',
      { ...metadata, principalType: 'local_desktop' },
    )
    return
  }
  await context.dependencies.security.authorization.enforce(
    auth,
    'runtime_config',
    action,
    scope,
    metadata,
  )
}

async function memoryRead(_payload: Record<string, unknown>, context: WsCommandContext, auth: AuthContext): Promise<void> {
  await context.dependencies.security.authorization.enforce(auth, 'memory', 'read', { workspaceId: auth.defaultWorkspaceId, userId: auth.userId })
}

async function memoryExecute(_payload: Record<string, unknown>, context: WsCommandContext, auth: AuthContext): Promise<void> {
  await context.dependencies.security.authorization.enforce(auth, 'memory', 'execute', { workspaceId: auth.defaultWorkspaceId, userId: auth.userId })
}

async function authorizeFileList(payload: Record<string, unknown>, context: WsCommandContext, auth: AuthContext): Promise<void> {
  await authorizeThread(context.dependencies, auth, requiredString(payload, 'threadId'), 'read')
}

async function authorizeFileDelete(payload: Record<string, unknown>, context: WsCommandContext, auth: AuthContext): Promise<void> {
  await authorizeThread(context.dependencies, auth, requiredString(payload, 'threadId'), 'update')
}

function noop(): void {
  // 会话活跃性由包装器统一校验；取消订阅本身不访问资源。
}

async function authorizeSession(
  dependencies: WsDependencies,
  auth: AuthContext,
  sessionId: string,
  action: 'read' | 'create' | 'update' | 'delete',
  object: 'session' | 'thread' | 'run' = 'session',
): Promise<void> {
  const session = dependencies.store.getSession(sessionId)
  await dependencies.security.authorization.assertResourceWorkspace(auth, object, action, {
    workspaceId: session.workspaceId,
    createdByUserId: session.createdByUserId,
    visibility: session.visibility,
    resourceId: session.id,
  })
}

async function authorizeThread(
  dependencies: WsDependencies,
  auth: AuthContext,
  threadId: string,
  action: 'read' | 'create' | 'update' | 'delete',
  object: 'thread' | 'run' = 'thread',
): Promise<void> {
  const thread = dependencies.store.getThread(threadId)
  await dependencies.security.authorization.assertResourceWorkspace(auth, object, action, {
    workspaceId: thread.workspaceId,
    createdByUserId: thread.createdByUserId,
    visibility: thread.visibility,
    resourceId: thread.id,
  })
}

async function authorizeTrashedThread(
  dependencies: WsDependencies,
  auth: AuthContext,
  threadId: string,
  action: 'update' | 'delete',
): Promise<void> {
  const thread = await dependencies.store.getTrashedThread(threadId)
  await dependencies.security.authorization.assertResourceWorkspace(auth, 'thread', action, {
    workspaceId: thread.workspaceId,
    createdByUserId: thread.createdByUserId,
    visibility: thread.visibility,
    resourceId: thread.id,
  })
}

async function authorizeRun(
  dependencies: WsDependencies,
  auth: AuthContext,
  runId: string,
  action: 'read' | 'execute' | 'approve',
): Promise<void> {
  const run = dependencies.store.getRun(runId)
  await dependencies.security.authorization.assertResourceWorkspace(auth, 'run', action, {
    workspaceId: run.workspaceId,
    createdByUserId: run.createdByUserId,
    visibility: run.visibility,
    resourceId: run.id,
  })
}

async function authorizeLayer(
  dependencies: WsDependencies,
  auth: AuthContext,
  layerKey: string,
  action: 'update' | 'delete',
): Promise<void> {
  const layer = await dependencies.managedLayers.getLayer(layerKey)
  if (!layer) throw new StoreNotFoundError(`图层 '${layerKey}' 不存在`)
  if (layer.readonly) throw new Error('系统图层为只读，不能修改。')
  await dependencies.security.authorization.assertResourceWorkspace(auth, 'layer', action, {
    workspaceId: layer.workspaceId,
    createdByUserId: layer.createdByUserId,
    visibility: layer.visibility,
    resourceId: layer.layerKey,
  })
}

async function authorizeScheduledTask(
  dependencies: WsDependencies,
  auth: AuthContext,
  taskId: string,
  action: 'update' | 'delete',
): Promise<void> {
  const task = await dependencies.store.automations.getScheduledTask(taskId)
  if (!task) throw new StoreNotFoundError(`定时任务 '${taskId}' 不存在`)
  await dependencies.security.authorization.assertResourceWorkspace(auth, 'scheduled_task', action, {
    workspaceId: task.workspaceId,
    createdByUserId: task.createdByUserId,
    visibility: 'workspace',
    resourceId: task.taskId,
  })
}

async function authorizeAutomationRun(
  dependencies: WsDependencies,
  auth: AuthContext,
  automationRunId: string,
  action: 'read' | 'execute' | 'approve',
): Promise<void> {
  const automationRun = await dependencies.store.automations.getAutomationRunRecord(automationRunId)
  if (!automationRun) throw new StoreNotFoundError(`自动化流程运行 '${automationRunId}' 不存在`)
  await dependencies.security.authorization.assertResourceWorkspace(auth, 'automation', action, {
    workspaceId: automationRun.workspaceId,
    createdByUserId: automationRun.createdByUserId,
    visibility: 'workspace',
    resourceId: automationRun.automationRunId,
  })
}

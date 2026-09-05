// +-------------------------------------------------------------------------
//
//   地理智能平台 - Casbin RBAC 授权服务
//
//   文件:       authorizationService.ts
//
//   日期:       2026年07月02日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { newEnforcer, newModelFromString, type Enforcer } from 'casbin'
import type { Database } from '../db/connection.js'
import type { AuditStore } from '../store/postgres/auditStore.js'
import type { AuthContext, AuthorizationScope, RbacAction, RbacObject } from './types.js'
import { CasbinPostgresAdapter } from './casbinPostgresAdapter.js'

const RBAC_MODEL = `
[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act, eft

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = r.sub == p.sub && (p.dom == "*" || r.dom == p.dom) && (p.obj == "*" || r.obj == p.obj) && actionMatch(r.act, p.act)
`

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthorizationError'
  }
}

export class AuthorizationService {
  private enforcerPromise: Promise<Enforcer> | null = null

  constructor(
    private readonly db: Database,
    private readonly auditStore: AuditStore,
  ) {}

  async enforce(
    auth: AuthContext,
    object: RbacObject,
    action: RbacAction,
    scope: AuthorizationScope = {},
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const allowed = await this.can(auth, object, action, scope)
    await this.audit(auth, object, action, scope, allowed ? 'allowed' : 'denied', metadata)
    if (!allowed) {
      throw new AuthorizationError(formatAuthorizationDeniedMessage(object, action, scope.resourceId))
    }
  }

  async can(
    auth: AuthContext,
    object: RbacObject,
    action: RbacAction,
    scope: AuthorizationScope = {},
  ): Promise<boolean> {
    const workspaceId = scope.workspaceId ?? auth.defaultWorkspaceId
    const domain = workspaceId ? `workspace:${workspaceId}` : '*'
    const enforcer = await this.enforcer()
    const roles = auth.roles
    for (const binding of roles) {
      if (binding.role !== 'platform_admin' && workspaceId && binding.workspaceId !== workspaceId) continue
      const roleDomain = binding.role === 'platform_admin' ? '*' : `workspace:${binding.workspaceId}`
      if (await enforcer.enforce(binding.role, roleDomain === '*' ? '*' : domain, object, action)) return true
    }
    return false
  }

  async assertResourceWorkspace(
    auth: AuthContext,
    object: RbacObject,
    action: RbacAction,
    resource: { workspaceId?: string | null; createdByUserId?: string | null; visibility?: string | null; resourceId?: string | null },
  ): Promise<void> {
    const workspaceId = resource.workspaceId
    if (!workspaceId) {
      throw new AuthorizationError(`资源 '${resource.resourceId ?? object}' 缺少 workspaceId，必须先执行归属迁移。`)
    }
    await this.enforce(auth, object, action, {
      workspaceId,
      userId: resource.createdByUserId ?? null,
      visibility: resource.visibility ?? null,
      resourceId: resource.resourceId ?? null,
    })
  }

  async audit(
    auth: AuthContext | null,
    object: RbacObject,
    action: RbacAction,
    scope: AuthorizationScope,
    outcome: 'allowed' | 'denied' | 'error',
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const requestedWorkspaceId = scope.workspaceId ?? null
    const boundWorkspaceId = requestedWorkspaceId && auth?.roles.some(
      binding => binding.workspaceId === requestedWorkspaceId,
    )
      ? requestedWorkspaceId
      : null
    await this.auditStore.recordEvent({
      actorUserId: auth?.userId ?? null,
      workspaceId: boundWorkspaceId,
      action,
      objectType: object,
      objectId: scope.resourceId ?? null,
      outcome,
      metadata: requestedWorkspaceId && !boundWorkspaceId
        ? { ...metadata, requestedWorkspaceId }
        : metadata,
    })
  }

  async reload(): Promise<void> {
    this.enforcerPromise = null
    await this.enforcer()
  }

  private async enforcer(): Promise<Enforcer> {
    if (!this.enforcerPromise) {
      const model = newModelFromString(RBAC_MODEL)
      this.enforcerPromise = newEnforcer(model, new CasbinPostgresAdapter(this.db)).then(enforcer => {
        enforcer.addFunction('actionMatch', actionMatch)
        return enforcer
      })
    }
    return this.enforcerPromise
  }
}

export function actionMatch(requestAction: unknown, policyAction: unknown): boolean {
  if (typeof requestAction !== 'string' || typeof policyAction !== 'string') return false
  return policyAction === '*' || policyAction.split('|').map(item => item.trim()).includes(requestAction)
}

export function formatAuthorizationDeniedMessage(
  object: RbacObject,
  action: RbacAction,
  resourceId?: string | null,
): string {
  if (object === 'admin' && action === 'admin') {
    return '当前身份没有执行平台管理操作的权限。'
  }
  const objectLabel = RBAC_OBJECT_LABELS[object]
  const actionLabel = RBAC_ACTION_LABELS[action]
  const resource = resourceId ? `“${resourceId}”` : ''
  return `当前身份没有${actionLabel}${resource}${objectLabel}的权限。`
}

const RBAC_OBJECT_LABELS: Record<RbacObject, string> = {
  workspace: '工作区',
  session: '会话',
  thread: '对话',
  run: '运行',
  artifact: '结果文件',
  dataset: '数据集',
  layer: '图层',
  tool: '工具',
  runtime_config: '运行配置',
  memory: '记忆',
  speech: '语音服务',
  automation: '自动化',
  scheduled_task: '定时任务',
  admin: '平台管理',
  system: '系统',
}

const RBAC_ACTION_LABELS: Record<RbacAction, string> = {
  read: '查看',
  create: '创建',
  update: '修改',
  delete: '删除',
  execute: '执行',
  approve: '审批',
  admin: '管理',
}

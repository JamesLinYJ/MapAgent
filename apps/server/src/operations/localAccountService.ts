// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本地特权账户管理服务
//
//   文件:       localAccountService.ts
//
//   日期:       2026年07月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

import type { Database } from '../db/connection.js'
import type {
  BetterAuthService,
  LocalConsoleAuthorization,
  LocalAuthRole,
} from '../security/authService.js'
import type { PlatformIdentityService } from '../security/platformIdentityService.js'
import { personalWorkspaceIdFor, platformUserIdFor } from '../security/platformIdentityIds.js'
import type { AuditStore } from '../store/postgres/auditStore.js'
import type {
  LocalAccountRepository,
  LocalManagedAccount,
} from '../store/postgres/localAccountRepository.js'
import type { MembershipRepository } from '../store/postgres/membershipRepository.js'
import type { PlatformUserRepository } from '../store/postgres/platformUserRepository.js'
import type { WorkspaceRepository } from '../store/postgres/workspaceRepository.js'

const emailSchema = z.string().trim().toLowerCase().email()
const displayNameSchema = z.string().trim().min(1).max(120)

interface LocalConsoleActor {
  osUser: string
  hostname: string
  processId: number
}

export interface LocalAccountServiceDependencies {
  db: Database
  auth: Pick<BetterAuthService,
    | 'createLocalAdminUser'
    | 'withLocalConsoleAuthorization'
    | 'setLocalAuthRole'
    | 'setLocalUserPassword'
    | 'setLocalUserBanned'
    | 'revokeLocalUserSessions'>
  identity: Pick<PlatformIdentityService, 'ensureProjection'>
  accounts: Pick<LocalAccountRepository, 'list' | 'getByEmail' | 'countActivePlatformAdmins'>
  users: Pick<PlatformUserRepository, 'update'>
  workspaces: Pick<WorkspaceRepository, 'ensurePersonal'>
  memberships: Pick<MembershipRepository, 'insert' | 'deleteRoleBinding' | 'deleteRoleForUser'>
  audit: Pick<AuditStore, 'recordEvent'>
  actor: LocalConsoleActor
  rootSecret: string
  rootKeyVersion: string
  minPasswordLength: number
}

/**
 * 本机 Console 的账户用例边界。操作系统保护的根密钥建立临时 Better Auth
 * 服务主体会话；认证凭据只经官方 Admin API 修改，平台角色仍由 membership 管理。
 */
export class LocalAccountService {
  constructor(private readonly dependencies: LocalAccountServiceDependencies) {}

  listAccounts(): Promise<LocalManagedAccount[]> {
    return this.dependencies.accounts.list()
  }

  createPlatformAdmin(input: {
    email: string
    password: string
    displayName: string
  }): Promise<LocalManagedAccount> {
    return this.withAuthorization(authorization => this.createPlatformAdminAuthorized(authorization, input))
  }

  private async createPlatformAdminAuthorized(
    authorization: LocalConsoleAuthorization,
    input: { email: string; password: string; displayName: string },
  ): Promise<LocalManagedAccount> {
    const email = emailSchema.parse(input.email)
    const displayName = displayNameSchema.parse(input.displayName)
    this.assertPassword(input.password)
    if (await this.dependencies.accounts.getByEmail(email)) {
      throw new Error('该邮箱的认证账户已经存在；请使用授权或密码重置操作。')
    }

    let authUserId: string
    try {
      const authUser = await this.dependencies.auth.createLocalAdminUser(
        authorization,
        { email, password: input.password, name: displayName },
      )
      authUserId = authUser.id
    } catch (error) {
      await this.audit(null, 'local_console.admin.create', null, 'error', {
        targetEmail: email,
        stage: 'better_auth',
      }).catch(() => undefined)
      throw new Error('Better Auth 未能创建管理员认证账户。', { cause: error })
    }

    let projectionUserId: string
    try {
      const projection = await this.dependencies.identity.ensureProjection({
        platformUserId: platformUserIdFor(authUserId),
        authUserId,
        email,
        displayName,
        personalWorkspaceId: personalWorkspaceIdFor(email),
        bootstrapAdmin: true,
      })
      projectionUserId = projection.user.userId
    } catch (error) {
      await this.audit(null, 'local_console.admin.create', null, 'error', {
        targetEmail: email,
        authUserId,
        stage: 'platform_projection',
      }).catch(() => undefined)
      throw new Error('认证账户已创建，但 平台 管理员投影失败；请保留日志并修复投影后再继续。', { cause: error })
    }
    try {
      await this.audit(null, 'local_console.admin.create', projectionUserId, 'allowed', {
        targetEmail: email,
      })
    } catch (error) {
      throw new Error('管理员已创建，但审计事件写入失败；请立即检查数据库审计链路。', { cause: error })
    }
    return this.requireAccount(email)
  }

  grantPlatformAdmin(targetEmail: string): Promise<LocalManagedAccount> {
    return this.withAuthorization(authorization => this.grantPlatformAdminAuthorized(authorization, targetEmail))
  }

  private async grantPlatformAdminAuthorized(
    authorization: LocalConsoleAuthorization,
    targetEmail: string,
  ): Promise<LocalManagedAccount> {
    const target = await this.ensurePlatformProjection(targetEmail)
    const workspaceId = personalWorkspaceIdFor(target.email)
    const platformUserId = requirePlatformUserId(target)
    const previousAuthRoles = splitAuthRoles(target.authRole)
    let authRoleChanged = false
    let membershipCreated = false
    try {
      if (!previousAuthRoles.includes('admin')) {
        await this.dependencies.auth.setLocalAuthRole(
          authorization,
          target.authUserId,
          toAuthRoleInput([...previousAuthRoles, 'admin']),
        )
        authRoleChanged = true
      }
      if (!hasPlatformRole(target, 'platform_admin')) {
        await this.dependencies.db.transaction(async tx => {
          await this.dependencies.workspaces.ensurePersonal({
            workspaceId,
            userId: platformUserId,
            displayName: target.displayName,
          }, tx)
          membershipCreated = await this.dependencies.memberships.insert({
            workspaceId,
            userId: platformUserId,
            role: 'platform_admin',
          }, tx)
        })
      }
      await this.audit(null, 'local_console.admin.grant', target.platformUserId, 'allowed', {
        targetEmail: target.email,
      })
      return this.requireAccount(target.email)
    } catch (error) {
      const compensationComplete = await runCompensations([
        ...(membershipCreated
          ? [() => this.dependencies.memberships.deleteRoleBinding({
            workspaceId,
            userId: platformUserId,
            role: 'platform_admin',
          })]
          : []),
        ...(authRoleChanged
          ? [() => this.dependencies.auth.setLocalAuthRole(
            authorization,
            target.authUserId,
            toAuthRoleInput(previousAuthRoles),
          )]
          : []),
      ])
      await this.audit(null, 'local_console.admin.grant', target.platformUserId, 'error', {
        targetEmail: target.email,
        compensationComplete,
      }).catch(() => undefined)
      throw new Error(compensationComplete
        ? '管理员授权失败；补偿操作已执行，请重新检查账户状态。'
        : '管理员授权失败且补偿未完整完成；请立即检查认证角色与平台角色。', { cause: error })
    }
  }

  revokePlatformAdmin(targetEmail: string): Promise<LocalManagedAccount> {
    return this.withAuthorization(authorization => this.revokePlatformAdminAuthorized(authorization, targetEmail))
  }

  private async revokePlatformAdminAuthorized(
    authorization: LocalConsoleAuthorization,
    targetEmail: string,
  ): Promise<LocalManagedAccount> {
    const target = await this.requireAccount(targetEmail)
    if (!target.platformUserId || !hasPlatformRole(target, 'platform_admin')) {
      throw new Error('目标账户不是平台管理员。')
    }
    await this.assertNotLastActiveAdmin(target)
    const previousAuthRoles = splitAuthRoles(target.authRole)
    let authRoleChanged = false
    let deletedMemberships: Array<{ membershipId: string; workspaceId: string }> = []
    let sessionsRevoked = false
    try {
      if (previousAuthRoles.includes('admin')) {
        await this.dependencies.auth.setLocalAuthRole(
          authorization,
          target.authUserId,
          toAuthRoleInput(previousAuthRoles.filter(role => role !== 'admin')),
        )
        authRoleChanged = true
      }
      deletedMemberships = await this.dependencies.db.transaction(tx =>
        this.dependencies.memberships.deleteRoleForUser(target.platformUserId!, 'platform_admin', tx))
      if (!deletedMemberships.length) throw new Error('平台管理员成员关系不存在。')
      await this.dependencies.auth.revokeLocalUserSessions(authorization, target.authUserId)
      sessionsRevoked = true
      await this.audit(null, 'local_console.admin.revoke', target.platformUserId, 'allowed', {
        targetEmail: target.email,
      })
      return this.requireAccount(target.email)
    } catch (error) {
      const compensationComplete = await runCompensations([
        ...(deletedMemberships.length
          ? [() => this.dependencies.db.transaction(async tx => {
          for (const membership of deletedMemberships) {
            await this.dependencies.memberships.insert({
              workspaceId: membership.workspaceId,
              userId: target.platformUserId!,
              role: 'platform_admin',
            }, tx)
          }
          })]
          : []),
        ...(authRoleChanged
          ? [() => this.dependencies.auth.setLocalAuthRole(
            authorization,
            target.authUserId,
            toAuthRoleInput(previousAuthRoles),
          )]
          : []),
      ])
      await this.audit(null, 'local_console.admin.revoke', target.platformUserId, 'error', {
        targetEmail: target.email,
        compensationComplete,
        sessionsRevoked,
      }).catch(() => undefined)
      throw new Error(compensationComplete
        ? `管理员撤销失败；补偿操作已执行，请重新检查认证角色与平台角色${sessionsRevoked ? '，目标账户的既有会话已安全撤销' : ''}。`
        : '管理员撤销失败且补偿未完整完成；请立即检查认证角色与平台角色。', { cause: error })
    }
  }

  setAccountEnabled(
    targetEmail: string,
    enabled: boolean,
  ): Promise<LocalManagedAccount> {
    return this.withAuthorization(authorization =>
      this.setAccountEnabledAuthorized(authorization, targetEmail, enabled))
  }

  private async setAccountEnabledAuthorized(
    authorization: LocalConsoleAuthorization,
    targetEmail: string,
    enabled: boolean,
  ): Promise<LocalManagedAccount> {
    const target = await this.requireAccount(targetEmail)
    const platformUserId = requirePlatformUserId(target)
    if (!enabled) await this.assertNotLastActiveAdmin(target)
    const previouslyBanned = target.banned
    const previousPlatformStatus = target.platformStatus
    let platformUpdated = false
    try {
      await this.dependencies.auth.setLocalUserBanned(authorization, target.authUserId, !enabled)
      const updated = await this.dependencies.users.update(platformUserId, {
        status: enabled ? 'active' : 'disabled',
      })
      if (!updated) throw new Error('平台用户不存在。')
      platformUpdated = true
      if (!enabled) {
        await this.dependencies.auth.revokeLocalUserSessions(authorization, target.authUserId)
      }
      await this.audit(null, enabled ? 'local_console.account.enable' : 'local_console.account.disable', platformUserId, 'allowed', {
        targetEmail: target.email,
      })
      return this.requireAccount(target.email)
    } catch (error) {
      const compensationComplete = await runCompensations([
        ...(platformUpdated && previousPlatformStatus
          ? [() => this.dependencies.users.update(platformUserId, { status: previousPlatformStatus })]
          : []),
        () => this.dependencies.auth.setLocalUserBanned(
          authorization,
          target.authUserId,
          previouslyBanned,
        ),
      ])
      await this.audit(null, enabled ? 'local_console.account.enable' : 'local_console.account.disable', platformUserId, 'error', {
        targetEmail: target.email,
        compensationComplete,
      }).catch(() => undefined)
      throw new Error(compensationComplete
        ? '账户状态更新失败；补偿操作已执行，请重新检查认证状态与平台状态。'
        : '账户状态更新失败且补偿未完整完成；请立即检查认证状态与平台状态。', { cause: error })
    }
  }

  resetPassword(
    targetEmail: string,
    newPassword: string,
  ): Promise<void> {
    return this.withAuthorization(authorization =>
      this.resetPasswordAuthorized(authorization, targetEmail, newPassword))
  }

  private async resetPasswordAuthorized(
    authorization: LocalConsoleAuthorization,
    targetEmail: string,
    newPassword: string,
  ): Promise<void> {
    this.assertPassword(newPassword)
    const target = await this.requireAccount(targetEmail)
    let passwordChanged = false
    try {
      await this.dependencies.auth.setLocalUserPassword(authorization, target.authUserId, newPassword)
      passwordChanged = true
      await this.dependencies.auth.revokeLocalUserSessions(authorization, target.authUserId)
      await this.audit(null, 'local_console.account.password_reset', target.platformUserId, 'allowed', {
        targetEmail: target.email,
      })
    } catch (error) {
      await this.audit(null, 'local_console.account.password_reset', target.platformUserId, 'error', {
        targetEmail: target.email,
        passwordChanged,
      }).catch(() => undefined)
      throw new Error(passwordChanged
        ? '密码已更新，但会话撤销或审计写入失败；请立即重试会话撤销并检查审计链路。'
        : 'Better Auth 密码重置失败。', { cause: error })
    }
  }

  revokeSessions(targetEmail: string): Promise<void> {
    return this.withAuthorization(authorization => this.revokeSessionsAuthorized(authorization, targetEmail))
  }

  private async revokeSessionsAuthorized(
    authorization: LocalConsoleAuthorization,
    targetEmail: string,
  ): Promise<void> {
    const target = await this.requireAccount(targetEmail)
    let sessionsRevoked = false
    try {
      await this.dependencies.auth.revokeLocalUserSessions(authorization, target.authUserId)
      sessionsRevoked = true
      await this.audit(null, 'local_console.account.sessions_revoke', target.platformUserId, 'allowed', {
        targetEmail: target.email,
      })
    } catch (error) {
      await this.audit(null, 'local_console.account.sessions_revoke', target.platformUserId, 'error', {
        targetEmail: target.email,
        sessionsRevoked,
      }).catch(() => undefined)
      throw new Error(sessionsRevoked
        ? '目标账户的登录会话已撤销，但审计事件写入失败；请立即检查数据库审计链路。'
        : 'Better Auth 未能撤销目标账户的登录会话。', { cause: error })
    }
  }

  private async ensurePlatformProjection(targetEmail: string): Promise<LocalManagedAccount> {
    let account = await this.requireAccount(targetEmail)
    if (account.platformUserId) return account
    await this.dependencies.identity.ensureProjection({
      platformUserId: platformUserIdFor(account.authUserId),
      authUserId: account.authUserId,
      email: account.email,
      displayName: account.displayName,
      personalWorkspaceId: personalWorkspaceIdFor(account.email),
      bootstrapAdmin: false,
    })
    account = await this.requireAccount(account.email)
    return account
  }

  private async requireAccount(email: string): Promise<LocalManagedAccount> {
    const normalized = emailSchema.parse(email)
    const account = await this.dependencies.accounts.getByEmail(normalized)
    if (!account) throw new Error('目标认证账户不存在。')
    return account
  }

  private async assertNotLastActiveAdmin(target: LocalManagedAccount): Promise<void> {
    if (
      target.platformStatus !== 'active'
      || target.banned
      || !hasAuthRole(target.authRole, 'admin')
      || !hasPlatformRole(target, 'platform_admin')
    ) return
    const activeAdminCount = await this.dependencies.accounts.countActivePlatformAdmins()
    if (activeAdminCount <= 1) throw new Error('不能禁用或撤销最后一个可用的平台管理员。')
  }

  private assertPassword(password: string): void {
    if (password.length < this.dependencies.minPasswordLength) {
      throw new Error(`密码至少需要 ${this.dependencies.minPasswordLength} 个字符。`)
    }
  }

  private withAuthorization<T>(
    action: (authorization: LocalConsoleAuthorization) => Promise<T>,
  ): Promise<T> {
    return this.dependencies.auth.withLocalConsoleAuthorization(this.dependencies.rootSecret, action)
  }

  private audit(
    actorUserId: string | null,
    action: string,
    objectId: string | null,
    outcome: 'allowed' | 'denied' | 'error',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return this.dependencies.audit.recordEvent({
      actorUserId,
      workspaceId: null,
      action,
      objectType: 'local_account',
      objectId,
      outcome,
      metadata: {
        source: 'local_console',
        osUser: this.dependencies.actor.osUser,
        hostname: this.dependencies.actor.hostname,
        processId: this.dependencies.actor.processId,
        authority: 'local_root',
        rootKeyVersion: this.dependencies.rootKeyVersion,
        ...metadata,
      },
    })
  }
}

function hasAuthRole(value: string, role: LocalAuthRole): boolean {
  return splitAuthRoles(value).includes(role)
}

function splitAuthRoles(value: string): LocalAuthRole[] {
  return [...new Set(value.split(',').map(item => {
    const role = item.trim()
    if (role === 'admin' || role === 'user') return role
    throw new Error(`Better Auth 账户包含不受支持的角色 '${role}'。`)
  }))]
}

function toAuthRoleInput(roles: LocalAuthRole[]): LocalAuthRole | LocalAuthRole[] {
  const normalized = [...new Set(roles)]
  if (normalized.length === 0) return 'user'
  return normalized.length === 1 ? normalized[0]! : normalized
}

function hasPlatformRole(account: LocalManagedAccount, role: string): boolean {
  return account.platformRoles.some(binding => binding.role === role)
}

function requirePlatformUserId(account: LocalManagedAccount): string {
  if (!account.platformUserId) throw new Error('认证账户尚未建立平台身份投影。')
  return account.platformUserId
}

async function runCompensations(steps: Array<() => Promise<unknown>>): Promise<boolean> {
  let complete = true
  for (const step of steps) {
    try {
      await step()
    } catch {
      complete = false
    }
  }
  return complete
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 平台身份投影应用服务
//
//   文件:       platformIdentityService.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//   来源:       platformIdentityStore.ts 的跨资源身份编排职责
// --------------------------------------------------------------------------

import type { PlatformUser } from '@geo-agent-platform/shared-types/platform'

import type { Database } from '../db/connection.js'
import type { AuthSessionRepository } from '../store/postgres/authSessionRepository.js'
import type { MembershipRepository } from '../store/postgres/membershipRepository.js'
import type { PlatformUserRepository } from '../store/postgres/platformUserRepository.js'
import type { WorkspaceRepository } from '../store/postgres/workspaceRepository.js'
import type { AuthRoleBinding } from './types.js'

export interface PlatformIdentityDependencies {
  db: Database
  users: Pick<PlatformUserRepository, 'upsertIdentityProjection' | 'getById' | 'getBySubject'>
  workspaces: Pick<WorkspaceRepository, 'ensurePersonal'>
  memberships: Pick<MembershipRepository, 'insert' | 'listRoleBindings'>
  authSessions: Pick<AuthSessionRepository, 'get' | 'revokeByAuthUserId'>
}

export interface EnsureIdentityProjectionInput {
  platformUserId: string
  authUserId: string
  email: string
  displayName: string
  personalWorkspaceId: string
  bootstrapAdmin: boolean
}

export interface IdentityProjectionResult {
  user: PlatformUser
  roles: AuthRoleBinding[]
}

/** 将 Better Auth 身份投影到平台用户和工作区，并原子建立首次成员关系。 */
export class PlatformIdentityService {
  constructor(private readonly dependencies: PlatformIdentityDependencies) {}

  ensureProjection(input: EnsureIdentityProjectionInput): Promise<IdentityProjectionResult> {
    return this.dependencies.db.transaction(async tx => {
      const { created, user } = await this.dependencies.users.upsertIdentityProjection({
        platformUserId: input.platformUserId,
        subject: input.authUserId,
        email: input.email,
        displayName: input.displayName,
      }, tx)
      if (user.status !== 'active') return { user, roles: [] }

      if (created || input.bootstrapAdmin) {
        await this.dependencies.workspaces.ensurePersonal({
          workspaceId: input.personalWorkspaceId,
          userId: user.userId,
          displayName: input.displayName,
        }, tx)
      }
      if (created) {
        await this.dependencies.memberships.insert({
          workspaceId: input.personalWorkspaceId,
          userId: user.userId,
          role: 'analyst',
        }, tx)
      }
      if (input.bootstrapAdmin) {
        for (const role of ['platform_admin', 'workspace_admin'] as const) {
          await this.dependencies.memberships.insert({
            workspaceId: input.personalWorkspaceId,
            userId: user.userId,
            role,
          }, tx)
        }
      }

      const roles = await this.dependencies.memberships.listRoleBindings(user.userId, tx)
      return { user, roles }
    })
  }

  getUser(userId: string): Promise<PlatformUser | null> {
    return this.dependencies.users.getById(userId)
  }

  listUserRoles(userId: string): Promise<AuthRoleBinding[]> {
    return this.dependencies.memberships.listRoleBindings(userId)
  }

  async isAuthSessionActive(authSessionId: string): Promise<boolean> {
    const session = await this.dependencies.authSessions.get(authSessionId)
    if (!session || session.expiresAt.getTime() <= Date.now()) return false
    const user = await this.dependencies.users.getBySubject(session.authUserId)
    return user?.status === 'active'
  }

  revokeAuthUserSessions(authUserId: string): Promise<void> {
    return this.dependencies.authSessions.revokeByAuthUserId(authUserId)
  }

  async revokePlatformUserSessions(platformUserId: string): Promise<void> {
    const user = await this.dependencies.users.getById(platformUserId)
    if (!user) return
    await this.dependencies.authSessions.revokeByAuthUserId(user.subject)
  }
}

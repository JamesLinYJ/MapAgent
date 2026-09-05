// +-------------------------------------------------------------------------
//
//   地理智能平台 - 安全后台应用服务
//
//   文件:       adminService.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  AdminMembership,
  AdminMembershipCreate,
  AdminUserPatch,
  AdminWorkspaceCreate,
  AuditEvent,
  PlatformUser,
  PlatformWorkspace,
  RbacPolicyRow,
} from '@geo-agent-platform/shared-types/platform'

import type { Database } from '../db/connection.js'
import type { AuditStore } from '../store/postgres/auditStore.js'
import type { MembershipRepository } from '../store/postgres/membershipRepository.js'
import type { PlatformUserRepository } from '../store/postgres/platformUserRepository.js'
import type { RbacPolicyReader } from '../store/postgres/rbacPolicyReader.js'
import type { WorkspaceRepository } from '../store/postgres/workspaceRepository.js'
import { makeId } from '../utils/ids.js'

export interface SecurityAdminDependencies {
  db: Database
  users: Pick<PlatformUserRepository, 'list' | 'update'>
  workspaces: Pick<WorkspaceRepository, 'listVisible' | 'insert'>
  memberships: Pick<MembershipRepository, 'listForWorkspace' | 'insert' | 'getWorkspaceId' | 'delete'>
  policies: Pick<RbacPolicyReader, 'list'>
  audit: Pick<AuditStore, 'listRecent'>
}

/** 安全后台用例边界；跨资源写入只在这里建立显式事务。 */
export class SecurityAdminService {
  constructor(private readonly dependencies: SecurityAdminDependencies) {}

  listUsers(): Promise<PlatformUser[]> {
    return this.dependencies.users.list()
  }

  updateUser(userId: string, fields: AdminUserPatch): Promise<boolean> {
    return this.dependencies.users.update(userId, fields)
  }

  listWorkspaces(input: { platformAdmin: boolean; userId: string }): Promise<PlatformWorkspace[]> {
    return this.dependencies.workspaces.listVisible(input)
  }

  createWorkspaceWithAdmin(
    input: AdminWorkspaceCreate & { createdByUserId: string },
  ): Promise<PlatformWorkspace> {
    const workspaceId = makeId('workspace')
    const createdAt = new Date()
    return this.dependencies.db.transaction(async tx => {
      const workspace = await this.dependencies.workspaces.insert(tx, {
        ...input,
        workspaceId,
        createdAt,
      })
      const membershipCreated = await this.dependencies.memberships.insert({
        workspaceId,
        userId: input.createdByUserId,
        role: 'workspace_admin',
      }, tx)
      if (!membershipCreated) throw new Error(`工作区 '${workspaceId}' 的管理员关系创建失败`)
      return workspace
    })
  }

  listMemberships(workspaceId: string): Promise<AdminMembership[]> {
    return this.dependencies.memberships.listForWorkspace(workspaceId)
  }

  addMembership(input: AdminMembershipCreate): Promise<boolean> {
    if ((input.role as string) === 'platform_admin') {
      throw new Error('平台管理员只能通过服务器本机运维台授予。')
    }
    return this.dependencies.memberships.insert(input)
  }

  getMembershipWorkspace(membershipId: string): Promise<string | null> {
    return this.dependencies.memberships.getWorkspaceId(membershipId)
  }

  deleteMembership(membershipId: string): Promise<boolean> {
    return this.dependencies.memberships.delete(membershipId)
  }

  listRoles(): Promise<RbacPolicyRow[]> {
    return this.dependencies.policies.list()
  }

  listAuditEvents(): Promise<AuditEvent[]> {
    return this.dependencies.audit.listRecent()
  }
}

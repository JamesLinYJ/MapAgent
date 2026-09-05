// +-------------------------------------------------------------------------
//
//   地理智能平台 - 认证与安全后台 API
//
//   文件:       authApi.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  adminMembershipSchema,
  adminMutationResultSchema,
  adminUserPatchSchema,
  auditEventSchema,
  platformUserSchema,
  platformWorkspaceSchema,
  rbacPolicyRowSchema,
  type AdminMembership,
  type AdminUserPatch,
  type AuditEvent,
  type PlatformRole,
  type PlatformUser,
  type PlatformWorkspace,
  type RbacPolicyRow,
} from '@geo-agent-platform/shared-types'
import { z } from 'zod'

import type { DesktopAuthProjection } from '../../contracts/desktopIpc'
import {
  getDesktopAuthProjection,
  signOutWithBetterAuth,
} from './authClient'
import { requestJson, setAuthProjection } from './transport'

const adminUserListSchema = z.array(platformUserSchema)
const adminWorkspaceListSchema = z.array(platformWorkspaceSchema)
const adminMembershipListSchema = z.array(adminMembershipSchema)
const rbacPolicyListSchema = z.array(rbacPolicyRowSchema)
const auditEventListSchema = z.array(auditEventSchema)

export async function logout(): Promise<void> {
  await signOutWithBetterAuth()
  setAuthProjection(null)
}

export async function getAuthProjection(): Promise<DesktopAuthProjection> {
  try {
    const auth = await getDesktopAuthProjection()
    setAuthProjection(auth)
    return auth
  } catch (error) {
    setAuthProjection(null)
    throw error
  }
}

export function listAdminUsers(): Promise<PlatformUser[]> {
  return requestJson('/api/v1/admin/users', undefined, 30_000, adminUserListSchema)
}

export function updateAdminUser(userId: string, payload: AdminUserPatch) {
  const body = adminUserPatchSchema.parse(payload)
  return requestJson(`/api/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }, 30_000, adminMutationResultSchema)
}

export function listAdminWorkspaces(): Promise<PlatformWorkspace[]> {
  return requestJson('/api/v1/admin/workspaces', undefined, 30_000, adminWorkspaceListSchema)
}

export function createAdminWorkspace(payload: { name: string; description?: string }): Promise<PlatformWorkspace> {
  return requestJson('/api/v1/admin/workspaces', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, 30_000, platformWorkspaceSchema)
}

export function listAdminMemberships(workspaceId?: string | null): Promise<AdminMembership[]> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''
  return requestJson(`/api/v1/admin/memberships${query}`, undefined, 30_000, adminMembershipListSchema)
}

export function createAdminMembership(payload: {
  workspaceId: string
  userId: string
  role: PlatformRole
}) {
  return requestJson('/api/v1/admin/memberships', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, 30_000, adminMutationResultSchema)
}

export function deleteAdminMembership(membershipId: string) {
  return requestJson(`/api/v1/admin/memberships/${encodeURIComponent(membershipId)}`, {
    method: 'DELETE',
  }, 30_000, adminMutationResultSchema)
}

export function listAdminRoles(): Promise<RbacPolicyRow[]> {
  return requestJson('/api/v1/admin/roles', undefined, 30_000, rbacPolicyListSchema)
}

export function listAuditEvents(): Promise<AuditEvent[]> {
  return requestJson('/api/v1/admin/audit-events', undefined, 30_000, auditEventListSchema)
}

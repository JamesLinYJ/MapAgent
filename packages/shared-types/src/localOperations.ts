// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机运维进程协议
//
//   文件:       localOperations.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'
import { auditEventSchema } from './platform.js'

export const localManagedAccountSchema = z.object({
  authUserId: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().min(1),
  authRole: z.string(),
  banned: z.boolean(),
  platformUserId: z.string().nullable(),
  platformStatus: z.enum(['active', 'disabled']).nullable(),
  platformRoles: z.array(z.object({
    workspaceId: z.string().min(1),
    role: z.string().min(1),
  })),
})

export type LocalManagedAccount = z.infer<typeof localManagedAccountSchema>

export const localOperationsRequestSchema = z.discriminatedUnion('operation', [
  z.object({ id: z.string().min(1), operation: z.literal('accounts.list') }),
  z.object({
    id: z.string().min(1),
    operation: z.literal('accounts.createPlatformAdmin'),
    input: z.object({
      email: z.string().email(),
      password: z.string().min(1),
      displayName: z.string().min(1),
    }),
  }),
  z.object({
    id: z.string().min(1),
    operation: z.enum([
      'accounts.grantPlatformAdmin',
      'accounts.revokePlatformAdmin',
      'accounts.revokeSessions',
    ]),
    email: z.string().email(),
  }),
  z.object({
    id: z.string().min(1),
    operation: z.literal('accounts.setEnabled'),
    email: z.string().email(),
    enabled: z.boolean(),
  }),
  z.object({
    id: z.string().min(1),
    operation: z.literal('accounts.resetPassword'),
    email: z.string().email(),
    password: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    operation: z.literal('audit.list'),
    limit: z.number().int().min(1).max(1_000),
  }),
  z.object({
    id: z.string().min(1),
    operation: z.literal('agent.close'),
    runId: z.string().nullable(),
    threadId: z.string().nullable(),
    outcome: z.enum(['allowed', 'error']),
  }),
  z.object({
    id: z.string().min(1),
    operation: z.literal('desktop.close'),
    outcome: z.enum(['allowed', 'error']),
  }),
])

export type LocalOperationsRequest = z.infer<typeof localOperationsRequestSchema>

export const localOperationsResponseSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
})

export const localAgentAuthorizationSchema = z.object({
  type: z.literal('agent.authorization'),
  appBaseUrl: z.string().url(),
  origin: z.string().url(),
  cookie: z.string().min(1),
  csrfToken: z.string().min(1),
  actor: z.object({
    osUser: z.string().min(1),
    hostname: z.string().min(1),
    processId: z.number().int().positive(),
    keyVersion: z.string().min(1),
  }),
})

export type LocalAgentAuthorization = z.infer<typeof localAgentAuthorizationSchema>

export const localDesktopAuthorizationSchema = z.object({
  type: z.literal('desktop.authorization'),
  appBaseUrl: z.string().url(),
  origin: z.string().url(),
  cookie: z.string().min(1),
  csrfToken: z.string().min(1),
  actor: z.object({
    osUser: z.string().min(1),
    hostname: z.string().min(1),
    processId: z.number().int().positive(),
    keyVersion: z.string().min(1),
  }),
})

export type LocalDesktopAuthorization = z.infer<typeof localDesktopAuthorizationSchema>

export const localAccountListResultSchema = z.array(localManagedAccountSchema)
export const localAccountResultSchema = localManagedAccountSchema
export const localAuditListResultSchema = z.array(auditEventSchema)

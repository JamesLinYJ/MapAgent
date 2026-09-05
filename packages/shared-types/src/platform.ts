// +-------------------------------------------------------------------------
//
//   地理智能平台 - 平台资源协议
//
//   文件:       platform.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 平台资源协议：身份、会话、线程、运行与气象数据索引。
import { z } from 'zod'
import { agentRuntimeConfigSchema } from './runtime.js'
import { agentStateSchema, runStatusSchema, toolValueRefSchema } from './core.js'
import { artifactDisplaySchema } from './map.js'
import { childRunForkModeSchema } from './childRun.js'

// --- Session / Thread / Run ---

export const platformRoleSchema = z.enum(['platform_admin', 'workspace_admin', 'analyst', 'viewer'])
export const workspaceMembershipRoleSchema = z.enum(['workspace_admin', 'analyst', 'viewer'])
export const resourceVisibilitySchema = z.enum(['private', 'workspace', 'public']).default('workspace')

export const platformUserSchema = z.object({
  userId: z.string(),
  subject: z.string(),
  email: z.string(),
  displayName: z.string(),
  status: z.enum(['active', 'disabled']).default('active'),
  lastLoginAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const platformWorkspaceSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().default(''),
  status: z.enum(['active', 'archived']).default('active'),
  createdByUserId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const platformMembershipSchema = z.object({
  membershipId: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  role: platformRoleSchema,
  createdAt: z.string(),
})

export const authMeSchema = z.object({
  user: platformUserSchema,
  defaultWorkspace: platformWorkspaceSchema.nullable().default(null),
  memberships: z.array(platformMembershipSchema).default([]),
  platformRoles: z.array(platformRoleSchema).default([]),
  csrfToken: z.string(),
  permissions: z.array(z.string()).default([]),
})

export const auditEventSchema = z.object({
  auditEventId: z.string(),
  actorUserId: z.string().nullable().default(null),
  workspaceId: z.string().nullable().default(null),
  action: z.string(),
  objectType: z.string(),
  objectId: z.string().nullable().default(null),
  outcome: z.enum(['allowed', 'denied', 'error']).default('allowed'),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
  createdAt: z.string(),
})

export const adminMembershipSchema = platformMembershipSchema.extend({
  email: z.string().email(),
  displayName: z.string(),
})

export const rbacPolicyRowSchema = z.object({
  ptype: z.string(),
  v0: z.string(),
  v1: z.string(),
  v2: z.string(),
  v3: z.string(),
  v4: z.string(),
  v5: z.string(),
})

export const adminUserPatchSchema = z.object({
  displayName: z.string().trim().min(1, '显示名称不能为空').max(120).optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).strict().refine(value => Object.keys(value).length > 0, {
  message: '至少提供一个要更新的用户字段',
})

export const adminWorkspaceCreateSchema = z.object({
  name: z.string().trim().min(1, '工作区名称不能为空').max(120),
  description: z.string().trim().max(1_000).default(''),
}).strict()

export const adminMembershipCreateSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  role: workspaceMembershipRoleSchema,
}).strict()

export const adminMutationResultSchema = z.object({
  updated: z.boolean().optional(),
  created: z.boolean().optional(),
  deleted: z.boolean().optional(),
}).strict()

export const sessionRecordSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  visibility: resourceVisibilitySchema,
  createdAt: z.string(),
  status: z.string().default('active'),
  latestThreadId: z.string().nullable().default(null),
  latestRunId: z.string().nullable().default(null),
  latestUploadedLayerKey: z.string().nullable().default(null),
  latestMeteorologicalDatasetId: z.string().nullable().default(null),
})

export const meteorologicalDatasetRecordSchema = z.object({
  datasetId: z.string(),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  visibility: resourceVisibilitySchema,
  sessionId: z.string(),
  threadId: z.string().nullable().default(null),
  filename: z.string(),
  originalFilename: z.string(),
  fileId: z.string().nullable().default(null),
  fileRelativePath: z.string(),
  sizeBytes: z.number().int().nonnegative().default(0),
  contentHash: z.string().nullable().default(null),
  mediaType: z.string().default('application/octet-stream'),
  status: z.string().default('ready'),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const meteorologicalJobRecordSchema = z.object({
  jobId: z.string(),
  datasetId: z.string(),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  sessionId: z.string(),
  threadId: z.string().nullable().default(null),
  kind: z.string(),
  status: z.string(),
  message: z.string().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).prefault({}),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().default(null),
})

export const agentThreadRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  visibility: resourceVisibilitySchema,
  title: z.string(),
  status: z.string().default('active'),
  createdAt: z.string(),
  updatedAt: z.string(),
  latestRunId: z.string().nullable().default(null),
  latestUserQuery: z.string().nullable().default(null),
  latestAssistantSummary: z.string().nullable().default(null),
  latestRunStatus: z.string().nullable().default(null),
  latestArtifactId: z.string().nullable().default(null),
  latestArtifactName: z.string().nullable().default(null),
  historyPreview: z.string().nullable().default(null),
  runCount: z.number().default(0),
  conversationPath: z.string().nullable().default(null),
})

export const analysisRunSchema = z.object({
  id: z.string(),
  runKind: z.enum(['root', 'child']).default('root'),
  rootRunId: z.string().nullable().default(null),
  parentRunId: z.string().nullable().default(null),
  parentTurnId: z.string().nullable().default(null),
  rootTurnId: z.string().nullable().default(null),
  spawnCallId: z.string().nullable().default(null),
  agentPath: z.string().default('/root'),
  taskName: z.string().nullable().default(null),
  agentRole: z.string().nullable().default(null),
  spawnDepth: z.number().int().nonnegative().default(0),
  forkMode: childRunForkModeSchema.default('none'),
  forkTurnCount: z.number().int().positive().nullable().default(null),
  modelOverride: z.string().nullable().default(null),
  reasoningOverride: z.string().nullable().default(null),
  maxModelTokens: z.number().int().positive().nullable().default(null),
  maxWallClockMs: z.number().int().positive().nullable().default(null),
  usedModelTokens: z.number().int().nonnegative().default(0),
  threadId: z.string().nullable().default(null),
  sessionId: z.string(),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  visibility: resourceVisibilitySchema,
  userQuery: z.string(),
  modelProvider: z.string().nullable().default(null),
  modelName: z.string().nullable().default(null),
  status: runStatusSchema.default('queued'),
  createdAt: z.string(),
  updatedAt: z.string(),
  state: agentStateSchema,
  conversationPath: z.string().nullable().default(null),
  // 运行时配置是跨进程持久化的事实，不接受 z.custom 这种无法验证结构的占位符。
  runtimeConfigSnapshot: agentRuntimeConfigSchema.nullable().default(null),
}).superRefine((run, context) => {
  if (run.runKind === 'root') {
    if (run.parentRunId || run.parentTurnId || run.spawnCallId || run.taskName || run.agentRole) {
      context.addIssue({ code: 'custom', path: ['runKind'], message: 'root Run 不能携带 child 身份字段' })
    }
    if (run.agentPath !== '/root' || run.spawnDepth !== 0 || run.forkMode !== 'none') {
      context.addIssue({ code: 'custom', path: ['agentPath'], message: 'root Run 必须使用根路径且不能 fork' })
    }
    return
  }
  const required = [
    ['rootRunId', run.rootRunId],
    ['parentRunId', run.parentRunId],
    ['parentTurnId', run.parentTurnId],
    ['rootTurnId', run.rootTurnId],
    ['spawnCallId', run.spawnCallId],
    ['taskName', run.taskName],
    ['agentRole', run.agentRole],
  ] as const
  for (const [field, value] of required) {
    if (!value) context.addIssue({ code: 'custom', path: [field], message: `child Run 缺少 ${field}` })
  }
  if (run.spawnDepth < 1 || !/^\/root(?:\/[a-z0-9_]+)+$/u.test(run.agentPath)) {
    context.addIssue({ code: 'custom', path: ['agentPath'], message: 'child Run 必须使用规范 agentPath 和正深度' })
  }
  if ((run.forkMode === 'last_n_turns') !== (run.forkTurnCount !== null)) {
    context.addIssue({ code: 'custom', path: ['forkTurnCount'], message: 'last_n_turns 必须独占 forkTurnCount' })
  }
})

export const directToolResultSchema = z.object({
  message: z.string(),
  payload: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
  resultId: z.string(),
  source: z.string(),
  valueRefs: z.array(toolValueRefSchema).optional(),
  artifacts: z.array(z.object({
    artifactId: z.string(),
    artifactType: z.string(),
    name: z.string(),
    uri: z.string(),
    display: artifactDisplaySchema,
    relativePath: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })).optional(),
  provenance: z.record(z.string(), z.unknown()).optional(),
})

export const directToolRunResponseSchema = z.object({
  result: directToolResultSchema,
  run: analysisRunSchema,
})

// 运行历史列表只传输稳定摘要，不把完整 AgentState、事件和消息带入列表请求。
export const runSummarySchema = z.object({
  id: z.string(),
  threadId: z.string().nullable().default(null),
  sessionId: z.string(),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  visibility: resourceVisibilitySchema,
  userQuery: z.string(),
  modelProvider: z.string().nullable().default(null),
  modelName: z.string().nullable().default(null),
  status: runStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  artifactCount: z.number().int().nonnegative().default(0),
  latestArtifactId: z.string().nullable().default(null),
  latestArtifactName: z.string().nullable().default(null),
})

export type PlatformRole = z.infer<typeof platformRoleSchema>
export type WorkspaceMembershipRole = z.infer<typeof workspaceMembershipRoleSchema>
export type ResourceVisibility = z.infer<typeof resourceVisibilitySchema>
export type PlatformUser = z.infer<typeof platformUserSchema>
export type PlatformWorkspace = z.infer<typeof platformWorkspaceSchema>
export type PlatformMembership = z.infer<typeof platformMembershipSchema>
export type AuthMe = z.infer<typeof authMeSchema>
export type AuditEvent = z.infer<typeof auditEventSchema>
export type AdminMembership = z.infer<typeof adminMembershipSchema>
export type RbacPolicyRow = z.infer<typeof rbacPolicyRowSchema>
export type AdminUserPatch = z.infer<typeof adminUserPatchSchema>
export type AdminWorkspaceCreate = z.infer<typeof adminWorkspaceCreateSchema>
export type AdminMembershipCreate = z.infer<typeof adminMembershipCreateSchema>
export type SessionRecord = z.infer<typeof sessionRecordSchema>
export type MeteorologicalDatasetRecord = z.infer<typeof meteorologicalDatasetRecordSchema>
export type MeteorologicalJobRecord = z.infer<typeof meteorologicalJobRecordSchema>
export type AgentThreadRecord = z.infer<typeof agentThreadRecordSchema>
export type AnalysisRun = z.infer<typeof analysisRunSchema>
export type DirectToolResult = z.infer<typeof directToolResultSchema>
export type DirectToolRunResponse = z.infer<typeof directToolRunResponseSchema>
export type RunSummary = z.infer<typeof runSummarySchema>
export type AgentExecutionMode = 'plan' | 'auto'

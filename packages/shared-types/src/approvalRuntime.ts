// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行审批动作与持久记录契约
//
//   文件:       approvalRuntime.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

import { agentToolEffectSchema, agentToolKindSchema } from './toolRuntime.js'

export const approvalActionKindSchema = z.enum([
  'world_write',
  'layer_delete',
  'file_write',
  'sandbox_command',
  'network_access',
  'mcp_tool_call',
  'external_publish',
  'automation_schedule',
  'child_run_spawn',
  'permission_request',
])

export const approvalDecisionScopeSchema = z.enum(['exact_call', 'session'])
export const approvalRecordStatusSchema = z.enum(['pending', 'resolved', 'consumed'])
export const approvalDecisionValueSchema = z.enum(['approved', 'rejected'])

export const approvalPermissionScopeSchema = z.object({
  requiredCapabilities: z.array(z.string().trim().min(1)),
  deniedReadResourceIds: z.array(z.string().trim().min(1)),
}).strict().superRefine((scope, context) => {
  assertUniqueSorted(scope.requiredCapabilities, 'requiredCapabilities', context)
  assertUniqueSorted(scope.deniedReadResourceIds, 'deniedReadResourceIds', context)
})

export const approvalActionSchema = z.object({
  kind: approvalActionKindSchema,
  workspaceId: z.string().trim().min(1),
  toolName: z.string().trim().min(1),
  toolKind: agentToolKindSchema,
  effect: agentToolEffectSchema,
  resourceIds: z.array(z.string().trim().min(1)),
  permissionScope: approvalPermissionScopeSchema,
  argsDigest: z.string().trim().min(1),
  contextDigest: z.string().trim().min(1),
}).strict().superRefine((action, context) => {
  assertUniqueSorted(action.resourceIds, 'resourceIds', context)
})

export const approvalDecisionInputSchema = z.object({
  decision: approvalDecisionValueSchema,
  scope: approvalDecisionScopeSchema,
  reason: z.string().trim().min(1).nullable().default(null),
}).strict().superRefine((decision, context) => {
  if (decision.decision === 'rejected' && decision.scope !== 'exact_call') {
    context.addIssue({
      code: 'custom',
      path: ['scope'],
      message: '拒绝决定只能绑定当前精确调用',
    })
  }
  if (decision.decision === 'rejected' && decision.reason === null) {
    context.addIssue({
      code: 'custom',
      path: ['reason'],
      message: '拒绝决定必须记录理由',
    })
  }
})

export const approvalRecordSchema = z.object({
  approvalId: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  invocationId: z.string().trim().min(1),
  callId: z.string().trim().min(1),
  stepId: z.string().trim().min(1),
  contextDigest: z.string().trim().min(1),
  actionKey: z.string().trim().min(1),
  action: approvalActionSchema,
  status: approvalRecordStatusSchema,
  decision: approvalDecisionValueSchema.nullable(),
  decisionScope: approvalDecisionScopeSchema.nullable(),
  decisionReason: z.string().trim().min(1).nullable(),
  decidedByUserId: z.string().trim().min(1).nullable(),
  sourceApprovalId: z.string().trim().min(1).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  resolvedAt: z.string().datetime({ offset: true }).nullable(),
  consumedAt: z.string().datetime({ offset: true }).nullable(),
  version: z.number().int().positive(),
}).strict().superRefine((record, context) => {
  if (record.workspaceId !== record.action.workspaceId) {
    context.addIssue({ code: 'custom', path: ['workspaceId'], message: '审批记录 workspaceId 必须绑定审批动作' })
  }
  if (record.contextDigest !== record.action.contextDigest) {
    context.addIssue({ code: 'custom', path: ['contextDigest'], message: '审批记录 contextDigest 必须绑定审批动作' })
  }
  if (record.status === 'pending') {
    if (record.decision !== null || record.decisionScope !== null || record.resolvedAt !== null || record.consumedAt !== null) {
      context.addIssue({ code: 'custom', path: ['status'], message: 'pending 审批不能提前携带决定或终态时间' })
    }
    return
  }
  if (record.decision === null || record.decisionScope === null || record.resolvedAt === null) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'resolved/consumed 审批必须携带决定、范围和 resolvedAt' })
  }
  if (record.decision === 'rejected') {
    if (record.decisionScope !== 'exact_call') {
      context.addIssue({ code: 'custom', path: ['decisionScope'], message: '拒绝决定只能绑定当前精确调用' })
    }
    if (record.decisionReason === null) {
      context.addIssue({ code: 'custom', path: ['decisionReason'], message: '拒绝决定必须记录理由' })
    }
  }
  if (record.status === 'resolved' && record.consumedAt !== null) {
    context.addIssue({ code: 'custom', path: ['consumedAt'], message: 'resolved 审批尚未被执行链消费' })
  }
  if (record.status === 'consumed' && record.consumedAt === null) {
    context.addIssue({ code: 'custom', path: ['consumedAt'], message: 'consumed 审批必须记录 consumedAt' })
  }
})

export type ApprovalActionKind = z.infer<typeof approvalActionKindSchema>
export type ApprovalDecisionScope = z.infer<typeof approvalDecisionScopeSchema>
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionInputSchema>
export type ApprovalPermissionScope = z.infer<typeof approvalPermissionScopeSchema>
export type ApprovalAction = z.infer<typeof approvalActionSchema>
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>

function assertUniqueSorted(values: string[], path: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', path: [path], message: `${path} 不能重复` })
  }
  const sorted = [...values].sort((left, right) => left.localeCompare(right))
  if (values.some((value, index) => value !== sorted[index])) {
    context.addIssue({ code: 'custom', path: [path], message: `${path} 必须按 canonical 顺序保存` })
  }
}

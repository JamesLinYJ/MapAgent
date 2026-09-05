// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久子运行与智能体邮箱契约
//
//   文件:       childRun.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

import { runStatusSchema } from './core.js'

export const childRunForkModeSchema = z.enum([
  'none',
  'full_history',
  'last_n_turns',
])

export const childRunBudgetSchema = z.object({
  maxModelTokens: z.number().int().positive().nullable(),
  maxWallClockMs: z.number().int().positive().nullable(),
  usedModelTokens: z.number().int().nonnegative(),
  startedAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict()

export const rootRunBudgetSchema = z.object({
  rootRunId: z.string().min(1),
  maxConcurrentChildren: z.number().int().positive(),
  maxSpawnDepth: z.number().int().nonnegative(),
  maxTotalChildren: z.number().int().positive(),
  maxTotalModelTokens: z.number().int().positive().nullable(),
  maxWallClockMs: z.number().int().positive().nullable(),
  totalChildren: z.number().int().nonnegative(),
  activeChildren: z.number().int().nonnegative(),
  usedModelTokens: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  startedAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict().superRefine((budget, context) => {
  if (budget.activeChildren > budget.totalChildren) {
    context.addIssue({
      code: 'custom',
      path: ['activeChildren'],
      message: '活动 child 数不能大于累计 child 数',
    })
  }
  if (budget.totalChildren > budget.maxTotalChildren) {
    context.addIssue({
      code: 'custom',
      path: ['totalChildren'],
      message: '累计 child 数不能超过根预算',
    })
  }
  if (budget.activeChildren > budget.maxConcurrentChildren) {
    context.addIssue({
      code: 'custom',
      path: ['activeChildren'],
      message: '活动 child 数不能超过并发预算',
    })
  }
})

export const childRunDescriptorSchema = z.object({
  runId: z.string().min(1),
  rootRunId: z.string().min(1),
  parentRunId: z.string().min(1),
  parentTurnId: z.string().min(1),
  rootTurnId: z.string().min(1),
  spawnCallId: z.string().min(1),
  agentPath: z.string().regex(/^\/root(?:\/[a-z0-9_]+)+$/u),
  taskName: z.string().regex(/^[a-z0-9_]+$/u),
  role: z.string().min(1),
  status: runStatusSchema,
  spawnDepth: z.number().int().positive(),
  forkMode: childRunForkModeSchema,
  forkTurnCount: z.number().int().positive().nullable(),
  modelOverride: z.string().min(1).nullable(),
  reasoningOverride: z.string().min(1).nullable(),
  budget: childRunBudgetSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict().superRefine((descriptor, context) => {
  if (descriptor.runId === descriptor.parentRunId) {
    context.addIssue({ code: 'custom', path: ['parentRunId'], message: 'child Run 不能以自身为父 Run' })
  }
  if ((descriptor.forkMode === 'last_n_turns') !== (descriptor.forkTurnCount !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['forkTurnCount'],
      message: '只有 last_n_turns fork 必须提供 forkTurnCount',
    })
  }
})

export const agentMessageKindSchema = z.enum(['input', 'message', 'completion'])
export const agentMessageStatusSchema = z.enum(['queued', 'delivered', 'checkpointed'])

export const agentMessageSchema = z.object({
  messageId: z.string().min(1),
  rootRunId: z.string().min(1),
  senderRunId: z.string().min(1),
  receiverRunId: z.string().min(1),
  parentTurnId: z.string().min(1),
  rootTurnId: z.string().min(1),
  sequence: z.number().int().positive(),
  kind: agentMessageKindSchema,
  content: z.string().min(1),
  triggerTurn: z.boolean(),
  status: agentMessageStatusSchema,
  createdAt: z.string().min(1),
  deliveredAt: z.string().min(1).nullable(),
  checkpointedAt: z.string().min(1).nullable(),
}).strict().superRefine((message, context) => {
  if (message.senderRunId === message.receiverRunId) {
    context.addIssue({ code: 'custom', path: ['receiverRunId'], message: '智能体消息不能发送给自身' })
  }
  if (message.status === 'queued' && (message.deliveredAt || message.checkpointedAt)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'queued 消息不能已有交付时间' })
  }
  if (message.status === 'delivered' && (!message.deliveredAt || message.checkpointedAt)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'delivered 消息必须只有交付时间' })
  }
  if (message.status === 'checkpointed' && (!message.deliveredAt || !message.checkpointedAt)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'checkpointed 消息必须有完整交付时间' })
  }
})

export type ChildRunForkMode = z.infer<typeof childRunForkModeSchema>
export type ChildRunBudget = z.infer<typeof childRunBudgetSchema>
export type RootRunBudget = z.infer<typeof rootRunBudgetSchema>
export type ChildRunDescriptor = z.infer<typeof childRunDescriptorSchema>
export type AgentMessageKind = z.infer<typeof agentMessageKindSchema>
export type AgentMessageStatus = z.infer<typeof agentMessageStatusSchema>
export type AgentMessage = z.infer<typeof agentMessageSchema>

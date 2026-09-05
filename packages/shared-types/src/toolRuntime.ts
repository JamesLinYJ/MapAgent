// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 工具目录、计划与调用账本契约
//
//   文件:       toolRuntime.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

export const agentToolKindSchema = z.enum([
  'platform',
  'subagent',
  'handoff',
  'mcp',
  'hosted',
  'sandbox',
])

export const agentToolExposureSchema = z.enum([
  'immediate',
  'deferred',
  'hidden',
  'plan_readonly',
])

export const agentToolEffectSchema = z.enum([
  'read',
  'world_write',
  'external_write',
  'destructive',
])

export const agentToolParallelismSchema = z.enum(['shared', 'exclusive'])
export const agentToolReplayPolicySchema = z.enum(['safe', 'idempotency_key', 'manual_recovery'])
export const agentToolExecutionSurfaceSchema = z.enum(['agent', 'automation', 'developer'])

const agentToolDescriptorShape = {
  name: z.string().trim().min(1),
  namespace: z.string().trim().min(1),
  providerId: z.string().trim().min(1).nullable(),
  schemaDigest: z.string().trim().min(1),
  exposure: agentToolExposureSchema,
  effect: agentToolEffectSchema,
  parallelism: agentToolParallelismSchema,
  approvalAction: z.string().trim().min(1).nullable(),
  replayPolicy: agentToolReplayPolicySchema,
  requiredCapabilities: z.array(z.string().trim().min(1)),
  requiredValueRefKinds: z.array(z.string().trim().min(1)),
  executionSurfaces: z.array(agentToolExecutionSurfaceSchema).min(1),
} as const

export const agentToolDescriptorSchema = z.object(agentToolDescriptorShape)
  .strict()
  .superRefine(refineToolDescriptor)

export const agentToolDescriptorSourceSchema = z.object({
  name: agentToolDescriptorShape.name,
  namespace: agentToolDescriptorShape.namespace,
  providerId: agentToolDescriptorShape.providerId,
  kind: agentToolKindSchema,
  exposure: agentToolDescriptorShape.exposure,
  effect: agentToolDescriptorShape.effect,
  parallelism: agentToolDescriptorShape.parallelism,
  approvalAction: agentToolDescriptorShape.approvalAction,
  replayPolicy: agentToolDescriptorShape.replayPolicy,
  requiredCapabilities: agentToolDescriptorShape.requiredCapabilities,
  requiredValueRefKinds: agentToolDescriptorShape.requiredValueRefKinds,
  executionSurfaces: agentToolDescriptorShape.executionSurfaces,
}).strict().superRefine(refineToolDescriptor)

function refineToolDescriptor(
  descriptor: {
    requiredCapabilities: string[]
    requiredValueRefKinds: string[]
    executionSurfaces: string[]
    parallelism: z.infer<typeof agentToolParallelismSchema>
    effect: z.infer<typeof agentToolEffectSchema>
    approvalAction: string | null
  },
  context: z.RefinementCtx,
): void {
  assertUnique(descriptor.requiredCapabilities, 'requiredCapabilities', context)
  assertUnique(descriptor.requiredValueRefKinds, 'requiredValueRefKinds', context)
  assertUnique(descriptor.executionSurfaces, 'executionSurfaces', context)
  if (descriptor.parallelism === 'shared' && descriptor.effect !== 'read') {
    context.addIssue({
      code: 'custom',
      path: ['parallelism'],
      message: '只有无副作用读取工具可以进入 shared 通道',
    })
  }
  if (descriptor.parallelism === 'shared' && descriptor.approvalAction !== null) {
    context.addIssue({
      code: 'custom',
      path: ['approvalAction'],
      message: '需要审批的工具不能进入 shared 通道',
    })
  }
  if (descriptor.effect === 'destructive' && descriptor.approvalAction === null) {
    context.addIssue({
      code: 'custom',
      path: ['approvalAction'],
      message: '破坏性工具必须声明审批动作',
    })
  }
}

export const agentToolPlanEntrySchema = agentToolDescriptorSchema.safeExtend({
  kind: agentToolKindSchema,
  definitionDigest: z.string().trim().min(1),
  deferLoading: z.boolean(),
}).strict()

export const agentToolNamespaceSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  toolNames: z.array(z.string().trim().min(1)).min(1),
  deferred: z.boolean(),
}).strict().superRefine((namespace, context) => {
  assertUnique(namespace.toolNames, 'toolNames', context)
})

export const agentToolPlanSnapshotSchema = z.object({
  entries: z.array(agentToolPlanEntrySchema),
  namespaces: z.array(agentToolNamespaceSchema),
  deferredCatalogObjectHash: z.string().trim().min(1).nullable(),
  unavailableReasons: z.record(z.string().trim().min(1), z.string().trim().min(1)),
  catalogDigest: z.string().trim().min(1),
}).strict().superRefine((plan, context) => {
  assertUnique(plan.entries.map(entry => entry.name), 'entries', context)
  assertUnique(plan.namespaces.map(namespace => namespace.name), 'namespaces', context)
  const plannedNames = new Set(plan.entries.map(entry => entry.name))
  const namespaceMembers = new Set<string>()
  for (const [index, namespace] of plan.namespaces.entries()) {
    for (const toolName of namespace.toolNames) {
      if (!plannedNames.has(toolName)) {
        context.addIssue({
          code: 'custom',
          path: ['namespaces', index, 'toolNames'],
          message: `命名空间引用了未计划工具 '${toolName}'`,
        })
      }
      if (namespaceMembers.has(toolName)) {
        context.addIssue({
          code: 'custom',
          path: ['namespaces', index, 'toolNames'],
          message: `工具 '${toolName}' 不能同时属于多个命名空间`,
        })
      }
      namespaceMembers.add(toolName)
    }
  }
  const deferredNames = plan.entries.filter(entry => entry.deferLoading).map(entry => entry.name)
  if ((deferredNames.length > 0) !== (plan.deferredCatalogObjectHash !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['deferredCatalogObjectHash'],
      message: 'deferred catalog hash 必须与延迟工具集合同时存在或同时为空',
    })
  }
})

export const toolInvocationStatusSchema = z.enum([
  'prepared',
  'running',
  'succeeded',
  'failed',
  'rejected',
  'aborted',
  'checkpointed',
])

export const toolInvocationKindSchema = z.union([
  agentToolKindSchema,
  z.literal('unavailable'),
])

export const toolInvocationTerminalOutcomeSchema = z.enum([
  'succeeded',
  'failed',
  'rejected',
  'aborted',
])

export const toolInvocationRecordSchema = z.object({
  invocationId: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  turnId: z.string().trim().min(1),
  callId: z.string().trim().min(1),
  stepId: z.string().trim().min(1).nullable(),
  toolName: z.string().trim().min(1),
  toolKind: toolInvocationKindSchema,
  executionSurface: agentToolExecutionSurfaceSchema,
  objectiveRevision: z.number().int().positive(),
  toolPlanDigest: z.string().trim().min(1),
  descriptorDigest: z.string().trim().min(1),
  argsDigest: z.string().trim().min(1),
  effect: agentToolEffectSchema,
  replayPolicy: agentToolReplayPolicySchema,
  idempotencyKey: z.string().trim().min(1).nullable(),
  approvalAction: z.string().trim().min(1).nullable(),
  approvalDecision: z.enum(['not_required', 'approved', 'rejected']).nullable(),
  status: toolInvocationStatusSchema,
  terminalOutcome: toolInvocationTerminalOutcomeSchema.nullable(),
  resultId: z.string().trim().min(1).nullable(),
  error: z.string().trim().min(1).nullable(),
  preparedAt: z.string().datetime({ offset: true }),
  runningAt: z.string().datetime({ offset: true }).nullable(),
  terminalAt: z.string().datetime({ offset: true }).nullable(),
  checkpointedAt: z.string().datetime({ offset: true }).nullable(),
  version: z.number().int().positive(),
}).strict().superRefine((invocation, context) => {
  if (invocation.status === 'prepared') {
    requireInvocationState(invocation, context, {
      running: false,
      terminal: false,
      checkpointed: false,
      outcome: null,
    })
  } else if (invocation.status === 'running') {
    requireInvocationState(invocation, context, {
      running: true,
      terminal: false,
      checkpointed: false,
      outcome: null,
    })
  } else if (invocation.status === 'checkpointed') {
    requireInvocationState(invocation, context, {
      running: invocation.terminalOutcome === 'succeeded' || invocation.runningAt !== null,
      terminal: true,
      checkpointed: true,
      outcome: invocation.terminalOutcome,
    })
  } else {
    requireInvocationState(invocation, context, {
      running: invocation.status === 'succeeded' || invocation.runningAt !== null,
      terminal: true,
      checkpointed: false,
      outcome: invocation.status,
    })
  }
  if (invocation.terminalOutcome === 'succeeded' && invocation.error !== null) {
    context.addIssue({ code: 'custom', path: ['error'], message: '成功调用不能包含 error' })
  }
  if (
    invocation.terminalOutcome !== null
    && invocation.terminalOutcome !== 'succeeded'
    && invocation.error === null
  ) {
    context.addIssue({ code: 'custom', path: ['error'], message: '非成功终态必须包含 error' })
  }
})

export type AgentToolKind = z.infer<typeof agentToolKindSchema>
export type AgentToolExposure = z.infer<typeof agentToolExposureSchema>
export type AgentToolEffect = z.infer<typeof agentToolEffectSchema>
export type AgentToolParallelism = z.infer<typeof agentToolParallelismSchema>
export type AgentToolReplayPolicy = z.infer<typeof agentToolReplayPolicySchema>
export type AgentToolExecutionSurface = z.infer<typeof agentToolExecutionSurfaceSchema>
export type AgentToolDescriptor = z.infer<typeof agentToolDescriptorSchema>
export type AgentToolDescriptorSource = z.infer<typeof agentToolDescriptorSourceSchema>
export type AgentToolPlanEntry = z.infer<typeof agentToolPlanEntrySchema>
export type AgentToolNamespace = z.infer<typeof agentToolNamespaceSchema>
export type AgentToolPlanSnapshot = z.infer<typeof agentToolPlanSnapshotSchema>
export type ToolInvocationStatus = z.infer<typeof toolInvocationStatusSchema>
export type ToolInvocationKind = z.infer<typeof toolInvocationKindSchema>
export type ToolInvocationTerminalOutcome = z.infer<typeof toolInvocationTerminalOutcomeSchema>
export type ToolInvocationRecord = z.infer<typeof toolInvocationRecordSchema>

function requireInvocationState(
  invocation: z.infer<typeof toolInvocationRecordSchema>,
  context: z.RefinementCtx,
  expected: {
    running: boolean
    terminal: boolean
    checkpointed: boolean
    outcome: z.infer<typeof toolInvocationTerminalOutcomeSchema> | null
  },
): void {
  const fields = [
    ['runningAt', invocation.runningAt !== null, expected.running],
    ['terminalAt', invocation.terminalAt !== null, expected.terminal],
    ['checkpointedAt', invocation.checkpointedAt !== null, expected.checkpointed],
  ] as const
  for (const [path, actual, wanted] of fields) {
    if (actual !== wanted) {
      context.addIssue({
        code: 'custom',
        path: [path],
        message: `${path} 与调用状态 '${invocation.status}' 不一致`,
      })
    }
  }
  if (invocation.terminalOutcome !== expected.outcome) {
    context.addIssue({
      code: 'custom',
      path: ['terminalOutcome'],
      message: `terminalOutcome 与调用状态 '${invocation.status}' 不一致`,
    })
  }
}

function assertUnique(
  values: readonly string[],
  path: string,
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', path: [path], message: `${path} 不能包含重复值` })
  }
}

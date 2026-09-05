// +-------------------------------------------------------------------------
//
//   地理智能平台 - Run 领域日志契约与纯函数 Reducer
//
//   文件:       runDomain.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

import {
  agentStateSchema,
  runStatusSchema,
  type AgentState,
} from './core.js'

export const RUN_DOMAIN_EVENT_SCHEMA_VERSION = 1 as const
export const RUN_DOMAIN_SNAPSHOT_SCHEMA_VERSION = 1 as const

export const runDomainActorSchema = z.object({
  kind: z.enum(['user', 'agent', 'system', 'tool']),
  id: z.string().min(1).nullable(),
}).strict()

const agentStateFieldNames = Object.keys(agentStateSchema.shape) as [
  keyof AgentState & string,
  ...(keyof AgentState & string)[],
]

export const agentStateFieldSchema = z.enum(agentStateFieldNames)

// Zod object.partial() 会重新应用子 schema 的 default，不能表达精确 patch。
// 字段变更用可辨识的 field/value 序列表达，并依据 AgentState 原 schema
// 校验每个 value，避免 shadow journal 变成宽松 JSON patch。
export const agentStateFieldChangeSchema = z.object({
  field: agentStateFieldSchema,
  value: z.unknown(),
}).strict().superRefine((change, context) => {
  const fieldSchema = agentStateSchema.shape[change.field]
  const parsed = fieldSchema.safeParse(change.value)
  if (parsed.success) return
  for (const issue of parsed.error.issues) {
    context.addIssue({
      code: 'custom',
      path: ['value', ...issue.path],
      message: issue.message,
    })
  }
})

export const runDomainInputDeliverySchema = z.object({
  inputId: z.string().min(1),
  inputSequence: z.number().int().positive(),
  status: z.enum(['queued', 'leased', 'included', 'checkpointed']),
  leaseId: z.string().min(1).nullable(),
  modelRequestId: z.string().min(1).nullable(),
}).strict()

export const runDomainCheckpointSchema = z.object({
  activeEntryId: z.string().min(1).nullable(),
  pendingToolCallIds: z.array(z.string().min(1)),
  recoveryStatus: z.string().min(1),
  orchestrationEngine: z.string().min(1).nullable(),
  sdkStateContentHash: z.string().min(1).nullable(),
  agentsSdkVersion: z.string().min(1).nullable(),
  runtimeConfigDigest: z.string().min(1).nullable(),
  sdkStateSchemaVersion: z.number().int().positive().nullable(),
  sdkStateUpdatedAt: z.string().nullable(),
  nextInputSequence: z.number().int().positive(),
  checkpointInputCursor: z.number().int().nonnegative(),
  activeInputLeaseId: z.string().min(1).nullable(),
  activeInputLeaseFrom: z.number().int().positive().nullable(),
  activeInputLeaseTo: z.number().int().positive().nullable(),
  terminalInputClaimId: z.string().min(1).nullable(),
  terminalObjectiveRevision: z.number().int().positive().nullable(),
  terminalInputCursor: z.number().int().nonnegative().nullable(),
  terminalClaimedAt: z.string().nullable(),
}).strict().superRefine((checkpoint, context) => {
  const hasLease = checkpoint.activeInputLeaseId !== null
  const hasLeaseRange = checkpoint.activeInputLeaseFrom !== null
    && checkpoint.activeInputLeaseTo !== null
  if (hasLease !== hasLeaseRange) {
    context.addIssue({
      code: 'custom',
      path: ['activeInputLeaseId'],
      message: '活动输入 lease 与范围必须同时存在或同时为空',
    })
    return
  }
  if (
    hasLeaseRange
    && (
      checkpoint.activeInputLeaseFrom !== checkpoint.checkpointInputCursor + 1
      || checkpoint.activeInputLeaseTo! < checkpoint.activeInputLeaseFrom!
      || checkpoint.activeInputLeaseTo! >= checkpoint.nextInputSequence
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['activeInputLeaseFrom'],
      message: '活动输入 lease 范围必须紧接 checkpoint 游标且位于已分配输入内',
    })
  }
})

const runDomainEnvelopeShape = {
  eventId: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  turnId: z.string().min(1).nullable(),
  stepId: z.string().min(1).nullable(),
  objectiveRevision: z.number().int().positive(),
  causationId: z.string().min(1).nullable(),
  correlationId: z.string().min(1),
  actor: runDomainActorSchema,
  occurredAt: z.string().min(1),
  schemaVersion: z.literal(RUN_DOMAIN_EVENT_SCHEMA_VERSION),
}

const runCreatedEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('run.created'),
  payload: z.object({
    status: runStatusSchema,
    state: agentStateSchema,
  }).strict(),
}).strict()

const runStatusChangedEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('run.status_changed'),
  payload: z.object({
    status: runStatusSchema,
    reason: z.string().min(1),
  }).strict(),
}).strict()

const runStateChangedEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('run.state_changed'),
  payload: z.object({
    reason: z.string().min(1),
    changes: z.array(agentStateFieldChangeSchema).min(1),
  }).strict(),
}).strict()

const toolSucceededEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('tool.succeeded'),
  payload: z.object({
    resultId: z.string().min(1),
    changes: z.array(agentStateFieldChangeSchema),
  }).strict(),
}).strict()

function inputTransitionEventSchema<
  TType extends 'input.queued' | 'input.leased' | 'input.included' | 'input.checkpointed' | 'input.requeued',
  TStatus extends 'queued' | 'leased' | 'included' | 'checkpointed',
>(type: TType, status: TStatus) {
  return z.object({
    ...runDomainEnvelopeShape,
    type: z.literal(type),
    payload: z.object({
      inputs: z.array(runDomainInputDeliverySchema.extend({ status: z.literal(status) }).strict()).min(1),
    }).strict(),
  }).strict()
}

const runCheckpointChangedEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('run.checkpoint_changed'),
  payload: z.object({ checkpoint: runDomainCheckpointSchema }).strict(),
}).strict()

const projectionWarningEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('projection.warning'),
  payload: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }).strict(),
}).strict()

const modelRequestCommittedEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('step.model_request_committed'),
  payload: z.object({
    requestId: z.string().min(1),
    stepId: z.string().min(1),
    inputObjectHash: z.string().regex(/^[a-f0-9]{64}$/u),
    inputEntryIds: z.array(z.string().min(1)),
  }).strict(),
}).strict()

const modelRequestCheckpointedEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('step.model_request_checkpointed'),
  payload: z.object({
    requestId: z.string().min(1),
    stepId: z.string().min(1),
  }).strict(),
}).strict()

const contextWindowStartedEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('context.window_started'),
  payload: z.object({
    contextWindowId: z.string().min(1),
    generation: z.number().int().positive(),
    promptProtocolVersion: z.string().min(1),
    sourceDigest: z.string().min(1),
  }).strict(),
}).strict()

const contextCompactedEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('context.compacted'),
  payload: z.object({
    contextWindowId: z.string().min(1),
    generation: z.number().int().positive(),
    sourceDigest: z.string().min(1),
    summaryObjectHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)),
    promptVersion: z.string().min(1),
  }).strict(),
}).strict()

const contextRolloverEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('context.rollover'),
  payload: z.object({
    previousContextWindowId: z.string().min(1),
    contextWindowId: z.string().min(1),
    generation: z.number().int().positive(),
    reason: z.enum(['compaction', 'hard_limit', 'manual']),
  }).strict(),
}).strict()

const terminalClaimedEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('terminal.claimed'),
  payload: z.object({
    claimId: z.string().min(1),
    objectiveRevision: z.number().int().positive(),
    inputCursor: z.number().int().nonnegative(),
  }).strict(),
}).strict()

const terminalCandidateSupersededEventSchema = z.object({
  ...runDomainEnvelopeShape,
  type: z.literal('terminal.candidate_superseded'),
  payload: z.object({
    objectiveRevision: z.number().int().positive(),
    inputCursor: z.number().int().nonnegative(),
    durableObjectiveRevision: z.number().int().positive(),
    durableInputCursor: z.number().int().nonnegative(),
  }).strict(),
}).strict()

export const runDomainEventSchema = z.discriminatedUnion('type', [
  runCreatedEventSchema,
  runStatusChangedEventSchema,
  runStateChangedEventSchema,
  toolSucceededEventSchema,
  inputTransitionEventSchema('input.queued', 'queued'),
  inputTransitionEventSchema('input.leased', 'leased'),
  inputTransitionEventSchema('input.included', 'included'),
  inputTransitionEventSchema('input.checkpointed', 'checkpointed'),
  inputTransitionEventSchema('input.requeued', 'queued'),
  modelRequestCommittedEventSchema,
  modelRequestCheckpointedEventSchema,
  contextWindowStartedEventSchema,
  contextCompactedEventSchema,
  contextRolloverEventSchema,
  terminalClaimedEventSchema,
  terminalCandidateSupersededEventSchema,
  runCheckpointChangedEventSchema,
  projectionWarningEventSchema,
])

export const runDomainSnapshotSchema = z.object({
  schemaVersion: z.literal(RUN_DOMAIN_SNAPSHOT_SCHEMA_VERSION),
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  status: runStatusSchema,
  state: agentStateSchema,
  inputDeliveries: z.record(z.string(), runDomainInputDeliverySchema),
  activeModelRequestId: z.string().min(1).nullable().default(null),
  contextWindowId: z.string().min(1).nullable().default(null),
  contextWindowGeneration: z.number().int().nonnegative().default(0),
  checkpoint: runDomainCheckpointSchema.nullable(),
  updatedAt: z.string().min(1),
}).strict()

export const runDomainProjectionInspectionReasonSchema = z.enum([
  'verified',
  'missing_snapshot',
  'missing_events',
  'sequence',
  'snapshot',
  'run',
  'checkpoint',
  'input',
  'schema',
])

export const runDomainProjectionInspectionSchema = z.object({
  runId: z.string().min(1),
  status: z.enum(['verified', 'failed']),
  reason: runDomainProjectionInspectionReasonSchema,
  sourceSequence: z.number().int().nonnegative(),
  snapshotSequence: z.number().int().nonnegative().nullable(),
  sequenceDistance: z.number().int().nonnegative(),
  details: z.array(z.string()),
}).strict().superRefine((inspection, context) => {
  const expectedReason = inspection.status === 'verified' ? 'verified' : null
  if (expectedReason && inspection.reason !== expectedReason) {
    context.addIssue({
      code: 'custom',
      path: ['reason'],
      message: `status '${inspection.status}' 必须使用 reason '${expectedReason}'`,
    })
  }
  if (!expectedReason && inspection.reason === 'verified') {
    context.addIssue({
      code: 'custom',
      path: ['reason'],
      message: `failed inspection 不能使用 reason '${inspection.reason}'`,
    })
  }
  if (inspection.status === 'verified' && inspection.snapshotSequence === null) {
    context.addIssue({
      code: 'custom',
      path: ['snapshotSequence'],
      message: 'verified inspection 必须包含 snapshotSequence',
    })
  }
  const expectedDistance = Math.abs(
    inspection.sourceSequence - (inspection.snapshotSequence ?? 0),
  )
  if (inspection.sequenceDistance !== expectedDistance) {
    context.addIssue({
      code: 'custom',
      path: ['sequenceDistance'],
      message: `sequenceDistance 应为 ${expectedDistance}`,
    })
  }
  if (inspection.status === 'failed' && inspection.details.length === 0) {
    context.addIssue({ code: 'custom', path: ['details'], message: 'failed inspection 必须提供详情' })
  }
  if (inspection.status !== 'failed' && inspection.details.length > 0) {
    context.addIssue({ code: 'custom', path: ['details'], message: '非失败结果不得携带错误详情' })
  }
})

export type AgentStateField = z.infer<typeof agentStateFieldSchema>
export type AgentStateFieldChange = {
  [K in keyof AgentState]: { field: K; value: AgentState[K] }
}[keyof AgentState]
export type RunDomainInputDelivery = z.infer<typeof runDomainInputDeliverySchema>
export type RunDomainCheckpoint = z.infer<typeof runDomainCheckpointSchema>
export type RunDomainEvent = z.infer<typeof runDomainEventSchema>
export type RunDomainSnapshot = z.infer<typeof runDomainSnapshotSchema>
export type RunDomainProjectionInspectionReason = z.infer<
  typeof runDomainProjectionInspectionReasonSchema
>
export type RunDomainProjectionInspection = z.infer<typeof runDomainProjectionInspectionSchema>

export function reduceRunDomainEvent(
  current: RunDomainSnapshot | null,
  rawEvent: RunDomainEvent,
): RunDomainSnapshot {
  const event = runDomainEventSchema.parse(rawEvent)
  if (!current) {
    if (event.sequence !== 1 || event.type !== 'run.created') {
      throw new Error(`Run '${event.runId}' 的领域日志必须从 sequence 1 的 run.created 开始`)
    }
    return runDomainSnapshotSchema.parse({
      schemaVersion: RUN_DOMAIN_SNAPSHOT_SCHEMA_VERSION,
      runId: event.runId,
      sequence: event.sequence,
      status: event.payload.status,
      state: event.payload.state,
      inputDeliveries: {},
      activeModelRequestId: null,
      contextWindowId: null,
      contextWindowGeneration: 0,
      checkpoint: null,
      updatedAt: event.occurredAt,
    })
  }

  const snapshot = runDomainSnapshotSchema.parse(current)
  if (event.runId !== snapshot.runId) {
    throw new Error(`Run 领域事件 '${event.eventId}' 不属于 snapshot '${snapshot.runId}'`)
  }
  if (event.sequence !== snapshot.sequence + 1) {
    throw new Error(
      `Run '${event.runId}' 领域日志 sequence 不连续：`
      + `期望 ${snapshot.sequence + 1}，收到 ${event.sequence}`,
    )
  }
  if (event.type === 'run.created') {
    throw new Error(`Run '${event.runId}' 不能重复应用 run.created`)
  }

  let status = snapshot.status
  let state = snapshot.state
  const inputDeliveries = structuredClone(snapshot.inputDeliveries)
  let activeModelRequestId = snapshot.activeModelRequestId
  let contextWindowId = snapshot.contextWindowId
  let contextWindowGeneration = snapshot.contextWindowGeneration
  let checkpoint = snapshot.checkpoint

  switch (event.type) {
    case 'run.status_changed':
      status = event.payload.status
      break
    case 'run.state_changed':
    case 'tool.succeeded':
      state = applyAgentStateChanges(state, event.payload.changes)
      break
    case 'input.queued':
    case 'input.leased':
    case 'input.included':
    case 'input.checkpointed':
    case 'input.requeued':
      for (const input of event.payload.inputs) inputDeliveries[input.inputId] = input
      break
    case 'step.model_request_committed':
      if (activeModelRequestId) {
        throw new Error(
          `Run '${event.runId}' 不能在活动模型请求 '${activeModelRequestId}' 未 checkpoint 时提交新请求`,
        )
      }
      activeModelRequestId = event.payload.requestId
      break
    case 'step.model_request_checkpointed':
      if (activeModelRequestId !== event.payload.requestId) {
        throw new Error(
          `Run '${event.runId}' checkpoint 的模型请求 '${event.payload.requestId}' 不是当前活动请求`,
        )
      }
      activeModelRequestId = null
      break
    case 'context.window_started':
      if (contextWindowId !== null || contextWindowGeneration !== 0) {
        throw new Error(`Run '${event.runId}' 已有活动上下文窗口，不能重复开始首个窗口`)
      }
      contextWindowId = event.payload.contextWindowId
      contextWindowGeneration = event.payload.generation
      break
    case 'context.compacted':
      if (
        contextWindowId !== event.payload.contextWindowId
        || contextWindowGeneration !== event.payload.generation
      ) {
        throw new Error(`Run '${event.runId}' 压缩的上下文窗口不是当前活动窗口`)
      }
      break
    case 'context.rollover':
      if (
        contextWindowId !== event.payload.previousContextWindowId
        || event.payload.generation !== contextWindowGeneration + 1
      ) {
        throw new Error(`Run '${event.runId}' 上下文窗口换代不连续`)
      }
      contextWindowId = event.payload.contextWindowId
      contextWindowGeneration = event.payload.generation
      break
    case 'terminal.claimed':
    case 'terminal.candidate_superseded':
      break
    case 'run.checkpoint_changed':
      checkpoint = event.payload.checkpoint
      break
    case 'projection.warning':
      break
  }

  return runDomainSnapshotSchema.parse({
    schemaVersion: RUN_DOMAIN_SNAPSHOT_SCHEMA_VERSION,
    runId: snapshot.runId,
    sequence: event.sequence,
    status,
    state,
    inputDeliveries,
    activeModelRequestId,
    contextWindowId,
    contextWindowGeneration,
    checkpoint,
    updatedAt: event.occurredAt,
  })
}

export function reduceRunDomainEvents(
  initial: RunDomainSnapshot | null,
  events: readonly RunDomainEvent[],
): RunDomainSnapshot | null {
  return events.reduce<RunDomainSnapshot | null>(reduceRunDomainEvent, initial)
}

export function replayRunDomainEvents(events: readonly RunDomainEvent[]): RunDomainSnapshot | null {
  return reduceRunDomainEvents(null, events)
}

function applyAgentStateChanges(
  current: AgentState,
  changes: readonly z.infer<typeof agentStateFieldChangeSchema>[],
): AgentState {
  const updates: Partial<Record<keyof AgentState, unknown>> = {}
  for (const rawChange of changes) {
    const change = agentStateFieldChangeSchema.parse(rawChange)
    updates[change.field] = structuredClone(change.value)
  }
  return agentStateSchema.parse({ ...structuredClone(current), ...updates })
}

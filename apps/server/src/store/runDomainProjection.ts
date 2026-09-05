// +-------------------------------------------------------------------------
//
//   地理智能平台 - Run 领域事件映射与权威快照一致性断言
//
//   文件:       runDomainProjection.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { isDeepStrictEqual } from 'node:util'

import {
RUN_DOMAIN_EVENT_SCHEMA_VERSION,
replayRunDomainEvents,
runDomainEventSchema,
type AgentState,
type AgentStateFieldChange,
type AnalysisRun,
type RunDomainCheckpoint,
type RunDomainEvent,
type RunDomainInputDelivery,
type RunDomainProjectionInspection,
type RunDomainProjectionInspectionReason,
type RunDomainSnapshot,
type RunSteeringRecord,
} from '../schemas/types.js'
import { currentLogContext } from '../observability/logger.js'
import { runDomainReplayComparisonsTotal } from '../observability/metrics.js'
import { makeId } from '../utils/ids.js'

type RunDomainEventType = RunDomainEvent['type']
type RunDomainEventPayload<T extends RunDomainEventType> = Extract<
  RunDomainEvent,
  { type: T }
>['payload']

export interface RunDomainCheckpointSource {
  activeEntryId: string | null
  pendingToolCallIds: string[]
  recoveryStatus: string
  orchestrationEngine: string | null
  sdkStateContentHash: string | null
  sdkVersion: string | null
  runtimeConfigDigest: string | null
  sdkStateSchemaVersion: number | null
  sdkStateUpdatedAt: Date | null
  nextInputSequence: number
  checkpointInputCursor: number
  activeInputLeaseId: string | null
  activeInputLeaseFrom: number | null
  activeInputLeaseTo: number | null
  terminalInputClaimId: string | null
  terminalObjectiveRevision: number | null
  terminalInputCursor: number | null
  terminalClaimedAt: Date | null
}

export function inspectRunDomainProjection(input: {
  run: AnalysisRun | null
  checkpoint: RunDomainCheckpoint
  inputs: readonly RunDomainInputDelivery[]
  snapshot: RunDomainSnapshot | null
  events: readonly RunDomainEvent[]
}): RunDomainProjectionInspection {
  const sourceSequence = input.events.at(-1)?.sequence ?? 0
  const snapshotSequence = input.snapshot?.sequence ?? null
  const sequenceDistance = Math.abs(sourceSequence - (snapshotSequence ?? 0))
  const base = {
    runId: input.run?.id ?? input.snapshot?.runId ?? input.events[0]?.runId ?? 'unknown_run',
    sourceSequence,
    snapshotSequence,
    sequenceDistance,
  }
  if (!input.snapshot && !input.events.length) {
    return failedInspection(base, 'missing_snapshot', [
      '运行缺少权威领域事件和 snapshot',
    ])
  }
  if (!input.snapshot) {
    return failedInspection(base, 'missing_snapshot', ['领域事件存在，但 snapshot 缺失'])
  }
  if (!input.events.length) {
    return failedInspection(base, 'missing_events', ['snapshot 存在，但领域事件缺失'])
  }
  if (!input.run) {
    return failedInspection(base, 'schema', ['缺少可与权威 snapshot 组合的运行身份投影'])
  }

  let replayed: RunDomainSnapshot | null
  try {
    replayed = replayRunDomainEvents(input.events)
  } catch (error) {
    return failedInspection(base, 'sequence', [errorMessage(error)])
  }
  if (!replayed || replayed.sequence !== sourceSequence) {
    return failedInspection(base, 'sequence', [
      `领域事件源游标 ${sourceSequence} 未能完整重放`,
    ])
  }
  if (input.snapshot.sequence !== sourceSequence) {
    return failedInspection(base, 'sequence', [
      `snapshot 游标 ${input.snapshot.sequence} 与事件游标 ${sourceSequence} 不一致`,
    ])
  }
  if (!isDeepStrictEqual(replayed, input.snapshot)) {
    return failedInspection(base, 'snapshot', ['从 sequence 0 重放的结果与存储 snapshot 不一致'])
  }

  const runMismatches = runDomainProjectionMismatches(input.snapshot, input.run)
  if (runMismatches.length) return failedInspection(base, 'run', runMismatches)
  if (!isDeepStrictEqual(input.snapshot.checkpoint, input.checkpoint)) {
    return failedInspection(base, 'checkpoint', ['领域 snapshot 与 Run checkpoint 事实不一致'])
  }
  if (!runDomainInputCollectionMatches(input.snapshot, input.inputs)) {
    return failedInspection(base, 'input', ['领域 snapshot 与 Run input 集合事实不一致'])
  }
  return {
    ...base,
    status: 'verified',
    reason: 'verified',
    details: [],
  }
}

export function buildRunCreatedEvents(
  run: AnalysisRun,
  checkpoint: RunDomainCheckpoint,
  expectedSequence: number,
): RunDomainEvent[] {
  if (expectedSequence !== 0) {
    throw new Error(`run '${run.id}' 只能在 sequence 0 生成 run.created`)
  }
  return [
    domainEvent(run, expectedSequence + 1, 'run.created', {
      status: run.status,
      state: run.state,
    }, run.createdAt, null, { kind: 'user', id: run.createdByUserId }),
    domainEvent(run, expectedSequence + 2, 'run.checkpoint_changed', {
      checkpoint,
    }, run.updatedAt),
  ]
}

export function buildRunTransitionEvents(input: {
  before: AnalysisRun
  after: AnalysisRun
  expectedSequence: number
  reason: string
  resultId?: string
}): RunDomainEvent[] {
  const events: RunDomainEvent[] = []
  let sequence = input.expectedSequence
  if (input.before.status !== input.after.status) {
    events.push(domainEvent(
      input.after,
      ++sequence,
      'run.status_changed',
      { status: input.after.status, reason: input.reason },
    ))
  }
  const changes = changedAgentStateFields(input.before.state, input.after.state)
  if (input.resultId) {
    events.push(domainEvent(
      input.after,
      ++sequence,
      'tool.succeeded',
      { resultId: input.resultId, changes },
      undefined,
      input.resultId,
      {
        kind: 'tool',
        id: input.after.state.toolResults.find(result => result.resultId === input.resultId)?.tool
          ?? null,
      },
    ))
  } else if (changes.length) {
    events.push(domainEvent(
        input.after,
        ++sequence,
        'run.state_changed',
        { reason: input.reason, changes },
    ))
  }
  return events
}

export function buildInputTransitionEvent(input: {
  run: AnalysisRun
  expectedSequence: number
  type: 'input.queued' | 'input.leased' | 'input.included' | 'input.checkpointed' | 'input.requeued'
  records: readonly RunSteeringRecord[]
}): RunDomainEvent {
  const status = input.type === 'input.checkpointed'
    ? 'checkpointed'
    : input.type === 'input.included'
      ? 'included'
    : input.type === 'input.leased'
      ? 'leased'
      : 'queued'
  return domainEvent(input.run, input.expectedSequence + 1, input.type, {
    inputs: input.records.map(record => ({
      inputId: record.steeringId,
      inputSequence: record.inputSequence,
      status,
      leaseId: status === 'queued' ? null : record.leaseId,
      modelRequestId: status === 'included' || status === 'checkpointed'
        ? record.modelRequestId
        : null,
    })),
  } as RunDomainEventPayload<typeof input.type>, undefined, null, input.type === 'input.queued'
    ? { kind: 'user', id: input.run.createdByUserId }
    : { kind: 'system', id: null })
}

export function buildModelRequestCommittedEvent(input: {
  run: AnalysisRun
  expectedSequence: number
  requestId: string
  stepId: string
  inputObjectHash: string
  inputEntryIds: readonly string[]
}): RunDomainEvent {
  return domainEvent(input.run, input.expectedSequence + 1, 'step.model_request_committed', {
    requestId: input.requestId,
    stepId: input.stepId,
    inputObjectHash: input.inputObjectHash,
    inputEntryIds: [...input.inputEntryIds],
  })
}

export function buildModelRequestCheckpointedEvent(input: {
  run: AnalysisRun
  expectedSequence: number
  requestId: string
  stepId: string
}): RunDomainEvent {
  return domainEvent(input.run, input.expectedSequence + 1, 'step.model_request_checkpointed', {
    requestId: input.requestId,
    stepId: input.stepId,
  })
}

export function buildContextWindowStartedEvent(input: {
  run: AnalysisRun
  expectedSequence: number
  contextWindowId: string
  generation: number
  promptProtocolVersion: string
  sourceDigest: string
}): RunDomainEvent {
  return domainEvent(input.run, input.expectedSequence + 1, 'context.window_started', {
    contextWindowId: input.contextWindowId,
    generation: input.generation,
    promptProtocolVersion: input.promptProtocolVersion,
    sourceDigest: input.sourceDigest,
  })
}

export function buildContextCompactedEvent(input: {
  run: AnalysisRun
  expectedSequence: number
  contextWindowId: string
  generation: number
  sourceDigest: string
  summaryObjectHashes: readonly string[]
  promptVersion: string
}): RunDomainEvent {
  return domainEvent(input.run, input.expectedSequence + 1, 'context.compacted', {
    contextWindowId: input.contextWindowId,
    generation: input.generation,
    sourceDigest: input.sourceDigest,
    summaryObjectHashes: [...input.summaryObjectHashes],
    promptVersion: input.promptVersion,
  })
}

export function buildContextRolloverEvent(input: {
  run: AnalysisRun
  expectedSequence: number
  previousContextWindowId: string
  contextWindowId: string
  generation: number
  reason: 'compaction' | 'hard_limit' | 'manual'
}): RunDomainEvent {
  return domainEvent(input.run, input.expectedSequence + 1, 'context.rollover', {
    previousContextWindowId: input.previousContextWindowId,
    contextWindowId: input.contextWindowId,
    generation: input.generation,
    reason: input.reason,
  })
}

export function buildTerminalClaimedEvent(input: {
  run: AnalysisRun
  expectedSequence: number
  claimId: string
  objectiveRevision: number
  inputCursor: number
}): RunDomainEvent {
  return domainEvent(input.run, input.expectedSequence + 1, 'terminal.claimed', {
    claimId: input.claimId,
    objectiveRevision: input.objectiveRevision,
    inputCursor: input.inputCursor,
  })
}

export function buildTerminalCandidateSupersededEvent(input: {
  run: AnalysisRun
  expectedSequence: number
  objectiveRevision: number
  inputCursor: number
  durableObjectiveRevision: number
  durableInputCursor: number
}): RunDomainEvent {
  return domainEvent(input.run, input.expectedSequence + 1, 'terminal.candidate_superseded', {
    objectiveRevision: input.objectiveRevision,
    inputCursor: input.inputCursor,
    durableObjectiveRevision: input.durableObjectiveRevision,
    durableInputCursor: input.durableInputCursor,
  })
}

export function buildCheckpointChangedEvent(input: {
  run: AnalysisRun
  expectedSequence: number
  checkpoint: RunDomainCheckpoint
}): RunDomainEvent {
  return domainEvent(input.run, input.expectedSequence + 1, 'run.checkpoint_changed', {
    checkpoint: input.checkpoint,
  })
}

export function toRunDomainCheckpoint(source: RunDomainCheckpointSource): RunDomainCheckpoint {
  return {
    activeEntryId: source.activeEntryId,
    pendingToolCallIds: [...source.pendingToolCallIds],
    recoveryStatus: source.recoveryStatus,
    orchestrationEngine: source.orchestrationEngine,
    sdkStateContentHash: source.sdkStateContentHash,
    agentsSdkVersion: source.sdkVersion,
    runtimeConfigDigest: source.runtimeConfigDigest,
    sdkStateSchemaVersion: source.sdkStateSchemaVersion,
    sdkStateUpdatedAt: source.sdkStateUpdatedAt?.toISOString() ?? null,
    nextInputSequence: source.nextInputSequence,
    checkpointInputCursor: source.checkpointInputCursor,
    activeInputLeaseId: source.activeInputLeaseId,
    activeInputLeaseFrom: source.activeInputLeaseFrom,
    activeInputLeaseTo: source.activeInputLeaseTo,
    terminalInputClaimId: source.terminalInputClaimId,
    terminalObjectiveRevision: source.terminalObjectiveRevision,
    terminalInputCursor: source.terminalInputCursor,
    terminalClaimedAt: source.terminalClaimedAt?.toISOString() ?? null,
  }
}

export function assertRunDomainProjection(
  snapshot: RunDomainSnapshot,
  run: AnalysisRun,
): void {
  const mismatches = runDomainProjectionMismatches(snapshot, run)
  assertProjection(
    mismatches.length === 0,
    run.id,
    'run',
    mismatches,
  )
}

export function assertRunDomainCheckpointProjection(
  snapshot: RunDomainSnapshot,
  checkpoint: RunDomainCheckpoint,
): void {
  assertProjection(
    isDeepStrictEqual(snapshot.checkpoint, checkpoint),
    snapshot.runId,
    'checkpoint',
  )
}

export function assertRunDomainInputProjection(
  snapshot: RunDomainSnapshot,
  records: readonly RunSteeringRecord[],
): void {
  const matches = records.every(record => {
    const projected = snapshot.inputDeliveries[record.steeringId]
    return projected !== undefined && isDeepStrictEqual(projected, inputDelivery(record))
  })
  assertProjection(matches, snapshot.runId, 'input')
}

export function assertRunDomainInputCollection(
  snapshot: RunDomainSnapshot,
  deliveries: readonly RunDomainInputDelivery[],
): void {
  assertProjection(
    runDomainInputCollectionMatches(snapshot, deliveries),
    snapshot.runId,
    'input',
  )
}

function runDomainProjectionMismatches(
  snapshot: RunDomainSnapshot,
  run: AnalysisRun,
): string[] {
  const mismatches: string[] = []
  if (snapshot.runId !== run.id) mismatches.push('runId')
  if (snapshot.status !== run.status) mismatches.push('status')
  const stateFields = Object.keys(run.state) as Array<keyof AgentState>
  for (const field of stateFields) {
    if (!isDeepStrictEqual(snapshot.state[field], run.state[field])) {
      mismatches.push(`state.${field}`)
    }
  }
  return mismatches
}

function runDomainInputCollectionMatches(
  snapshot: RunDomainSnapshot,
  deliveries: readonly RunDomainInputDelivery[],
): boolean {
  const projected = Object.values(snapshot.inputDeliveries)
    .sort((left, right) => left.inputSequence - right.inputSequence)
  const expected = [...deliveries]
    .sort((left, right) => left.inputSequence - right.inputSequence)
  return isDeepStrictEqual(projected, expected)
}

function failedInspection(
  base: Pick<
    RunDomainProjectionInspection,
    'runId' | 'sourceSequence' | 'snapshotSequence' | 'sequenceDistance'
  >,
  reason: Exclude<RunDomainProjectionInspectionReason, 'verified'>,
  details: string[],
): RunDomainProjectionInspection {
  return { ...base, status: 'failed', reason, details }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function changedAgentStateFields(
  before: AgentState,
  after: AgentState,
): AgentStateFieldChange[] {
  const keys = Object.keys(after) as Array<keyof AgentState>
  return keys.flatMap(field => isDeepStrictEqual(before[field], after[field])
    ? []
    : [{ field, value: structuredClone(after[field]) } as AgentStateFieldChange])
}

function domainEvent<T extends RunDomainEventType>(
  run: AnalysisRun,
  sequence: number,
  type: T,
  payload: RunDomainEventPayload<T>,
  occurredAt = run.updatedAt,
  causationId: string | null = null,
  actor: RunDomainEvent['actor'] = { kind: 'system', id: null },
): RunDomainEvent {
  const context = currentLogContext()
  const traceId = stringContextValue(context, 'traceId')
  return runDomainEventSchema.parse({
    eventId: makeId('domain_event'),
    runId: run.id,
    sequence,
    turnId: stringContextValue(context, 'turnId'),
    stepId: stringContextValue(context, 'stepId'),
    objectiveRevision: run.state.objectiveRevision,
    causationId,
    correlationId: traceId ?? `run:${run.id}`,
    actor,
    occurredAt,
    schemaVersion: RUN_DOMAIN_EVENT_SCHEMA_VERSION,
    type,
    payload,
  })
}

function inputDelivery(record: RunSteeringRecord): RunDomainInputDelivery {
  return {
    inputId: record.steeringId,
    inputSequence: record.inputSequence,
    status: record.status,
    leaseId: record.status === 'queued' ? null : record.leaseId,
    modelRequestId: record.status === 'included' || record.status === 'checkpointed'
      ? record.modelRequestId
      : null,
  }
}

function assertProjection(
  matches: boolean,
  runId: string,
  scope: 'run' | 'checkpoint' | 'input',
  mismatches: readonly string[] = [],
): void {
  runDomainReplayComparisonsTotal.inc({ scope, outcome: matches ? 'match' : 'mismatch' })
  if (!matches) {
    const details = mismatches.length ? `：${mismatches.join(', ')}` : ''
    throw new Error(`run '${runId}' 的领域日志 ${scope} reducer 投影与事务事实不一致${details}`)
  }
}

function stringContextValue(
  context: Record<string, unknown>,
  key: string,
): string | null {
  const value = context[key]
  return typeof value === 'string' && value.trim() ? value : null
}

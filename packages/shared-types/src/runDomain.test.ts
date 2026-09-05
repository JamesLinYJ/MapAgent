// +-------------------------------------------------------------------------
//
//   地理智能平台 - Run 领域日志契约测试
//
//   文件:       runDomain.test.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { agentStateSchema } from './core.js'
import {
  reduceRunDomainEvent,
  replayRunDomainEvents,
  runDomainEventSchema,
  runDomainProjectionInspectionSchema,
  type RunDomainEvent,
} from './runDomain.js'

const initialState = agentStateSchema.parse({
  sessionId: 'session_1',
  userQuery: '绘制风险区划图',
})

describe('run domain journal contract', () => {
  it('rebuilds a snapshot from sequence zero without reading AgentState storage', () => {
    const events = [
      event(1, 'run.created', { status: 'queued', state: initialState }),
      event(2, 'run.status_changed', { status: 'running', reason: 'runner_started' }),
      event(3, 'run.state_changed', {
        reason: 'runtime_progress',
        changes: [
          { field: 'warnings', value: ['运行中警告'] },
          { field: 'currentStep', value: 2 },
        ],
      }),
      event(4, 'input.queued', {
        inputs: [{
          inputId: 'input_1',
          inputSequence: 1,
          status: 'queued',
          leaseId: null,
          modelRequestId: null,
        }],
      }),
      event(5, 'input.leased', {
        inputs: [{
          inputId: 'input_1',
          inputSequence: 1,
          status: 'leased',
          leaseId: 'lease_1',
          modelRequestId: null,
        }],
      }),
      event(6, 'input.included', {
        inputs: [{
          inputId: 'input_1',
          inputSequence: 1,
          status: 'included',
          leaseId: 'lease_1',
          modelRequestId: 'model_request_1',
        }],
      }),
      event(7, 'step.model_request_committed', {
        requestId: 'model_request_1',
        stepId: 'step_1',
        inputObjectHash: 'b'.repeat(64),
        inputEntryIds: ['entry_1'],
      }),
      event(8, 'input.checkpointed', {
        inputs: [{
          inputId: 'input_1',
          inputSequence: 1,
          status: 'checkpointed',
          leaseId: 'lease_1',
          modelRequestId: 'model_request_1',
        }],
      }),
      event(9, 'run.checkpoint_changed', {
        checkpoint: {
          activeEntryId: null,
          pendingToolCallIds: [],
          recoveryStatus: 'clean',
          orchestrationEngine: 'openai_agents',
          sdkStateContentHash: 'a'.repeat(64),
          agentsSdkVersion: '0.17.0',
          runtimeConfigDigest: 'digest_1',
          sdkStateSchemaVersion: 5,
          sdkStateUpdatedAt: '2026-08-20T00:00:00.000Z',
          nextInputSequence: 2,
          checkpointInputCursor: 1,
          activeInputLeaseId: null,
          activeInputLeaseFrom: null,
          activeInputLeaseTo: null,
          terminalInputClaimId: null,
          terminalObjectiveRevision: null,
          terminalInputCursor: null,
          terminalClaimedAt: null,
        },
      }),
    ]

    const replayed = replayRunDomainEvents(events)

    expect(replayed).toMatchObject({
      runId: 'run_1',
      sequence: 9,
      status: 'running',
      state: { warnings: ['运行中警告'], currentStep: 2 },
      inputDeliveries: {
        input_1: {
          status: 'checkpointed',
          leaseId: 'lease_1',
          modelRequestId: 'model_request_1',
        },
      },
      activeModelRequestId: 'model_request_1',
      checkpoint: { checkpointInputCursor: 1 },
    })
  })

  it('produces the same snapshot incrementally and by full replay', () => {
    const events = [
      event(1, 'run.created', { status: 'queued', state: initialState }),
      event(2, 'tool.succeeded', {
        resultId: 'result_1',
        changes: [{ field: 'selectedDataSources', value: ['dataset_1'] }],
      }),
      event(3, 'run.status_changed', { status: 'completed', reason: 'terminal_committed' }),
    ]
    const incremental = events.reduce(reduceRunDomainEvent, null)

    expect(incremental).toEqual(replayRunDomainEvents(events))
    expect(incremental?.state.selectedDataSources).toEqual(['dataset_1'])
  })

  it('tracks one recoverable model request until its SDK checkpoint is committed', () => {
    const committed = event(2, 'step.model_request_committed', {
      requestId: 'model_request_recovery',
      stepId: 'step_recovery',
      inputObjectHash: 'c'.repeat(64),
      inputEntryIds: [],
    })
    const checkpointed = event(3, 'step.model_request_checkpointed', {
      requestId: 'model_request_recovery',
      stepId: 'step_recovery',
    })
    const created = reduceRunDomainEvent(
      null,
      event(1, 'run.created', { status: 'running', state: initialState }),
    )

    const active = reduceRunDomainEvent(created, committed)
    expect(active.activeModelRequestId).toBe('model_request_recovery')
    expect(reduceRunDomainEvent(active, checkpointed).activeModelRequestId).toBeNull()
  })

  it('reuses one context window until an explicit compaction rolls to the next generation', () => {
    const events = [
      event(1, 'run.created', { status: 'running', state: initialState }),
      event(2, 'context.window_started', {
        contextWindowId: 'context_window_1',
        generation: 1,
        promptProtocolVersion: '1',
        sourceDigest: 'sha256:source-1',
      }),
      event(3, 'context.compacted', {
        contextWindowId: 'context_window_1',
        generation: 1,
        sourceDigest: 'sha256:source-1',
        summaryObjectHashes: ['a'.repeat(64)],
        promptVersion: '1',
      }),
      event(4, 'context.rollover', {
        previousContextWindowId: 'context_window_1',
        contextWindowId: 'context_window_2',
        generation: 2,
        reason: 'compaction',
      }),
    ]

    const snapshot = replayRunDomainEvents(events)

    expect(snapshot).toMatchObject({
      contextWindowId: 'context_window_2',
      contextWindowGeneration: 2,
    })
    expect(() => reduceRunDomainEvent(snapshot!, event(5, 'context.rollover', {
      previousContextWindowId: 'context_window_1',
      contextWindowId: 'context_window_3',
      generation: 3,
      reason: 'manual',
    }))).toThrow(/换代不连续/u)
  })

  it('rejects non-contiguous sequences and duplicate run creation', () => {
    const created = reduceRunDomainEvent(
      null,
      event(1, 'run.created', { status: 'queued', state: initialState }),
    )

    expect(() => reduceRunDomainEvent(
      created,
      event(3, 'run.status_changed', { status: 'running', reason: 'skipped_sequence' }),
    )).toThrow(/sequence 不连续/u)
    expect(() => reduceRunDomainEvent(
      created,
      event(2, 'run.created', { status: 'queued', state: initialState }),
    )).toThrow(/不能重复/u)
  })

  it('validates each AgentState field change with the canonical field schema', () => {
    const invalid = {
      ...envelope(2),
      type: 'run.state_changed',
      payload: {
        reason: 'invalid_patch',
        changes: [{ field: 'warnings', value: [123] }],
      },
    }

    expect(runDomainEventSchema.safeParse(invalid).success).toBe(false)
  })

  it('keeps projection inspection status, reason and sequence distance coherent', () => {
    const verified = {
      runId: 'run_1',
      status: 'verified',
      reason: 'verified',
      sourceSequence: 3,
      snapshotSequence: 3,
      sequenceDistance: 0,
      details: [],
    }
    expect(runDomainProjectionInspectionSchema.parse(verified)).toEqual(verified)
    expect(runDomainProjectionInspectionSchema.safeParse({
      ...verified,
      status: 'failed',
      reason: 'verified',
      sequenceDistance: 1,
    }).success).toBe(false)
  })
})

function event(
  sequence: number,
  type: RunDomainEvent['type'],
  payload: unknown,
): RunDomainEvent {
  return runDomainEventSchema.parse({ ...envelope(sequence), type, payload })
}

function envelope(sequence: number) {
  return {
    eventId: `event_${sequence}`,
    runId: 'run_1',
    sequence,
    turnId: null,
    stepId: null,
    objectiveRevision: 1,
    causationId: null,
    correlationId: 'correlation_1',
    actor: { kind: 'system', id: null },
    occurredAt: `2026-08-20T00:00:0${sequence}.000Z`,
    schemaVersion: 1,
  }
}

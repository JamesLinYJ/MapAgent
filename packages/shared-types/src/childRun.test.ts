// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久子运行契约测试
//
//   文件:       childRun.test.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  agentMessageSchema,
  childRunDescriptorSchema,
  rootRunBudgetSchema,
} from './childRun.js'

describe('durable child Run contracts', () => {
  it('requires an exact last-N fork and independent budget', () => {
    const descriptor = childRunDescriptorSchema.parse({
      runId: 'run_child',
      rootRunId: 'run_root',
      parentRunId: 'run_root',
      parentTurnId: 'turn_parent',
      rootTurnId: 'turn_root',
      spawnCallId: 'call_spawn',
      agentPath: '/root/risk_map',
      taskName: 'risk_map',
      role: 'spatial_analyst',
      status: 'queued',
      spawnDepth: 1,
      forkMode: 'last_n_turns',
      forkTurnCount: 2,
      modelOverride: null,
      reasoningOverride: null,
      budget: {
        maxModelTokens: 10_000,
        maxWallClockMs: 60_000,
        usedModelTokens: 0,
        startedAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      },
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    })
    expect(descriptor.forkTurnCount).toBe(2)
    expect(() => childRunDescriptorSchema.parse({ ...descriptor, forkTurnCount: null }))
      .toThrow(/last_n_turns/u)
  })

  it('rejects root budget counters that already exceed capacity', () => {
    expect(() => rootRunBudgetSchema.parse({
      rootRunId: 'run_root',
      maxConcurrentChildren: 1,
      maxSpawnDepth: 2,
      maxTotalChildren: 2,
      maxTotalModelTokens: null,
      maxWallClockMs: null,
      totalChildren: 2,
      activeChildren: 2,
      usedModelTokens: 0,
      version: 2,
      startedAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    })).toThrow(/并发预算/u)
  })

  it('keeps queue-only and trigger-turn as explicit message facts', () => {
    const message = agentMessageSchema.parse({
      messageId: 'message_1',
      rootRunId: 'run_root',
      senderRunId: 'run_child',
      receiverRunId: 'run_root',
      parentTurnId: 'turn_parent',
      rootTurnId: 'turn_root',
      sequence: 1,
      kind: 'message',
      content: '子运行完成了空间核验。',
      triggerTurn: false,
      status: 'queued',
      createdAt: '2026-08-24T00:00:00.000Z',
      deliveredAt: null,
      checkpointedAt: null,
    })
    expect(message.triggerTurn).toBe(false)
    expect(() => agentMessageSchema.parse({ ...message, deliveredAt: message.createdAt }))
      .toThrow(/queued/u)
  })
})

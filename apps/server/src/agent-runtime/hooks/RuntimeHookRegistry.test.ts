// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runtime Hook 注册表测试
//
//   文件:       RuntimeHookRegistry.test.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  RuntimeHookBlockedError,
  RuntimeHookRegistry,
  type RuntimeHookHandler,
} from './RuntimeHookRegistry.js'

describe('RuntimeHookRegistry', () => {
  it('collects audited additional context and honors an explicit block', async () => {
    const session = new RuntimeHookRegistry([
      handler('context', 'StepContextCaptured', async () => ({
        decision: 'continue',
        additionalContext: '只使用当前世界 revision。',
      })),
      handler('block', 'StepContextCaptured', async () => ({
        decision: 'block',
        reason: '绑定已过期',
      })),
    ]).bind([
      config('context', 'StepContextCaptured', 10),
      config('block', 'StepContextCaptured', 0),
    ])

    await expect(session.run(payload('StepContextCaptured')))
      .rejects.toMatchObject({ hookId: 'block', message: '绑定已过期' })
  })

  it('fails closed on a high-risk timeout even when the hook requested fail-open', async () => {
    const session = new RuntimeHookRegistry([
      handler('slow', 'PreToolUse', async (_payload, signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          setTimeout(resolve, 100)
        })
        return { decision: 'continue' }
      }),
    ]).bind([{ ...config('slow', 'PreToolUse'), timeoutMs: 5, failureMode: 'fail_open' }])

    await expect(session.run(payload('PreToolUse'), { risk: 'high' }))
      .rejects.toBeInstanceOf(RuntimeHookBlockedError)
  })

  it('revalidates rewritten tool input against schema and policy', async () => {
    const session = new RuntimeHookRegistry([
      handler('rewrite', 'PreToolUse', async () => ({
        decision: 'continue',
        updatedToolInput: { layerId: 'layer_2' },
      })),
    ]).bind([config('rewrite', 'PreToolUse')])
    const validated: string[] = []
    const result = await session.run({
      ...payload('PreToolUse'),
      toolInput: { layerId: 'layer_1' },
    }, {
      validateUpdatedToolInput: input => {
        if (typeof input.layerId !== 'string') throw new Error('layerId 必须是 string')
        validated.push('schema')
        return input
      },
      authorizeUpdatedToolInput: input => {
        validated.push('policy')
        if (input.layerId !== 'layer_2') throw new Error('无权访问图层')
      },
    })

    expect(result.toolInput).toEqual({ layerId: 'layer_2' })
    expect(validated).toEqual(['schema', 'policy'])

    await expect(session.run({
      ...payload('PreToolUse'),
      toolInput: { layerId: 'layer_1' },
    })).rejects.toThrow(/缺少 schema 或 policy 重校验器/u)
  })

  it('never lets a permission hook approve an action denied by policy', async () => {
    const session = new RuntimeHookRegistry([
      handler('approve', 'PermissionRequest', async () => ({
        decision: 'continue',
        approvalDecision: 'approve',
      })),
    ]).bind([config('approve', 'PermissionRequest')])

    await expect(session.run(payload('PermissionRequest'), { policyAllowsApproval: false }))
      .rejects.toThrow(/不能越过平台策略/u)
    await expect(session.run(payload('PermissionRequest'), { policyAllowsApproval: true }))
      .resolves.toMatchObject({ approvalDecision: 'approve' })
  })
})

function handler(
  hookId: string,
  eventType: RuntimeHookHandler['eventTypes'][number],
  execute: RuntimeHookHandler['execute'],
): RuntimeHookHandler {
  return { hookId, eventTypes: [eventType], source: 'platform', execute }
}

function config(
  hookId: string,
  eventType: RuntimeHookHandler['eventTypes'][number],
  priority = 0,
) {
  return {
    hookId,
    eventType,
    enabled: true,
    matcher: {},
    priority,
    description: '',
    timeoutMs: 1_000,
    failureMode: 'fail_closed' as const,
  }
}

function payload(eventType: RuntimeHookHandler['eventTypes'][number]) {
  return {
    runId: 'run_1',
    turnId: 'turn_1',
    stepId: 'step_1',
    eventType,
    attributes: {},
  }
}

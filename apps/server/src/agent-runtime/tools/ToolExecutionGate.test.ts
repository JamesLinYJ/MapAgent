// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具共享/独占执行闸门测试
//
//   文件:       ToolExecutionGate.test.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  executionLaneForDescriptor,
  ToolExecutionGate,
  withToolAuthorizationLease,
} from './ToolExecutionGate.js'

describe('ToolExecutionGate', () => {
  it('allows shared reads to overlap', async () => {
    const gate = new ToolExecutionGate()
    let active = 0
    let maxActive = 0
    const execute = () => gate.run('shared', async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 20))
      active -= 1
    })

    await Promise.all([execute(), execute()])
    expect(maxActive).toBe(2)
  })

  it('serializes exclusive effects', async () => {
    const gate = new ToolExecutionGate()
    let active = 0
    let maxActive = 0
    const execute = () => gate.run('exclusive', async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 15))
      active -= 1
    })

    await Promise.all([execute(), execute(), execute()])
    expect(maxActive).toBe(1)
  })

  it('does not let new shared work overtake a queued exclusive call', async () => {
    const gate = new ToolExecutionGate()
    const order: string[] = []
    let releaseFirst!: () => void
    const first = gate.run('shared', async () => {
      order.push('read-a:start')
      await new Promise<void>(resolve => { releaseFirst = resolve })
      order.push('read-a:end')
    })
    await until(() => order.includes('read-a:start'))
    const write = gate.run('exclusive', async () => { order.push('write') })
    const secondRead = gate.run('shared', async () => { order.push('read-b') })
    releaseFirst()
    await Promise.all([first, write, secondRead])

    expect(order).toEqual(['read-a:start', 'read-a:end', 'write', 'read-b'])
  })

  it('revalidates authorization after a queued call acquires its lease', async () => {
    const gate = new ToolExecutionGate()
    let authorized = true
    let checks = 0
    let releaseFirst!: () => void
    const firstStarted = new Promise<void>(resolve => {
      void withToolAuthorizationLease(async () => {
        checks += 1
        if (!authorized) throw new Error('authorization_revoked')
      }, () => gate.run('exclusive', async () => {
        resolve()
        await new Promise<void>(release => { releaseFirst = release })
      }))
    })
    await firstStarted

    const second = withToolAuthorizationLease(async () => {
      checks += 1
      if (!authorized) throw new Error('authorization_revoked')
    }, () => gate.run('shared', async () => 'should-not-run'))
    authorized = false
    releaseFirst()

    await expect(second).rejects.toThrow('authorization_revoked')
    expect(checks).toBe(2)
  })

  it('routes only the descriptor parallelism declared in the immutable plan', () => {
    expect(executionLaneForDescriptor({ parallelism: 'shared' })).toBe('shared')
    expect(executionLaneForDescriptor({ parallelism: 'exclusive' })).toBe('exclusive')
  })
})

async function until(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise(resolve => setTimeout(resolve, 0))
}

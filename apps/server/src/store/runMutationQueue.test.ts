// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行变更队列测试
//
//   文件:       runMutationQueue.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { RunMutationQueue } from './runMutationQueue.js'

describe('RunMutationQueue', () => {
  it('serializes mutations for one run while allowing distinct runs to proceed', async () => {
    const queue = new RunMutationQueue()
    const order: string[] = []
    let releaseFirst: (() => void) | null = null
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })

    const first = queue.run('run_1', async () => {
      order.push('run_1:first:start')
      await firstGate
      order.push('run_1:first:end')
      return 'first'
    })
    const second = queue.run('run_1', async () => {
      order.push('run_1:second')
      return 'second'
    })
    const independent = queue.run('run_2', async () => {
      order.push('run_2')
      return 'independent'
    })

    await independent
    expect(order).toEqual(['run_1:first:start', 'run_2'])
    releaseFirst?.()
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
    expect(order).toEqual(['run_1:first:start', 'run_2', 'run_1:first:end', 'run_1:second'])
  })

  it('does not poison later transactional work after one rolled-back operation', async () => {
    const queue = new RunMutationQueue()
    await expect(queue.run('run_1', async () => { throw new Error('rolled back') }))
      .rejects.toThrow('rolled back')
    await expect(queue.run('run_1', async () => 'recovered')).resolves.toBe('recovered')
    await expect(queue.flush()).resolves.toBeUndefined()
  })
})

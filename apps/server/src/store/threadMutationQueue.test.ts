// +-------------------------------------------------------------------------
//
//   地理智能平台 - 线程变更队列测试
//
//   文件:       threadMutationQueue.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { StoreConflictError } from './storeErrors.js'
import { ThreadMutationQueue, ThreadMutationQueuePoisonedError } from './threadMutationQueue.js'

describe('ThreadMutationQueue', () => {
  it('serializes mutations for the same thread in declaration order', async () => {
    const queue = new ThreadMutationQueue()
    const order: string[] = []

    await Promise.all([
      queue.run('thread-1', async () => {
        order.push('first:start')
        await new Promise(resolve => setTimeout(resolve, 5))
        order.push('first:end')
      }),
      queue.run('thread-1', async () => { order.push('second') }),
    ])

    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('fails closed after a persistence failure', async () => {
    const queue = new ThreadMutationQueue()

    await expect(queue.run('thread-1', async () => { throw new Error('disk failed') })).rejects.toThrow('disk failed')
    await expect(queue.run('thread-1', async () => 'must not run')).rejects.toBeInstanceOf(ThreadMutationQueuePoisonedError)
    await expect(queue.flush()).rejects.toThrow('1 个线程已停止写入')
  })

  it('keeps the queue healthy after an explicit optimistic conflict', async () => {
    const queue = new ThreadMutationQueue()

    await expect(queue.run('thread-1', async () => { throw new StoreConflictError('version conflict') })).rejects.toThrow('version conflict')
    await expect(queue.run('thread-1', async () => 'next')).resolves.toBe('next')
    await expect(queue.flush()).resolves.toBeUndefined()
  })
})

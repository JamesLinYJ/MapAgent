// +-------------------------------------------------------------------------
//
//   地理智能平台 - 线程变更队列
//
//   文件:       threadMutationQueue.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import PQueue from 'p-queue'
import { errorLogPayload, logger } from '../observability/logger.js'
import { runtimeMutationFailuresTotal, runtimeMutationQueueDepth } from '../observability/metrics.js'
import { StoreConflictError } from './storeErrors.js'

interface ThreadQueueState {
  queue: PQueue
  failure: Error | null
}

export class ThreadMutationQueuePoisonedError extends Error {
  constructor(threadId: string, cause: Error) {
    super(`线程 '${threadId}' 的持久化队列已因前序失败而关闭。`, { cause })
    this.name = 'ThreadMutationQueuePoisonedError'
  }
}

/** 按线程串行化跨文件变更；持久化失败后拒绝继续基于不确定状态写入。 */
export class ThreadMutationQueue {
  private readonly queues = new Map<string, ThreadQueueState>()

  async run<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const state = this.requireQueue(threadId)
    if (state.failure) throw new ThreadMutationQueuePoisonedError(threadId, state.failure)

    const operation = state.queue.add(async () => {
      if (state.failure) throw new ThreadMutationQueuePoisonedError(threadId, state.failure)
      try {
        return { value: await work() }
      } catch (error) {
        if (!(error instanceof StoreConflictError)) {
          const failure = toError(error)
          state.failure = failure
          runtimeMutationFailuresTotal.inc({ scope: 'thread' })
          logger.error({ threadId, error: errorLogPayload(failure) }, 'thread mutation queue poisoned')
        }
        throw error
      }
    })
    this.updateDepth()
    try {
      const result = await operation
      if (!result) throw new Error(`线程 '${threadId}' 的持久化任务未返回结果。`)
      return result.value
    } finally {
      this.updateDepth()
      this.scheduleHealthyQueueCleanup(threadId, state)
    }
  }

  async flush(): Promise<void> {
    while (true) {
      const states = [...this.queues.values()]
      await Promise.all(states.map(state => state.queue.onIdle()))
      if ([...this.queues.values()].every(state => state.queue.size === 0 && state.queue.pending === 0)) break
    }
    this.updateDepth()
    const failures = [...this.queues.entries()]
      .filter((entry): entry is [string, ThreadQueueState & { failure: Error }] => entry[1].failure !== null)
      .map(([threadId, state]) => new ThreadMutationQueuePoisonedError(threadId, state.failure))
    if (failures.length) {
      throw new AggregateError(failures, `线程持久化队列 flush 失败：${failures.length} 个线程已停止写入`)
    }
  }

  private requireQueue(threadId: string): ThreadQueueState {
    const existing = this.queues.get(threadId)
    if (existing) return existing
    const created = { queue: new PQueue({ concurrency: 1 }), failure: null }
    this.queues.set(threadId, created)
    return created
  }

  private scheduleHealthyQueueCleanup(threadId: string, state: ThreadQueueState): void {
    if (state.failure) return
    void state.queue.onIdle().then(() => {
      if (this.queues.get(threadId) !== state || state.failure) return
      if (state.queue.size === 0 && state.queue.pending === 0) this.queues.delete(threadId)
      this.updateDepth()
    })
  }

  private updateDepth(): void {
    const depth = [...this.queues.values()]
      .reduce((total, state) => total + state.queue.size + state.queue.pending, 0)
    runtimeMutationQueueDepth.set({ scope: 'thread' }, depth)
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行变更队列
//
//   文件:       runMutationQueue.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import PQueue from 'p-queue'
import { runtimeMutationQueueDepth } from '../observability/metrics.js'

interface RunQueueState {
  queue: PQueue
}

/**
 * 同一 run 的数据库变更必须保持全序。每个任务自身仍由数据库事务保证原子性；
 * 队列只负责消除单进程内事件、item、状态和引导消息之间的锁顺序竞争。
 */
export class RunMutationQueue {
  private readonly queues = new Map<string, RunQueueState>()

  async run<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const state = this.requireQueue(runId)
    const operation = state.queue.add(async () => ({ value: await work() }))
    this.updateDepth()
    try {
      const result = await operation
      if (!result) throw new Error(`运行 '${runId}' 的数据库变更未返回结果。`)
      return result.value
    } finally {
      this.updateDepth()
      this.scheduleCleanup(runId, state)
    }
  }

  async flush(): Promise<void> {
    while (true) {
      const states = [...this.queues.values()]
      await Promise.all(states.map(state => state.queue.onIdle()))
      if ([...this.queues.values()].every(state => state.queue.size === 0 && state.queue.pending === 0)) break
    }
    this.updateDepth()
  }

  private requireQueue(runId: string): RunQueueState {
    const existing = this.queues.get(runId)
    if (existing) return existing
    const created = { queue: new PQueue({ concurrency: 1 }) }
    this.queues.set(runId, created)
    return created
  }

  private scheduleCleanup(runId: string, state: RunQueueState): void {
    void state.queue.onIdle().then(() => {
      if (this.queues.get(runId) !== state) return
      if (state.queue.size === 0 && state.queue.pending === 0) this.queues.delete(runId)
      this.updateDepth()
    })
  }

  private updateDepth(): void {
    const depth = [...this.queues.values()]
      .reduce((total, state) => total + state.queue.size + state.queue.pending, 0)
    runtimeMutationQueueDepth.set({ scope: 'run' }, depth)
  }
}

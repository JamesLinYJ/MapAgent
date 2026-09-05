// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 控制变更调度测试
//
//   文件:       ControlMutationScheduler.test.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import {
  ControlMutationCancelledError,
  ControlMutationScheduler,
  DEFAULT_CONTROL_MUTATION_LIMITS,
} from './ControlMutationScheduler.js'

describe('ControlMutationScheduler', () => {
  it('固定控制面默认有界参数', () => {
    expect(DEFAULT_CONTROL_MUTATION_LIMITS).toEqual({
      perConnection: 128,
      process: 2_048,
      perResource: 128,
      waitTimeoutMs: 30_000,
    })
  })

  it('同资源严格串行，不同资源可并行', async () => {
    const scheduler = new ControlMutationScheduler()
    const firstGate = deferred<void>()
    const events: string[] = []
    const first = scheduler.schedule({
      connectionId: 'connection_1',
      resourceKeys: ['workspace_1:thread:1'],
      reauthorize: () => {},
      execute: async () => {
        events.push('first:start')
        await firstGate.promise
        events.push('first:end')
        return 'first'
      },
    })
    const second = scheduler.schedule({
      connectionId: 'connection_2',
      resourceKeys: ['workspace_1:thread:1'],
      reauthorize: () => {},
      execute: () => {
        events.push('second')
        return 'second'
      },
    })
    const unrelated = scheduler.schedule({
      connectionId: 'connection_2',
      resourceKeys: ['workspace_1:thread:2'],
      reauthorize: () => {},
      execute: () => {
        events.push('unrelated')
        return 'unrelated'
      },
    })

    await expect(unrelated).resolves.toBe('unrelated')
    expect(events).toEqual(['first:start', 'unrelated'])
    firstGate.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
    expect(events).toEqual(['first:start', 'unrelated', 'first:end', 'second'])
  })

  it('分别限制进程、连接与资源的未完成变更数', async () => {
    await expectCapacityRejected(
      { process: 1 },
      ['connection_1', 'resource_1'],
      ['connection_2', 'resource_2'],
      '进程变更队列已满',
    )
    await expectCapacityRejected(
      { perConnection: 1 },
      ['connection_1', 'resource_1'],
      ['connection_1', 'resource_2'],
      '当前连接的变更队列已满',
    )
    await expectCapacityRejected(
      { perResource: 1 },
      ['connection_1', 'resource_1'],
      ['connection_2', 'resource_1'],
      '目标资源的变更队列已满',
    )
  })

  it('排队超时以 overloaded 失败且不执行 handler', async () => {
    vi.useFakeTimers()
    try {
      const scheduler = new ControlMutationScheduler({ waitTimeoutMs: 10 })
      const gate = deferred<void>()
      const first = scheduler.schedule({
        connectionId: 'connection_1',
        resourceKeys: ['resource_1'],
        reauthorize: () => {},
        execute: async () => gate.promise,
      })
      const execute = vi.fn()
      const queued = scheduler.schedule({
        connectionId: 'connection_2',
        resourceKeys: ['resource_1'],
        reauthorize: () => {},
        execute,
      })

      const rejection = expect(queued).rejects.toMatchObject({
        code: 'overloaded',
        name: 'ControlMutationOverloadedError',
      })
      await vi.advanceTimersByTimeAsync(11)
      await rejection
      expect(execute).not.toHaveBeenCalled()
      gate.resolve()
      await first
    } finally {
      vi.useRealTimers()
    }
  })

  it('断连取消排队变更，并向已启动变更发出中止信号', async () => {
    const scheduler = new ControlMutationScheduler()
    const activeGate = deferred<void>()
    let activeSignal: AbortSignal | undefined
    const active = scheduler.schedule({
      connectionId: 'connection_1',
      resourceKeys: ['resource_1'],
      reauthorize: () => {},
      execute: async signal => {
        activeSignal = signal
        await activeGate.promise
        return 'committed'
      },
    })
    const queuedExecute = vi.fn()
    const queued = scheduler.schedule({
      connectionId: 'connection_1',
      resourceKeys: ['resource_1'],
      reauthorize: () => {},
      execute: queuedExecute,
    })
    await Promise.resolve()

    scheduler.cancelConnection('connection_1')

    await expect(queued).rejects.toBeInstanceOf(ControlMutationCancelledError)
    expect(activeSignal?.aborted).toBe(true)
    expect(queuedExecute).not.toHaveBeenCalled()
    activeGate.resolve()
    await expect(active).resolves.toBe('committed')
  })

  it('断连批量取消时不会让同连接的后续多资源请求在清理中途启动', async () => {
    const scheduler = new ControlMutationScheduler()
    const blockerGate = deferred<void>()
    const blocker = scheduler.schedule({
      connectionId: 'other_connection',
      resourceKeys: ['resource_x'],
      reauthorize: () => {},
      execute: async () => blockerGate.promise,
    })
    const firstExecute = vi.fn()
    const secondExecute = vi.fn()
    const firstQueued = scheduler.schedule({
      connectionId: 'closing_connection',
      resourceKeys: ['resource_x', 'resource_y'],
      reauthorize: () => {},
      execute: firstExecute,
    })
    const secondQueued = scheduler.schedule({
      connectionId: 'closing_connection',
      resourceKeys: ['resource_y'],
      reauthorize: () => {},
      execute: secondExecute,
    })

    scheduler.cancelConnection('closing_connection')

    await expect(firstQueued).rejects.toBeInstanceOf(ControlMutationCancelledError)
    await expect(secondQueued).rejects.toBeInstanceOf(ControlMutationCancelledError)
    expect(firstExecute).not.toHaveBeenCalled()
    expect(secondExecute).not.toHaveBeenCalled()
    blockerGate.resolve()
    await blocker
  })

  it('出队后重新授权，失败时不执行也不重试 handler', async () => {
    const scheduler = new ControlMutationScheduler()
    const firstGate = deferred<void>()
    const first = scheduler.schedule({
      connectionId: 'connection_1',
      resourceKeys: ['resource_1'],
      reauthorize: () => {},
      execute: async () => firstGate.promise,
    })
    const reauthorize = vi.fn(() => {
      throw new Error('权限已撤销')
    })
    const execute = vi.fn()
    const queued = scheduler.schedule({
      connectionId: 'connection_2',
      resourceKeys: ['resource_1'],
      reauthorize,
      execute,
    })

    firstGate.resolve()
    await first
    await expect(queued).rejects.toThrow('权限已撤销')
    expect(reauthorize).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })
})

async function expectCapacityRejected(
  limits: ConstructorParameters<typeof ControlMutationScheduler>[0],
  firstIdentity: readonly [string, string],
  rejectedIdentity: readonly [string, string],
  message: string,
): Promise<void> {
  const scheduler = new ControlMutationScheduler(limits)
  const gate = deferred<void>()
  const first = scheduler.schedule({
    connectionId: firstIdentity[0],
    resourceKeys: [firstIdentity[1]],
    reauthorize: () => {},
    execute: async () => gate.promise,
  })
  await expect(scheduler.schedule({
    connectionId: rejectedIdentity[0],
    resourceKeys: [rejectedIdentity[1]],
    reauthorize: () => {},
    execute: () => undefined,
  })).rejects.toThrow(message)
  gate.resolve()
  await first
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

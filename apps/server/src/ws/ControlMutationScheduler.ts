// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 控制变更调度器
//
//   文件:       ControlMutationScheduler.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

export const DEFAULT_CONTROL_MUTATION_LIMITS = Object.freeze({
  perConnection: 128,
  process: 2_048,
  perResource: 128,
  waitTimeoutMs: 30_000,
})

export interface ControlMutationLimits {
  perConnection: number
  process: number
  perResource: number
  waitTimeoutMs: number
}

export interface ScheduleControlMutation<T> {
  connectionId: string
  resourceKeys: readonly string[]
  signal?: AbortSignal
  reauthorize(): Promise<void> | void
  execute(signal: AbortSignal): Promise<T> | T
}

export class ControlMutationOverloadedError extends Error {
  readonly code = 'overloaded'

  constructor(message = '控制面变更队列已满，请稍后重试。') {
    super(message)
    this.name = 'ControlMutationOverloadedError'
  }
}

export class ControlMutationCancelledError extends Error {
  readonly code = 'cancelled'

  constructor(message = '连接已断开，排队中的变更已取消。') {
    super(message)
    this.name = 'ControlMutationCancelledError'
  }
}

interface PendingMutation {
  readonly connectionId: string
  readonly resourceKeys: readonly string[]
  readonly controller: AbortController
  state: 'queued' | 'running' | 'settled'
  timeout: ReturnType<typeof setTimeout> | null
  removeAbortListener: () => void
  start(): Promise<void>
  rejectQueued(error: Error): void
}

/**
 * 只调度控制面的写命令。资源键相同的命令严格按进入顺序互斥，不同资源可以
 * 并行；排队完成后、真正执行前必须再次授权。调度器从不重试 handler。
 */
export class ControlMutationScheduler {
  private readonly limits: ControlMutationLimits
  private readonly queue: PendingMutation[] = []
  private readonly activeResources = new Set<string>()
  private readonly activeByConnection = new Map<string, Set<PendingMutation>>()
  private readonly connectionCounts = new Map<string, number>()
  private readonly resourceCounts = new Map<string, number>()
  private outstanding = 0
  private draining = false

  constructor(limits: Partial<ControlMutationLimits> = {}) {
    this.limits = validateLimits({ ...DEFAULT_CONTROL_MUTATION_LIMITS, ...limits })
  }

  async schedule<T>(input: ScheduleControlMutation<T>): Promise<T> {
    const connectionId = requireIdentity(input.connectionId, 'connectionId')
    const resourceKeys = normalizeResourceKeys(input.resourceKeys)
    if (input.signal?.aborted) {
      return Promise.reject(new ControlMutationCancelledError())
    }
    this.assertCapacity(connectionId, resourceKeys)
    this.reserve(connectionId, resourceKeys)

    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController()
      let settled = false
      const settle = (result: { ok: true; value: T } | { ok: false; error: unknown }) => {
        if (settled) return
        settled = true
        if (result.ok) resolve(result.value)
        else reject(result.error)
      }
      const task: PendingMutation = {
        connectionId,
        resourceKeys,
        controller,
        state: 'queued',
        timeout: null,
        removeAbortListener: () => {},
        start: async () => {
          try {
            // 权限可能在排队期间撤销；handler 前必须使用当前会话和资源事实重验。
            await input.reauthorize()
            if (controller.signal.aborted) throw new ControlMutationCancelledError()
            const value = await input.execute(controller.signal)
            settle({ ok: true, value })
          } catch (error) {
            settle({ ok: false, error })
          } finally {
            this.finish(task)
          }
        },
        rejectQueued: error => settle({ ok: false, error }),
      }
      const abortQueued = () => {
        controller.abort(input.signal?.reason)
        if (task.state === 'queued') this.cancelQueued(task, new ControlMutationCancelledError())
      }
      if (input.signal) {
        input.signal.addEventListener('abort', abortQueued, { once: true })
        task.removeAbortListener = () => input.signal?.removeEventListener('abort', abortQueued)
      }
      task.timeout = setTimeout(() => {
        if (task.state !== 'queued') return
        this.cancelQueued(task, new ControlMutationOverloadedError('控制面变更排队超过 30 秒，请稍后重试。'))
      }, this.limits.waitTimeoutMs)
      this.queue.push(task)
      this.drain()
    })
  }

  /**
   * 断连只撤销尚未开始的变更；已经进入 handler 的事务不能被伪装成未执行。
   * 对正在执行的任务发出 AbortSignal，具体边界仍必须以业务事务结果为准。
   */
  cancelConnection(connectionId: string): void {
    const normalized = requireIdentity(connectionId, 'connectionId')
    // 必须整批移除后再 drain。若逐条取消时立即 drain，一个同时等待多个资源的
    // 请求被移除后，同连接的后续请求可能在断连清理尚未完成时抢先进入 handler。
    for (const task of [...this.queue]) {
      if (task.connectionId === normalized) {
        task.controller.abort(new ControlMutationCancelledError())
        this.cancelQueued(task, new ControlMutationCancelledError(), false)
      }
    }
    for (const task of this.activeByConnection.get(normalized) ?? []) {
      task.controller.abort(new ControlMutationCancelledError())
    }
    this.drain()
  }

  private assertCapacity(connectionId: string, resourceKeys: readonly string[]): void {
    if (this.outstanding >= this.limits.process) {
      throw new ControlMutationOverloadedError('控制面进程变更队列已满，请稍后重试。')
    }
    if ((this.connectionCounts.get(connectionId) ?? 0) >= this.limits.perConnection) {
      throw new ControlMutationOverloadedError('当前连接的变更队列已满，请等待已有操作完成。')
    }
    const saturated = resourceKeys.find(key => (
      (this.resourceCounts.get(key) ?? 0) >= this.limits.perResource
    ))
    if (saturated) {
      throw new ControlMutationOverloadedError('目标资源的变更队列已满，请稍后重试。')
    }
  }

  private reserve(connectionId: string, resourceKeys: readonly string[]): void {
    this.outstanding += 1
    this.connectionCounts.set(connectionId, (this.connectionCounts.get(connectionId) ?? 0) + 1)
    for (const key of resourceKeys) {
      this.resourceCounts.set(key, (this.resourceCounts.get(key) ?? 0) + 1)
    }
  }

  private release(task: PendingMutation): void {
    this.outstanding -= 1
    decrement(this.connectionCounts, task.connectionId)
    for (const key of task.resourceKeys) decrement(this.resourceCounts, key)
  }

  private drain(): void {
    if (this.draining) return
    this.draining = true
    try {
      const earlierBlockedResources = new Set<string>()
      for (let index = 0; index < this.queue.length;) {
        const task = this.queue[index]!
        const blocked = task.resourceKeys.some(key => (
          this.activeResources.has(key) || earlierBlockedResources.has(key)
        ))
        if (blocked) {
          for (const key of task.resourceKeys) earlierBlockedResources.add(key)
          index += 1
          continue
        }
        this.queue.splice(index, 1)
        task.state = 'running'
        if (task.timeout) clearTimeout(task.timeout)
        task.timeout = null
        for (const key of task.resourceKeys) this.activeResources.add(key)
        const active = this.activeByConnection.get(task.connectionId) ?? new Set<PendingMutation>()
        active.add(task)
        this.activeByConnection.set(task.connectionId, active)
        void task.start()
      }
    } finally {
      this.draining = false
    }
  }

  private cancelQueued(task: PendingMutation, error: Error, drain = true): void {
    if (task.state !== 'queued') return
    const index = this.queue.indexOf(task)
    if (index >= 0) this.queue.splice(index, 1)
    task.state = 'settled'
    if (task.timeout) clearTimeout(task.timeout)
    task.timeout = null
    task.removeAbortListener()
    this.release(task)
    task.rejectQueued(error)
    if (drain) this.drain()
  }

  private finish(task: PendingMutation): void {
    if (task.state !== 'running') return
    task.state = 'settled'
    task.removeAbortListener()
    for (const key of task.resourceKeys) this.activeResources.delete(key)
    const active = this.activeByConnection.get(task.connectionId)
    active?.delete(task)
    if (active?.size === 0) this.activeByConnection.delete(task.connectionId)
    this.release(task)
    this.drain()
  }
}

function validateLimits(limits: ControlMutationLimits): ControlMutationLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`ControlMutationScheduler 限额 '${name}' 必须是正整数。`)
    }
  }
  return Object.freeze({ ...limits })
}

function normalizeResourceKeys(keys: readonly string[]): string[] {
  const normalized = [...new Set(keys.map(key => requireIdentity(key, 'resourceKey')))].sort()
  if (normalized.length === 0) throw new Error('写命令必须声明至少一个资源键。')
  return normalized
}

function requireIdentity(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} 不能为空。`)
  return normalized
}

function decrement(counts: Map<string, number>, key: string): void {
  const next = (counts.get(key) ?? 0) - 1
  if (next > 0) counts.set(key, next)
  else counts.delete(key)
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 进程内后台任务观察注册表
//
//   文件:       backgroundTaskRegistry.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { nowUtc } from '../utils/ids.js'
import type { BackgroundTaskInfo } from './schemas.js'

export interface BackgroundTaskStartInput<T> {
  taskId: string
  label: string
  kind: string
  workspaceId?: string | null
  userId?: string | null
  metadata?: Record<string, unknown>
  run: (signal: AbortSignal) => Promise<T>
}

interface BackgroundTaskRecord<T = unknown> {
  info: BackgroundTaskInfo
  controller: AbortController
  promise: Promise<T>
}

// 这个 registry 只描述当前 Node 进程里正在跑的任务。持久化、重试、
// 调度锁由 pg-boss 负责，避免把两套事实源混在一起。
export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BackgroundTaskRecord>()

  start<T>(input: BackgroundTaskStartInput<T>): Promise<T> {
    if (this.tasks.has(input.taskId)) {
      throw new Error(`后台任务 '${input.taskId}' 已在运行。`)
    }
    const controller = new AbortController()
    const info: BackgroundTaskInfo = {
      taskId: input.taskId,
      kind: input.kind,
      label: input.label,
      status: 'running',
      workspaceId: input.workspaceId ?? null,
      userId: input.userId ?? null,
      runId: typeof input.metadata?.runId === 'string' ? input.metadata.runId : null,
      startedAt: nowUtc(),
      updatedAt: nowUtc(),
      completedAt: null,
      errorMessage: null,
      metadata: input.metadata ?? {},
    }
    const promise = input.run(controller.signal)
      .then(result => {
        this.update(input.taskId, controller.signal.aborted
          ? { status: 'cancelled', completedAt: nowUtc(), errorMessage: '任务已取消。' }
          : { status: 'completed', completedAt: nowUtc(), errorMessage: null })
        return result
      })
      .catch(error => {
        const message = controller.signal.aborted ? '任务已取消。' : formatTaskError(error)
        this.update(input.taskId, {
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          completedAt: nowUtc(),
          errorMessage: message,
        })
        throw error
      })
      .finally(() => {
        const record = this.tasks.get(input.taskId)
        if (record?.info.status !== 'running') {
          setTimeout(() => {
            const current = this.tasks.get(input.taskId)
            if (current?.info.status !== 'running') this.tasks.delete(input.taskId)
          }, 300_000).unref?.()
        }
      })
    this.tasks.set(input.taskId, { info, controller, promise })
    return promise
  }

  list(): BackgroundTaskInfo[] {
    return [...this.tasks.values()]
      .map(record => record.info)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  get(taskId: string): BackgroundTaskInfo | null {
    return this.tasks.get(taskId)?.info ?? null
  }

  cancel(taskId: string): BackgroundTaskInfo {
    const record = this.tasks.get(taskId)
    if (!record) throw new Error(`后台任务 '${taskId}' 不存在。`)
    if (record.info.status !== 'running') return record.info
    record.controller.abort()
    this.update(taskId, { status: 'cancelled', completedAt: nowUtc(), errorMessage: '任务已取消。' })
    return this.tasks.get(taskId)?.info ?? record.info
  }

  promote(taskId: string): BackgroundTaskInfo {
    const record = this.tasks.get(taskId)
    if (!record) throw new Error(`后台任务 '${taskId}' 不存在。`)
    return record.info
  }

  wait(taskId: string): Promise<unknown> {
    const record = this.tasks.get(taskId)
    if (!record) throw new Error(`后台任务 '${taskId}' 不存在。`)
    return record.promise
  }

  updateInfo(taskId: string, patch: Partial<Pick<BackgroundTaskInfo, 'runId' | 'metadata' | 'label'>>): void {
    this.update(taskId, patch)
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.tasks.values()].map(record => record.promise))
  }

  private update(taskId: string, patch: Partial<BackgroundTaskInfo>): void {
    const record = this.tasks.get(taskId)
    if (!record) return
    record.info = {
      ...record.info,
      ...patch,
      updatedAt: nowUtc(),
    }
  }
}

function formatTaskError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : '后台任务执行失败。'
}

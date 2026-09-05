// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久运行执行边界
//
//   文件:       RunEngine.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

/**
 * 当前进程内一个 Run 只能拥有一个活动执行器。数据库状态、恢复策略和终态
 * 仍由上层运行时持久化；本类只拥有执行租约、取消信号和外部信号解绑。
 */
export class RunEngine {
  private readonly activeExecutions = new Map<string, ActiveRunExecution>()

  start(runId: string, externalSignal?: AbortSignal): RunExecutionLease {
    if (this.activeExecutions.has(runId)) {
      throw new Error(`运行 '${runId}' 已有活动执行器`)
    }
    const controller = new AbortController()
    const unlinkExternalSignal = linkAbortSignal(externalSignal, controller)
    const active = { controller, unlinkExternalSignal }
    this.activeExecutions.set(runId, active)
    let closed = false
    return {
      signal: controller.signal,
      close: () => {
        if (closed) return
        closed = true
        active.unlinkExternalSignal()
        if (this.activeExecutions.get(runId) === active) {
          this.activeExecutions.delete(runId)
        }
      },
    }
  }

  abort(runId: string, reason?: unknown): boolean {
    const active = this.activeExecutions.get(runId)
    if (!active) return false
    active.controller.abort(reason)
    return true
  }

  isActive(runId: string): boolean {
    return this.activeExecutions.has(runId)
  }
}

export interface RunExecutionLease {
  signal: AbortSignal
  close(): void
}

interface ActiveRunExecution {
  controller: AbortController
  unlinkExternalSignal(): void
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {}
  const abortTarget = () => target.abort(source.reason)
  if (source.aborted) {
    abortTarget()
    return () => {}
  }
  source.addEventListener('abort', abortTarget, { once: true })
  return () => source.removeEventListener('abort', abortTarget)
}

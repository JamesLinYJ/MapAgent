// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具副作用原子提交器
//
//   文件:       ToolEffectCommitter.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ToolResult } from '../../framework/types.js'
import type {
  ToolResultCommitOutcome,
  ToolResultCommitService,
} from '../../tools/resultPersistence.js'
import { nowUtc } from '../../utils/ids.js'
import { ToolInvocationLedger } from './ToolInvocationLedger.js'

export interface CommitToolEffectInput {
  runId: string
  callId: string
  toolName: string
  toolLabel: string
  args: Record<string, unknown>
  result: ToolResult
  objectiveRevision: number
  checkpointImmediately: boolean
}

/**
 * Result builder may stage files before PostgreSQL, but the durable invocation terminal,
 * Run state, values, artifacts, outbox and result idempotency claim share one DB transaction.
 */
export class ToolEffectCommitter {
  private mutation: Promise<void> = Promise.resolve()

  constructor(
    private readonly ledger: ToolInvocationLedger,
    private readonly resultCommitService: Pick<ToolResultCommitService, 'commit'>,
  ) {}

  commit(input: CommitToolEffectInput): Promise<ToolResultCommitOutcome> {
    const pending = this.mutation.then(
      () => this.commitNow(input),
      () => this.commitNow(input),
    )
    this.mutation = pending.then(() => undefined, () => undefined)
    return pending
  }

  private async commitNow(input: CommitToolEffectInput): Promise<ToolResultCommitOutcome> {
    const current = await this.ledger.require(input.callId)
    if (current.terminalOutcome === 'succeeded' && current.resultId === input.result.resultId) {
      return { controlsApplied: false }
    }
    const invocation = await this.ledger.requireRunning(input.callId)
    if (invocation.objectiveRevision !== input.objectiveRevision) {
      throw new Error(
        `工具调用 '${input.callId}' 的 objective revision `
        + `${invocation.objectiveRevision} != ${input.objectiveRevision}`,
      )
    }
    return this.resultCommitService.commit({
      runId: input.runId,
      toolName: input.toolName,
      toolLabel: input.toolLabel,
      args: input.args,
      result: input.result,
      objectiveRevision: input.objectiveRevision,
      invocation: {
        invocationId: invocation.invocationId,
        expectedVersion: invocation.version,
        terminalAt: nowUtc(),
        checkpointImmediately: input.checkpointImmediately,
      },
    })
  }
}

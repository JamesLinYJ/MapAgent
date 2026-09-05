// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行引导控制器
//
//   文件:       runSteeringController.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import PQueue from 'p-queue'
import type { AgentInputItem } from '@openai/agents'

import type { AgentState, RunCheckpoint, RunGoal, RunSteeringRecord } from '../schemas/types.js'
import { runInputConversationItem } from '../store/runInputConversationItem.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import { makeId } from '../utils/ids.js'
import { advanceAgentWorkflowObjectiveRevision } from './agentWorkflowState.js'

type RunSteeringStore = Pick<AgentRuntimeStore,
  | 'activeTranscript'
  | 'appendItem'
  | 'enqueueRunInput'
  | 'getActiveModelRequest'
  | 'getRun'
  | 'getRunCheckpoint'
  | 'getRunInput'
  | 'leaseRunInputs'
  | 'listItems'
  | 'listModelRequests'
  | 'listRunInputs'
  | 'mutateRunState'
  | 'projectPersistedItems'
  | 'requeueLeasedRunInputs'
  | 'tryClaimTerminalInput'
>

interface ObjectiveRevisionSnapshot {
  checkpoint: RunCheckpoint
  state: AgentState
}

export interface ModelInputRevisionSnapshot {
  objectiveRevision: number
  inputCursor: number
  state: AgentState | null
}

export interface ModelInputRevisionBinding {
  objectiveRevision: number
  inputCursor: number
}

// RunSteeringController 是运行中用户消息的唯一状态机。
// PostgreSQL input sequence/cursor 是交付事实源；固定 entryId 和 itemId
// 让客户端重试与崩溃恢复幂等。
export class RunSteeringController {
  private readonly acceptingRuns = new Set<string>()
  private readonly queues = new Map<string, PQueue>()

  constructor(private readonly store: RunSteeringStore) {}

  async open(runId: string, options: { recoverLeased?: boolean } = {}): Promise<void> {
    await this.serialized(runId, async () => {
      const run = this.store.getRun(runId)
      if (run.status !== 'running') throw new Error(`运行 '${runId}' 当前不能接收引导消息`)
      if (options.recoverLeased) {
        await this.store.requeueLeasedRunInputs(runId)
      } else {
        const checkpoint = await this.store.getRunCheckpoint(runId)
        if (checkpoint.activeInputLeaseId) {
          throw new Error(
            `运行 '${runId}' 存在未恢复的输入 lease '${checkpoint.activeInputLeaseId}'`
            + '，普通 open 不得窃取恢复权。',
          )
        }
      }
      await this.reconcileInputItems(runId)
      const snapshot = await this.synchronizeObjectiveRevision(runId)
      if (snapshot.checkpoint.terminalInputClaimId) {
        this.acceptingRuns.delete(runId)
      } else {
        this.acceptingRuns.add(runId)
      }
    })
  }

  async enqueue(runId: string, steeringId: string, content: string): Promise<RunSteeringRecord> {
    return this.serialized(runId, async () => {
      const normalized = content.trim()
      if (!normalized) throw new Error('引导消息不能为空')

      const run = this.store.getRun(runId)
      if (!this.acceptingRuns.has(runId) || run.status !== 'running') {
        const existing = await this.store.getRunInput(runId, steeringId)
        if (existing) {
          if (existing.content !== normalized) {
            throw new Error(`引导消息 '${steeringId}' 的内容与首次提交不一致`)
          }
          await this.projectItems([existing])
          return existing
        }
        throw new Error(`运行 '${runId}' 已结束接收引导消息`)
      }
      if (!run.threadId) throw new Error(`运行 '${runId}' 缺少 threadId`)
      const transcript = await this.store.activeTranscript(run.threadId)
      const turnId = [...transcript].reverse().find(entry => (
        entry.runId === runId && entry.turnId
      ))?.turnId
      if (!turnId) throw new Error(`运行 '${runId}' 缺少可持久化的 turnId`)

      const record = await this.store.enqueueRunInput({
        inputId: steeringId,
        entryId: makeId('entry'),
        itemId: makeId('item'),
        runId,
        turnId,
        content: normalized,
      })
      await this.synchronizeObjectiveRevision(runId)
      await this.projectItems([record])
      return record
    })
  }

  async consumePending(runId: string): Promise<AgentInputItem[]> {
    return (await this.consumePendingWithRevision(runId)).items
  }

  async consumePendingWithRevision(runId: string): Promise<{
    items: AgentInputItem[]
    objectiveRevision: number
    leaseId: string | null
  }> {
    return this.serialized(runId, async () => {
      const leaseId = makeId('input_lease')
      const leased = await this.store.leaseRunInputs(runId, leaseId)
      const snapshot = await this.synchronizeObjectiveRevision(runId)
      await this.projectItems(leased)
      return {
        items: leased.map(runInputModelItem),
        objectiveRevision: snapshot.state.objectiveRevision,
        leaseId: leased.length ? leaseId : null,
      }
    })
  }

  // included 表示精确 ModelRequest 已提交、但 SDK checkpoint 尚未推进。
  // 恢复不能重新 lease 或按文本重建；必须按活动 lease 的持久身份把同一批
  // 输入重新放回公开 RunState，再由 ModelRequest Journal 重放 provider 请求。
  async replayIncludedInputs(runId: string, leaseId: string): Promise<{
    items: AgentInputItem[]
    objectiveRevision: number
  }> {
    return this.serialized(runId, async () => {
      const checkpoint = await this.store.getRunCheckpoint(runId)
      if (
        checkpoint.activeInputLeaseId !== leaseId
        || checkpoint.activeInputLeaseFrom !== checkpoint.checkpointInputCursor + 1
        || checkpoint.activeInputLeaseTo === null
      ) {
        throw new Error(`运行 '${runId}' 的 included 恢复 lease 与 checkpoint 不一致`)
      }
      const leaseFrom = checkpoint.activeInputLeaseFrom
      const leaseTo = checkpoint.activeInputLeaseTo
      const records = (await this.store.listRunInputs(runId))
        .filter(record => record.leaseId === leaseId)
        .sort((left, right) => left.inputSequence - right.inputSequence)
      const expectedCount = leaseTo - leaseFrom + 1
      if (records.length !== expectedCount) {
        throw new Error(`运行 '${runId}' 的 included 恢复输入存在空洞`)
      }
      const modelRequestIds = new Set(records.map(record => record.modelRequestId))
      records.forEach((record, index) => {
        if (
          record.status !== 'included'
          || !record.modelRequestId
          || record.inputSequence !== leaseFrom + index
        ) {
          throw new Error(`运行 '${runId}' 的 included 恢复输入状态不完整`)
        }
      })
      if (modelRequestIds.size !== 1) {
        throw new Error(`运行 '${runId}' 的 included 恢复输入未绑定同一 ModelRequest`)
      }
      const activeRequest = await this.store.getActiveModelRequest(runId)
      if (
        !activeRequest
        || !modelRequestIds.has(activeRequest.requestId)
        || activeRequest.inputEntryIds.length !== records.length
        || activeRequest.inputEntryIds.some((entryId, index) => entryId !== records[index]?.entryId)
      ) {
        throw new Error(`运行 '${runId}' 的 included 恢复输入与 ModelRequest 日志不一致`)
      }
      await this.projectItems(records)
      return {
        items: records.map(runInputModelItem),
        objectiveRevision: activeRequest.objectiveRevision,
      }
    })
  }

  async recordCheckpointedInputs(
    runId: string,
    records: readonly RunSteeringRecord[],
  ): Promise<void> {
    if (!records.length) return
    await this.serialized(runId, async () => {
      for (const record of records) {
        if (record.runId !== runId || record.status !== 'checkpointed') {
          throw new Error(`运行 '${runId}' 收到非当前 Run 的 input checkpoint 投影`)
        }
      }
      await this.projectItems(records)
    })
  }

  // 热路径一次读取即可同时得到模型已消费 revision 与其一致状态，避免每个
  // 模型候选为 revision/state 分别查询 durable run_inputs。
  async modelInputRevisionSnapshot(runId: string): Promise<ModelInputRevisionSnapshot> {
    return this.serialized(runId, async () => {
      const snapshot = await this.synchronizeObjectiveRevision(runId)
      const requests = await this.store.listModelRequests(runId)
      const request = requests.at(-1)
      if (!request) {
        throw new Error(`运行 '${runId}' 缺少可绑定终态候选的模型请求记录`)
      }
      const binding = {
        objectiveRevision: request.objectiveRevision,
        inputCursor: request.inputCursor,
      }
      return {
        ...binding,
        state: revisionMatches(snapshot, binding)
          ? structuredClone(snapshot.state)
          : null,
      }
    })
  }

  // 在 per-run steering 顺序内取得与 revision 一致的只读状态。调用方可在
  // Judge 之外执行昂贵工作；提交时仍必须再次走 commitRevision/terminal claim。
  async stateForRevision(runId: string, objectiveRevision: number): Promise<AgentState | null> {
    return this.serialized(runId, async () => {
      const snapshot = await this.synchronizeObjectiveRevision(runId)
      return snapshot.state.objectiveRevision === objectiveRevision
        ? structuredClone(snapshot.state)
        : null
    })
  }

  // 非终态 revision 提交与 steering 入队共享同一线性化队列。这样 Judge
  // 返回后不能把旧 verdict 写进新 objective revision。
  async commitRevision(
    runId: string,
    objectiveRevision: number,
    commit: (state: AgentState) => Promise<void>,
  ): Promise<boolean> {
    return this.serialized(runId, async () => {
      const snapshot = await this.synchronizeObjectiveRevision(runId)
      if (snapshot.state.objectiveRevision !== objectiveRevision) return false
      await commit(structuredClone(snapshot.state))
      return true
    })
  }

  // terminal claim 先核对 durable objective revision，再关闭接收窗口。成功后
  // 后续 enqueue 会被拒绝，终态持久化/flush 期间不会再出现未绑定的新输入。
  async tryClaimTerminal(runId: string, binding: ModelInputRevisionBinding): Promise<boolean> {
    return this.serialized(runId, async () => {
      const snapshot = await this.synchronizeObjectiveRevision(runId)
      const existingClaim = snapshot.checkpoint.terminalInputClaimId
      if (existingClaim) {
        const claimed = snapshot.state.objectiveRevision === binding.objectiveRevision
          && snapshot.checkpoint.nextInputSequence === binding.objectiveRevision
          && snapshot.checkpoint.terminalObjectiveRevision === binding.objectiveRevision
          && snapshot.checkpoint.terminalInputCursor === binding.inputCursor
          && snapshot.checkpoint.checkpointInputCursor === binding.inputCursor
          && snapshot.checkpoint.activeInputLeaseId === null
        if (claimed) this.acceptingRuns.delete(runId)
        return claimed
      }
      if (!revisionMatches(snapshot, binding)) return false
      const claimed = await this.store.tryClaimTerminalInput({
        runId,
        claimId: makeId('terminal_claim'),
        ...binding,
      })
      if (claimed) this.acceptingRuns.delete(runId)
      return claimed
    })
  }

  async close(runId: string): Promise<void> {
    await this.serialized(runId, async () => {
      this.acceptingRuns.delete(runId)
    })
    const queue = this.queues.get(runId)
    if (queue) await queue.onIdle()
    if (this.queues.get(runId) === queue) this.queues.delete(runId)
  }

  private async projectItems(records: readonly RunSteeringRecord[]): Promise<void> {
    if (!records.length) return
    await this.store.projectPersistedItems(records.map(runInputConversationItem))
  }

  // input row/cursor 是事实源，ConversationItem 只是 UI 投影。checkpoint+ack
  // 已提交而进程尚未来得及投影时，显式 open/recovery 在冷路径确定性对账；
  // 热路径仍只使用 cursor，不扫描历史输入。
  private async reconcileInputItems(runId: string): Promise<void> {
    const [records, items] = await Promise.all([
      this.store.listRunInputs(runId),
      this.store.listItems(runId),
    ])
    const currentStatus = new Map(items.map(item => [item.itemId, item.status]))
    for (const record of records) {
      if (currentStatus.get(record.itemId) !== record.status) {
        // 仅兼容升级前可能缺失的投影。新协议在 input 状态事务内原子追加 item。
        await this.store.appendItem(runInputConversationItem(record))
      }
    }
  }

  private async synchronizeObjectiveRevision(runId: string): Promise<ObjectiveRevisionSnapshot> {
    const checkpoint = await this.store.getRunCheckpoint(runId)
    const durableRevision = checkpoint.nextInputSequence
    const current = this.store.getRun(runId).state
    if (current.objectiveRevision > durableRevision) {
      throw new Error(
        `运行 '${runId}' objective revision ${current.objectiveRevision} 超过 durable input revision ${durableRevision}`,
      )
    }
    if (current.objectiveRevision === durableRevision) return { checkpoint, state: current }

    const updated = await this.store.mutateRunState(runId, state => ({
      objectiveRevision: durableRevision,
      goal: advanceGoalObjectiveRevision(state.goal, durableRevision),
      agentWorkflow: state.agentWorkflow
        ? advanceAgentWorkflowObjectiveRevision(state.agentWorkflow, durableRevision)
        : null,
    }))
    return { checkpoint, state: updated.state }
  }

  private async serialized<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const queue = this.requireQueue(runId)
    const result = await queue.add(async () => ({ value: await work() }))
    if (!result) throw new Error(`运行 '${runId}' 的引导队列未返回结果`)
    return result.value
  }

  private requireQueue(runId: string): PQueue {
    const existing = this.queues.get(runId)
    if (existing) return existing
    const created = new PQueue({ concurrency: 1 })
    this.queues.set(runId, created)
    return created
  }
}

function runInputModelItem(record: RunSteeringRecord): AgentInputItem {
  return {
    type: 'message',
    role: 'user',
    content: record.content,
    providerData: {
      geoAgentRunInput: {
        runId: record.runId,
        inputId: record.steeringId,
        inputSequence: record.inputSequence,
      },
    },
  }
}

function revisionMatches(
  snapshot: ObjectiveRevisionSnapshot,
  binding: ModelInputRevisionBinding,
): boolean {
  return snapshot.state.objectiveRevision === binding.objectiveRevision
    && snapshot.checkpoint.nextInputSequence === binding.objectiveRevision
    && snapshot.checkpoint.checkpointInputCursor === binding.inputCursor
    && snapshot.checkpoint.activeInputLeaseId === null
    && snapshot.checkpoint.terminalInputClaimId === null
}

function advanceGoalObjectiveRevision(goal: RunGoal | null, objectiveRevision: number): RunGoal | null {
  if (!goal || objectiveRevision <= goal.objectiveRevision) return goal
  const updatedAt = new Date().toISOString()
  return {
    ...goal,
    objectiveRevision,
    status: 'active',
    recheckCount: 0,
    lastVerdict: null,
    failureReason: null,
    updatedAt,
    completedAt: null,
  }
}

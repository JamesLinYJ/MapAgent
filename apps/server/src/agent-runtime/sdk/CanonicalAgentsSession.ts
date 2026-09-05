// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK canonical replay Session
//
//   文件:       CanonicalAgentsSession.ts
//
//   日期:       2026年06月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { AgentInputItem, Session } from '@openai/agents'

export type SessionItemsObserver = (items: AgentInputItem[]) => Promise<void>

// CanonicalAgentsSession
//
// canonical transcript 仍是事实源；Session 只向 Runner 提供当前活动链快照。
// 可选 observer 仅用于 SDK Session 契约观测，不能承担平台事实投影。
export class CanonicalAgentsSession implements Session {
  private readonly appended: AgentInputItem[] = []
  private readonly retainedRunInputs = new Map<string, string>()
  private mutation: Promise<void> = Promise.resolve()

  constructor(
    private readonly sessionId: string,
    private readonly history: AgentInputItem[],
    private readonly observeItems: SessionItemsObserver = async () => undefined,
  ) {
    for (const item of history) {
      const key = platformRunInputKey(item)
      if (key) this.retainedRunInputs.set(key, JSON.stringify(item))
    }
  }

  async getSessionId(): Promise<string> {
    return this.sessionId
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    await this.mutation
    const items = [...this.history, ...this.appended]
    const selected = typeof limit === 'number' ? items.slice(-Math.max(0, limit)) : items
    return structuredClone(selected)
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    const input = structuredClone(items)
    const operation = this.mutation.then(() => this.addItemsOnce(input))
    this.mutation = operation.catch(() => undefined)
    return operation
  }

  private async addItemsOnce(items: AgentInputItem[]): Promise<void> {
    const replayableItems = items.filter(isReplayableSessionItem)
    const projectable: AgentInputItem[] = []
    for (const item of replayableItems) {
      if (platformRunInputKey(item)) {
        this.retainRunInputsOnce([item])
      } else {
        projectable.push(item)
      }
    }
    if (!projectable.length) return
    await this.observeItems(projectable)
    this.appended.push(...structuredClone(projectable))
  }

  // run_input 已由 PostgreSQL/transcript 原子持久化，不能再次投影；但 SDK
  // 每个外层 Runner 只持久化一次初始输入。显式保留到 Session，确保在同一
  // run 后续 Runner/repair 仍可重放，且 marker 让重复 addItems 保持幂等。
  async retainRunInputs(items: readonly AgentInputItem[]): Promise<void> {
    const input = structuredClone(items)
    const operation = this.mutation.then(() => {
      this.retainRunInputsOnce(input)
    })
    this.mutation = operation.catch(() => undefined)
    await operation
  }

  private retainRunInputsOnce(items: readonly AgentInputItem[]): void {
    for (const item of items) {
      const key = platformRunInputKey(item)
      if (!key) throw new Error('CanonicalAgentsSession 只能显式保留带 platform marker 的 run input')
      const serialized = JSON.stringify(item)
      const previous = this.retainedRunInputs.get(key)
      if (previous !== undefined) {
        if (previous !== serialized) throw new Error(`run input '${key}' 的 Session 内容不一致`)
        continue
      }
      this.retainedRunInputs.set(key, serialized)
      this.appended.push(structuredClone(item))
    }
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    let item: AgentInputItem | undefined
    const operation = this.mutation.then(() => {
      item = this.appended.pop()
    })
    this.mutation = operation.catch(() => undefined)
    await operation
    return item
  }

  async clearSession(): Promise<void> {
    const operation = this.mutation.then(() => {
      this.appended.length = 0
    })
    this.mutation = operation.catch(() => undefined)
    await operation
  }
}

function isReplayableSessionItem(item: AgentInputItem): boolean {
  return item.type !== 'reasoning'
}

function platformRunInputKey(item: AgentInputItem): string | null {
  if (!('providerData' in item) || !item.providerData) return null
  const marker = item.providerData.geoAgentRunInput
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null
  const runId = Reflect.get(marker, 'runId')
  const inputSequence = Reflect.get(marker, 'inputSequence')
  return typeof runId === 'string'
    && Number.isInteger(inputSequence)
    && (inputSequence as number) > 0
    ? `${runId}:${inputSequence as number}`
    : null
}

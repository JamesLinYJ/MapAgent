// +-------------------------------------------------------------------------
//
//   地理智能平台 - 增量对话投影索引
//
//   文件:       projection.ts
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import type {
  ConversationItem,
  ConversationItemTextDelta,
} from '@geo-agent-platform/shared-types'

export type ConversationProjectionSource = 'canonical' | 'live'

export interface ConversationProjectionStats {
  upserts: number
  removals: number
  comparisons: number
  materializations: number
}

type ConversationProjectionListener = () => void

export type ConversationDeltaApplyResult =
  | 'applied'
  | 'duplicate'
  | 'missing_item'
  | 'sequence_gap'
  | 'offset_gap'
  | 'content_conflict'

/**
 * 对话实时流的可重建索引。
 *
 * `itemsById` 是 itemId 的唯一索引，`orderedIds` 始终保持基础比较器顺序，
 * `transcriptEntryIndex` 负责 canonical 与 live overlay 的替换关系。调用方
 * 不需要在每个 run.item 到达时重新扫描、排序完整 ConversationItem[]。关联
 * 工具调用的 assistant preamble 只在物化快照时做稳定投影，不能破坏二分插入
 * 依赖的全局有序不变量。
 */
export class ConversationProjectionIndex {
  private readonly itemsById = new Map<string, ConversationItem>()
  private readonly orderedIds: string[] = []
  private readonly transcriptEntryIndex = new Map<string, string>()
  private readonly transcriptEntryMembers = new Map<string, Set<string>>()
  private readonly itemTranscriptEntry = new Map<string, string>()
  private readonly activeSources = new Map<string, ConversationProjectionSource>()
  private readonly lastDeltaSequences = new Map<string, number>()
  private readonly sourceRecords: Record<ConversationProjectionSource, Map<string, ConversationItem>> = {
    canonical: new Map<string, ConversationItem>(),
    live: new Map<string, ConversationItem>(),
  }
  private readonly sourceItems: Record<ConversationProjectionSource, Set<string>> = {
    canonical: new Set<string>(),
    live: new Set<string>(),
  }
  private snapshot: ConversationItem[] | null = null
  private readonly counters: ConversationProjectionStats = {
    upserts: 0,
    removals: 0,
    comparisons: 0,
    materializations: 0,
  }

  constructor(items: ReadonlyArray<ConversationItem> = [], source: ConversationProjectionSource = 'canonical') {
    this.replaceSource(source, items)
  }

  get size(): number {
    return this.orderedIds.length
  }

  getItem(itemId: string): ConversationItem | undefined {
    return this.itemsById.get(itemId)
  }

  /** 返回稳定的展示快照；没有更新时复用同一个数组。 */
  toArray(): ConversationItem[] {
    if (!this.snapshot) {
      this.snapshot = this.presentationOrderedIds().flatMap(itemId => {
        const item = this.itemsById.get(itemId)
        return item ? [item] : []
      })
      this.counters.materializations += 1
    }
    return this.snapshot
  }

  /** 返回索引的只读视图，供调试和架构测试验证边界。 */
  getIndexSnapshot(): {
    itemsById: ReadonlyMap<string, ConversationItem>
    orderedIds: readonly string[]
    transcriptEntryIndex: ReadonlyMap<string, string>
  } {
    return {
      itemsById: this.itemsById,
      orderedIds: this.orderedIds,
      transcriptEntryIndex: this.transcriptEntryIndex,
    }
  }

  getStats(): ConversationProjectionStats {
    return { ...this.counters }
  }

  /**
   * 将一个来源的当前快照同步到索引。
   *
   * 这不是全量重建：未变化的 item 保留原索引，删除项只从其来源拥有的集合中
   * 移除，新增/变更项走单条 upsert。适合 canonical 历史刷新和 live 流切换。
   */
  replaceSource(source: ConversationProjectionSource, items: ReadonlyArray<ConversationItem>): void {
    const incomingIds = new Set(items.map(item => item.itemId))
    for (const itemId of this.sourceItems[source]) {
      if (!incomingIds.has(itemId)) this.removeSourceItem(itemId, source)
    }
    for (const item of items) this.upsert(item, source)
  }

  upsert(item: ConversationItem, source: ConversationProjectionSource = 'live'): void {
    const previous = this.sourceRecords[source].get(item.itemId)
    if (previous === item || (previous && sameConversationItemVersion(previous, item))) return
    this.lastDeltaSequences.delete(item.itemId)
    this.counters.upserts += 1

    const activeSource = this.activeSources.get(item.itemId)
    if (activeSource === source) this.deactivate(item.itemId)
    this.sourceRecords[source].set(item.itemId, item)
    this.sourceItems[source].add(item.itemId)

    const transcriptId = transcriptEntryId(item)
    const existingIdsForTranscript = transcriptId
      ? [...this.transcriptEntryMembers.get(transcriptId) ?? []].filter(itemId => itemId !== item.itemId)
      : []
    const conflictingIds = existingIdsForTranscript.filter(itemId => this.activeSources.get(itemId) !== source)
    if (conflictingIds.length > 0) {
      const existingSources = conflictingIds
        .map(itemId => this.activeSources.get(itemId))
        .filter((existingSource): existingSource is ConversationProjectionSource => Boolean(existingSource))
      if (existingSources.some(existingSource => sourceRank(existingSource) > sourceRank(source))) return
      for (const existingId of conflictingIds) {
        this.deactivate(existingId)
      }
    }

    const currentSource = this.activeSources.get(item.itemId)
    if (currentSource && sourceRank(currentSource) > sourceRank(source)) return

    this.activate(item, source)
  }

  upsertMany(items: ReadonlyArray<ConversationItem>, source: ConversationProjectionSource = 'live'): void {
    for (const item of items) this.upsert(item, source)
  }

  /**
   * 仅在 sequence 与 UTF-16 offset 连续时原位追加正文。正文变化不影响排序或
   * transcript 身份，因此直接更新双索引，避免每个 delta 都执行 O(n) deactivate。
   */
  appendTextDelta(
    delta: ConversationItemTextDelta,
    source: ConversationProjectionSource = 'live',
  ): ConversationDeltaApplyResult {
    const current = this.itemsById.get(delta.itemId)
    if (!current || current.runId !== delta.runId) return 'missing_item'
    const body = current.body ?? ''
    if (delta.utf16Offset < body.length) {
      const existing = body.slice(delta.utf16Offset, delta.utf16Offset + delta.text.length)
      if (existing !== delta.text) return 'content_conflict'
      const previousSequence = this.lastDeltaSequences.get(delta.itemId) ?? 0
      this.lastDeltaSequences.set(delta.itemId, Math.max(previousSequence, delta.sequence))
      return 'duplicate'
    }
    if (delta.utf16Offset > body.length) return 'offset_gap'

    const previousSequence = this.lastDeltaSequences.get(delta.itemId)
    if (previousSequence !== undefined && delta.sequence !== previousSequence + 1) {
      return 'sequence_gap'
    }

    const nextBody = body + delta.text
    const next: ConversationItem = {
      ...current,
      body: nextBody,
    }
    if (this.activeSources.get(delta.itemId) === source) {
      this.sourceRecords[source].set(delta.itemId, next)
      this.itemsById.set(delta.itemId, next)
      this.snapshot = null
      this.counters.upserts += 1
    } else {
      this.upsert(next, source)
    }
    this.lastDeltaSequences.set(delta.itemId, delta.sequence)
    return 'applied'
  }

  remove(itemId: string): void {
    this.lastDeltaSequences.delete(itemId)
    for (const source of ['canonical', 'live'] as const) {
      if (this.sourceRecords[source].has(itemId)) this.removeSourceItem(itemId, source)
    }
    if (this.itemsById.has(itemId)) this.deactivate(itemId)
  }

  private removeSourceItem(itemId: string, source: ConversationProjectionSource): void {
    const item = this.sourceRecords[source].get(itemId)
    if (!item) {
      this.sourceItems[source].delete(itemId)
      return
    }
    this.sourceRecords[source].delete(itemId)
    this.sourceItems[source].delete(itemId)
    if (this.activeSources.get(itemId) === source) this.deactivate(itemId)
    if (!this.activeSources.has(itemId)) this.activateFallbackForItemId(itemId)
    const transcriptId = transcriptEntryId(item)
    if (transcriptId && !this.transcriptEntryIndex.has(transcriptId)) this.activateFallback(transcriptId)
  }

  private activate(item: ConversationItem, source: ConversationProjectionSource): void {
    if (this.itemsById.has(item.itemId)) this.deactivate(item.itemId)
    this.itemsById.set(item.itemId, item)
    this.activeSources.set(item.itemId, source)
    this.indexItem(item)
    this.insertOrderedId(item.itemId)
    this.snapshot = null
  }

  private activateFallback(transcriptId: string): void {
    for (const source of ['live', 'canonical'] as const) {
      for (const candidate of this.sourceRecords[source].values()) {
        if (transcriptEntryId(candidate) !== transcriptId || this.activeSources.has(candidate.itemId)) continue
        this.activate(candidate, source)
      }
    }
  }

  private activateFallbackForItemId(itemId: string): void {
    for (const source of ['live', 'canonical'] as const) {
      const candidate = this.sourceRecords[source].get(itemId)
      if (candidate) {
        this.activate(candidate, source)
        return
      }
    }
  }

  private deactivate(itemId: string): void {
    if (!this.itemsById.has(itemId)) return
    this.counters.removals += 1
    const position = this.orderedIds.indexOf(itemId)
    if (position >= 0) this.orderedIds.splice(position, 1)
    const item = this.itemsById.get(itemId)
    if (item) this.unindexItem(item)
    this.itemsById.delete(itemId)
    this.activeSources.delete(itemId)
    this.snapshot = null
  }

  private indexItem(item: ConversationItem): void {
    const transcriptId = transcriptEntryId(item)
    if (transcriptId) {
      this.transcriptEntryIndex.set(transcriptId, item.itemId)
      this.itemTranscriptEntry.set(item.itemId, transcriptId)
      const members = this.transcriptEntryMembers.get(transcriptId) ?? new Set<string>()
      members.add(item.itemId)
      this.transcriptEntryMembers.set(transcriptId, members)
    }
  }

  private unindexItem(item: ConversationItem): void {
    const transcriptId = this.itemTranscriptEntry.get(item.itemId)
    if (transcriptId && this.transcriptEntryIndex.get(transcriptId) === item.itemId) {
      const members = this.transcriptEntryMembers.get(transcriptId)
      const remaining = members ? [...members].filter(itemId => itemId !== item.itemId) : []
      const nextId = remaining.at(-1)
      if (nextId) this.transcriptEntryIndex.set(transcriptId, nextId)
      else this.transcriptEntryIndex.delete(transcriptId)
    }
    if (transcriptId) {
      const members = this.transcriptEntryMembers.get(transcriptId)
      members?.delete(item.itemId)
      if (members && members.size === 0) this.transcriptEntryMembers.delete(transcriptId)
    }
    this.itemTranscriptEntry.delete(item.itemId)
  }

  private insertOrderedId(itemId: string): void {
    const item = this.itemsById.get(itemId)
    const lastItem = this.itemsById.get(this.orderedIds.at(-1) ?? '')
    if (item && lastItem) {
      this.counters.comparisons += 1
      if (compareConversationItems(lastItem, item) <= 0) {
        this.orderedIds.push(itemId)
        return
      }
    }
    let low = 0
    let high = this.orderedIds.length
    while (low < high) {
      const middle = (low + high) >>> 1
      const middleItem = this.itemsById.get(this.orderedIds[middle]!)
      if (!middleItem || !item) break
      this.counters.comparisons += 1
      if (compareConversationItems(middleItem, item) <= 0) low = middle + 1
      else high = middle
    }
    this.orderedIds.splice(low, 0, itemId)
  }

  private presentationOrderedIds(): string[] {
    const positions = new Map(this.orderedIds.map((itemId, index) => [itemId, index]))
    const firstToolIdByCall = new Map<string, string>()
    for (const itemId of this.orderedIds) {
      const item = this.itemsById.get(itemId)
      if (item?.itemType === 'function_call' && item.callId && !firstToolIdByCall.has(item.callId)) {
        firstToolIdByCall.set(item.callId, itemId)
      }
    }

    const preamblesByToolId = new Map<string, string[]>()
    const movedPreambleIds = new Set<string>()
    for (const itemId of this.orderedIds) {
      const item = this.itemsById.get(itemId)
      if (!item) continue
      const callId = assistantContentForCall(item)
      const toolId = callId ? firstToolIdByCall.get(callId) : undefined
      if (!toolId || (positions.get(itemId) ?? -1) < (positions.get(toolId) ?? -1)) continue
      const preambles = preamblesByToolId.get(toolId) ?? []
      preambles.push(itemId)
      preamblesByToolId.set(toolId, preambles)
      movedPreambleIds.add(itemId)
    }

    const projected: string[] = []
    for (const itemId of this.orderedIds) {
      if (movedPreambleIds.has(itemId)) continue
      projected.push(...preamblesByToolId.get(itemId) ?? [], itemId)
    }
    return projected
  }
}

/**
 * React 之外的时间线合并事务。
 *
 * canonical 与 live 的可变索引只能在事件或 effect 边界内更新；
 * React render 只通过 getSnapshot 读取稳定数组，避免被放弃的并发渲染
 * 污染后续投影。
 */
export class ConversationTimelineProjectionStore {
  private readonly projection: ConversationProjectionIndex
  private readonly listeners = new Set<ConversationProjectionListener>()
  private snapshot: ConversationItem[]

  constructor(
    canonical: ReadonlyArray<ConversationItem> = [],
    liveOverlay: ReadonlyArray<ConversationItem> = [],
  ) {
    this.projection = new ConversationProjectionIndex(canonical, 'canonical')
    this.projection.replaceSource('live', liveOverlay)
    this.snapshot = this.projection.toArray()
  }

  getSnapshot = (): ConversationItem[] => this.snapshot

  subscribe = (listener: ConversationProjectionListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  replaceSources(
    canonical: ReadonlyArray<ConversationItem>,
    liveOverlay: ReadonlyArray<ConversationItem>,
  ): void {
    this.projection.replaceSource('canonical', canonical)
    this.projection.replaceSource('live', liveOverlay)
    const next = this.projection.toArray()
    if (next === this.snapshot) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  getStats(): ConversationProjectionStats {
    return this.projection.getStats()
  }
}

export function projectConversationItems(
  canonical: ReadonlyArray<ConversationItem>,
  liveOverlay: ReadonlyArray<ConversationItem>,
): ConversationItem[] {
  const projection = new ConversationProjectionIndex(canonical, 'canonical')
  projection.upsertMany(liveOverlay, 'live')
  return projection.toArray()
}

/**
 * 比较同一 ConversationItem 的协议可见版本。
 *
 * HTTP/IPC 快照会把未变化的 JSON 重新解析为新对象；仅比较引用会让所有历史
 * 消息失去对象身份。这里忽略对象键顺序，但保留数组顺序和每个协议字段的值。
 */
export function sameConversationItemVersion(
  left: ConversationItem,
  right: ConversationItem,
): boolean {
  if (left === right) return true
  if (
    left.itemId !== right.itemId
    || left.itemType !== right.itemType
    || left.runId !== right.runId
    || left.threadId !== right.threadId
    || left.turnId !== right.turnId
    || left.callId !== right.callId
    || left.role !== right.role
    || left.body !== right.body
    || left.name !== right.name
    || left.arguments !== right.arguments
    || left.output !== right.output
    || left.isError !== right.isError
    || left.phase !== right.phase
    || left.status !== right.status
    || left.timestamp !== right.timestamp
  ) return false
  return left.metadata === right.metadata
    || JSON.stringify(canonicalize(left.metadata)) === JSON.stringify(canonicalize(right.metadata))
}

function sourceRank(source: ConversationProjectionSource): number {
  return source === 'live' ? 2 : 1
}

function transcriptEntryId(item: ConversationItem): string | null {
  const value = item.metadata?.transcriptEntryId
  return typeof value === 'string' && value ? value : null
}

function assistantContentForCall(item: ConversationItem): string | null {
  if (item.itemType !== 'message') return null
  const value = item.metadata?.assistantContentForCallId
  return typeof value === 'string' && value ? value : null
}

function compareConversationItems(left: ConversationItem, right: ConversationItem): number {
  const leftTime = Date.parse(left.timestamp || '')
  const rightTime = Date.parse(right.timestamp || '')
  const safeLeftTime = Number.isFinite(leftTime) ? leftTime : 0
  const safeRightTime = Number.isFinite(rightTime) ? rightTime : 0
  if (safeLeftTime !== safeRightTime) return safeLeftTime - safeRightTime

  const leftSeq = metadataNumber(left, 'transcriptSeq')
  const rightSeq = metadataNumber(right, 'transcriptSeq')
  if (leftSeq !== rightSeq) return leftSeq - rightSeq

  const rank = itemRank(left) - itemRank(right)
  if (rank !== 0) return rank

  return left.itemId.localeCompare(right.itemId)
}

function metadataNumber(item: ConversationItem, key: string): number {
  const value = item.metadata?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
}

function itemRank(item: ConversationItem): number {
  if (item.itemType === 'message' && item.role === 'user') return 10
  if (item.itemType === 'reasoning') return 20
  if (item.itemType === 'message' && item.role === 'assistant') return 30
  if (item.itemType === 'function_call') return 40
  if (item.itemType === 'function_call_output') return 50
  if (item.itemType === 'result') return 60
  if (item.itemType === 'error') return 70
  return 80
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  )
}

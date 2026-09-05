// +-------------------------------------------------------------------------
//
//   地理智能平台 - 跨端运行实时流一致性投影
//
//   文件:       streamProjection.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  ConversationItem,
  ConversationItemTextDelta,
  RunItemStreamSnapshot,
  RunItemUpsert,
} from '@geo-agent-platform/shared-types'
import {
  ConversationProjectionIndex,
  sameConversationItemVersion,
  type ConversationDeltaApplyResult,
} from './projection.js'

type PendingRunItemUpdate =
  | { type: 'item'; update: RunItemUpsert }
  | { type: 'delta'; delta: ConversationItemTextDelta }

export type RunStreamApplyResult =
  | 'queued'
  | 'applied'
  | 'duplicate'
  | 'stream_mismatch'
  | 'cursor_conflict'
  | 'state_regression'
  | 'terminal_item'
  | ConversationDeltaApplyResult

export interface RunStreamSnapshotAcceptance {
  items: ConversationItem[]
  consistent: boolean
}

/**
 * 在订阅快照到达前暂存实时 push，并在快照之上按原接收顺序重放。
 * 同 stream 的旧快照不会覆盖更高 cursor；不同 stream 只能由权威快照重置。
 */
export class RunStreamProjection {
  private projection = new ConversationProjectionIndex([], 'live')
  private pending: PendingRunItemUpdate[] = []
  private snapshotReady = false
  private streamId: string | null = null
  private cursors = new Map<string, { sequence: number; utf16Offset: number }>()

  beginSnapshot(): void {
    this.snapshotReady = false
    this.pending = []
  }

  acceptSnapshot(
    items: ReadonlyArray<ConversationItem>,
    stream: RunItemStreamSnapshot,
  ): RunStreamSnapshotAcceptance {
    const previousProjection = this.projection
    const previousCursors = this.cursors
    const sameStream = this.streamId === stream.streamId
    const stableItems = items.map(item => {
      const previous = previousProjection.getItem(item.itemId)
      return previous && sameConversationItemVersion(previous, item) ? previous : item
    })
    const nextProjection = new ConversationProjectionIndex(stableItems, 'live')
    const nextCursors = new Map(stream.cursors.map(cursor => [cursor.itemId, {
      sequence: cursor.sequence,
      utf16Offset: cursor.utf16Offset,
    }]))
    let consistent = snapshotCursorsMatchItems(stableItems, nextCursors)
    if (sameStream) {
      for (const [itemId, previousCursor] of previousCursors) {
        const snapshotCursor = nextCursors.get(itemId)
        const previousItem = previousProjection.getItem(itemId)
        if (!previousItem) continue
        if (snapshotCursor && snapshotCursor.sequence > previousCursor.sequence) continue
        if (snapshotCursor?.sequence === previousCursor.sequence) {
          const snapshotItem = nextProjection.getItem(itemId)
          if (
            snapshotCursor.utf16Offset === previousCursor.utf16Offset
            && snapshotItem
            && sameConversationItemVersion(snapshotItem, previousItem)
          ) continue
          consistent = false
        }
        nextProjection.upsert(previousItem, 'live')
        nextCursors.set(itemId, previousCursor)
      }
    }
    this.projection = nextProjection
    this.cursors = nextCursors
    this.streamId = stream.streamId
    this.snapshotReady = true
    for (const update of this.pending) {
      const result = update.type === 'item'
        ? this.applyUpsert(update.update)
        : this.applyDelta(update.delta)
      if (!isSuccessfulRunStreamResult(result)) consistent = false
    }
    this.pending = []
    return { items: this.projection.toArray(), consistent }
  }

  /**
   * 订阅请求失败时退出 buffering，并在现有权威投影上重放期间收到的 push。
   * 不清空正文；若重放暴露缺口，由调用方重新订阅或重连。
   */
  abortSnapshot(): RunStreamSnapshotAcceptance {
    this.snapshotReady = true
    let consistent = this.streamId !== null
    for (const update of this.pending) {
      const result = update.type === 'item'
        ? this.applyUpsert(update.update)
        : this.applyDelta(update.delta)
      if (!isSuccessfulRunStreamResult(result)) consistent = false
    }
    this.pending = []
    return { items: this.projection.toArray(), consistent }
  }

  acceptItem(update: RunItemUpsert): RunStreamApplyResult {
    if (!this.snapshotReady) {
      this.pending.push({ type: 'item', update })
      return 'queued'
    }
    return this.applyUpsert(update)
  }

  acceptDelta(delta: ConversationItemTextDelta): RunStreamApplyResult {
    if (!this.snapshotReady) {
      this.pending.push({ type: 'delta', delta })
      return 'queued'
    }
    return this.applyDelta(delta)
  }

  toArray(): ConversationItem[] {
    return this.projection.toArray()
  }

  private applyUpsert(update: RunItemUpsert): RunStreamApplyResult {
    if (update.streamId !== this.streamId) return 'stream_mismatch'
    if (update.cursor.utf16Offset !== (update.item.body ?? '').length) return 'cursor_conflict'
    const currentCursor = this.cursors.get(update.item.itemId)
    const currentItem = this.projection.getItem(update.item.itemId)
    if (currentCursor && update.cursor.sequence < currentCursor.sequence) return 'duplicate'
    if (currentCursor && update.cursor.sequence === currentCursor.sequence) {
      return currentCursor.utf16Offset === update.cursor.utf16Offset
        && currentItem
        && sameConversationItemVersion(currentItem, update.item)
        ? 'duplicate'
        : 'cursor_conflict'
    }
    if (currentItem && isTerminalItemStatus(currentItem.status) && update.item.status === 'running') {
      return 'state_regression'
    }
    this.projection.upsert(update.item, 'live')
    this.cursors.set(update.item.itemId, update.cursor)
    return 'applied'
  }

  private applyDelta(delta: ConversationItemTextDelta): RunStreamApplyResult {
    if (delta.streamId !== this.streamId) return 'stream_mismatch'
    const cursor = this.cursors.get(delta.itemId)
    if (!cursor) return 'missing_item'
    if (delta.sequence < cursor.sequence) return 'duplicate'
    if (delta.sequence === cursor.sequence) {
      const currentBody = this.projection.getItem(delta.itemId)?.body ?? ''
      const deltaEnd = delta.utf16Offset + delta.text.length
      return cursor.utf16Offset === deltaEnd
        && currentBody.length === deltaEnd
        && currentBody.slice(delta.utf16Offset, deltaEnd) === delta.text
        ? 'duplicate'
        : 'cursor_conflict'
    }
    if (this.projection.getItem(delta.itemId)?.status !== 'running') return 'terminal_item'
    if (delta.sequence !== cursor.sequence + 1) return 'sequence_gap'
    if (delta.utf16Offset !== cursor.utf16Offset) return 'offset_gap'
    const result = this.projection.appendTextDelta(delta, 'live')
    if (result !== 'applied' && result !== 'duplicate') return result
    this.cursors.set(delta.itemId, {
      sequence: delta.sequence,
      utf16Offset: delta.utf16Offset + delta.text.length,
    })
    return result
  }
}

function isTerminalItemStatus(status: string | null): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function isSuccessfulRunStreamResult(result: RunStreamApplyResult): boolean {
  return result === 'queued' || result === 'applied' || result === 'duplicate'
}

function snapshotCursorsMatchItems(
  items: ReadonlyArray<ConversationItem>,
  cursors: ReadonlyMap<string, { sequence: number; utf16Offset: number }>,
): boolean {
  if (items.length !== cursors.size) return false
  const itemsById = new Map(items.map(item => [item.itemId, item]))
  for (const [itemId, cursor] of cursors) {
    const item = itemsById.get(itemId)
    if (!item || (item.body ?? '').length !== cursor.utf16Offset) return false
  }
  return true
}

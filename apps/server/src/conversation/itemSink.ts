// +-------------------------------------------------------------------------
//
//   地理智能平台 - ConversationItem 发布器
//
//   文件:       itemSink.ts
//
//   日期:       2026年06月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// ItemSink owns the UI item lifecycle for a single run. ConversationItem.timestamp
// means "first visible position in the timeline"; body/status/metadata updates must
// not move an item after later tools or messages.

import type { ConversationItem } from '../schemas/types.js'
import { makeId, nowUtc } from '../utils/ids.js'
import type { ConversationItemWrite } from './itemUpdates.js'
import { OrderedWriteBuffer } from './orderedWriteBuffer.js'

type AppendItemUpdate = (update: ConversationItemWrite) => void | Promise<void>

export class ItemSink {
  private textBuffers = new Map<string, string[]>()
  private itemDrafts = new Map<string, ConversationItem>()
  private itemSnapshots = new Map<string, ConversationItem>()
  private readonly writes = new OrderedWriteBuffer()

  constructor(
    private appendUpdate: AppendItemUpdate,
    private runId: string,
    private threadId: string | null,
    private turnId: string,
  ) {
    if (!turnId.trim()) throw new Error(`Run '${runId}' 的 ItemSink 缺少有效 turnId`)
  }

  appendUserMessage(text: string, metadata: Record<string, unknown> = {}): ConversationItem {
    const item: ConversationItem = {
      itemId: makeId('item'), itemType: 'message', runId: this.runId,
      threadId: this.threadId, role: 'user', body: text,
      isError: false, timestamp: nowUtc(),
      turnId: this.turnId, callId: null, name: null, arguments: null,
      output: null, phase: null, status: 'completed', metadata,
    }
    return this.publish(item)
  }

  appendAssistantMessage(text: string, metadata: Record<string, unknown> = {}): ConversationItem {
    const item: ConversationItem = {
      itemId: makeId('item'), itemType: 'message', runId: this.runId,
      threadId: this.threadId, role: 'assistant', body: text,
      isError: false, timestamp: nowUtc(),
      turnId: this.turnId, callId: null, name: null, arguments: null,
      output: null, phase: null, status: 'completed', metadata,
    }
    return this.publish(item)
  }

  startItem(itemType: ConversationItem['itemType'], opts: {
    itemId?: string
    role?: string
    name?: string
    callId?: string
    arguments?: string
    metadata?: Record<string, unknown>
  } = {}): ConversationItem {
    const item: ConversationItem = {
      itemId: opts.itemId ?? makeId('item'), itemType,
      runId: this.runId, threadId: this.threadId,
      role: opts.role ?? null, name: opts.name ?? null,
      callId: opts.callId ?? null, arguments: opts.arguments ?? null,
      body: null, output: null, turnId: this.turnId,
      status: 'running', isError: false,
      phase: itemType === 'reasoning' ? 'commentary' : null,
      metadata: opts.metadata ?? {},
      timestamp: nowUtc(),
    }
    this.itemDrafts.set(item.itemId, item)
    this.textBuffers.set(item.itemId, [])
    return this.publish(item)
  }

  deltaItem(itemId: string, text: string): void {
    if (!text) return
    if (!this.itemDrafts.has(itemId)) {
      throw new Error(`不能向未启动或已完成的 ConversationItem '${itemId}' 追加文本`)
    }
    for (const chunk of splitTextDelta(text)) {
      this.textBuffers.get(itemId)?.push(chunk)
      this.writes.enqueue(() => this.appendUpdate({
        updateType: 'append_body',
        runId: this.runId,
        threadId: this.threadId,
        itemId,
        text: chunk,
      }))
    }
  }

  completeItem(itemId: string, opts: {
    body?: string
    output?: string
    isError?: boolean
    callId?: string
    name?: string
    metadata?: Record<string, unknown>
  } = {}): ConversationItem {
    const draft = this.itemDrafts.get(itemId)
    const previous = this.itemSnapshots.get(itemId)
    const base = draft ?? previous
    const itemType: ConversationItem['itemType'] = base?.itemType ?? 'message'
    const bufferedChunks = this.textBuffers.get(itemId)
    const body = bufferedChunks?.length
      ? bufferedChunks.join('')
      : opts.body ?? base?.body ?? ''
    const isError = opts.isError ?? base?.isError ?? false
    const status: ConversationItem['status'] = opts.isError !== undefined
      ? opts.isError ? 'failed' : 'completed'
      : base?.status && base.status !== 'running' ? base.status : 'completed'
    const item: ConversationItem = {
      itemId, itemType,
      runId: this.runId, threadId: this.threadId,
      role: base?.role ?? 'assistant', body,
      name: opts.name ?? base?.name ?? null, callId: opts.callId ?? base?.callId ?? null,
      output: opts.output ?? base?.output ?? null, isError,
      status,
      metadata: { ...(base?.metadata ?? {}), ...(opts.metadata ?? {}) },
      turnId: this.turnId, arguments: base?.arguments ?? null, phase: base?.phase ?? null,
      timestamp: base?.timestamp ?? nowUtc(),
    }
    const published = this.publish(item)
    this.releaseStreamState(itemId)
    return published
  }

  appendResult(
    resultType: 'success' | 'failed' | 'cancelled' | 'waiting_approval' | 'clarification_needed',
    payload: Record<string, unknown> = {},
  ): ConversationItem {
    const item: ConversationItem = {
      itemId: makeId('item'), itemType: 'result', runId: this.runId,
      threadId: this.threadId, body: null,
      status: resultType === 'success' ? 'completed' : resultType,
      isError: resultType === 'failed',
      metadata: { ...payload, resultType }, timestamp: nowUtc(),
      turnId: this.turnId, callId: null, role: null, name: null,
      arguments: null, output: null, phase: null,
    }
    return this.publish(item)
  }

  private publish(item: ConversationItem): ConversationItem {
    this.itemSnapshots.set(item.itemId, item)
    this.writes.enqueue(() => this.appendUpdate({ updateType: 'replace_item', item }))
    return item
  }

  private releaseStreamState(itemId: string): void {
    this.textBuffers.delete(itemId)
    this.itemDrafts.delete(itemId)
  }

  async flush(): Promise<void> {
    await this.writes.flush()
  }
}

const MAX_TEXT_DELTA_UTF8_BYTES = 16 * 1024

/**
 * 只拆分单次上游 delta，绝不跨 callback 合并或等待计时器。按 Unicode code
 * point 行进，保证代理对和 UTF-8 字节序列都不会被截断。
 */
function splitTextDelta(text: string): string[] {
  if (Buffer.byteLength(text, 'utf8') <= MAX_TEXT_DELTA_UTF8_BYTES) return [text]
  const chunks: string[] = []
  let start = 0
  let bytes = 0
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break
    const width = codePoint > 0xffff ? 2 : 1
    const codePointBytes = Buffer.byteLength(text.slice(index, index + width), 'utf8')
    if (bytes > 0 && bytes + codePointBytes > MAX_TEXT_DELTA_UTF8_BYTES) {
      chunks.push(text.slice(start, index))
      start = index
      bytes = 0
    }
    bytes += codePointBytes
    index += width
  }
  if (start < text.length) chunks.push(text.slice(start))
  return chunks
}

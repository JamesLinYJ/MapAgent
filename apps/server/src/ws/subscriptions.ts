// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 实时订阅
//
//   文件:       subscriptions.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 运行和线程事件的实时推送集中在这里。事实源仍是 PostgreSQL 仓储与
// 应用事件总线；WebSocket 只负责把已持久化或已发布的事件转成协议消息。

import { WebSocket } from 'ws'

import type {
  AnalysisRun,
  ConversationItem,
  RunItemStreamSnapshot,
  RunEvent,
} from '../schemas/types.js'
import type { PlatformEventHub } from '../store/platformEventHub.js'
import { push } from './protocol.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import {
  projectConversationItemForTransport,
  projectRunEventForTransport,
  projectRunSnapshotForTransport,
} from './runTransportProjection.js'

const MAX_WS_BUFFERED_BYTES = 8 * 1024 * 1024
const MAX_QUEUED_RUN_DELIVERY_BYTES = MAX_WS_BUFFERED_BYTES
const MAX_QUEUED_RUN_DELIVERY_SLOTS = 4_096
const runDeliveryStates = new WeakMap<WebSocket, RunDeliveryState>()
const runCaptureStates = new WeakMap<WebSocket, Map<string, RunCaptureQueue>>()

interface RunDeliveryState {
  queuedBytes: number
  slotCount: number
  queues: Map<string, RunDeliveryQueue>
}

interface RunDeliveryQueue {
  draining: boolean
  head: RunDeliverySlot | null
  tail: RunDeliverySlot | null
}

interface RunDeliverySlot {
  message: { body: string; byteLength: number } | null
  next: RunDeliverySlot | null
}

interface RunCaptureQueue {
  running: boolean
  head: RunCaptureSlot | null
  tail: RunCaptureSlot | null
}

interface RunCaptureSlot {
  operation: (() => Promise<unknown> | unknown) | null
  resolve: ((value: unknown) => void) | null
  reject: ((error: unknown) => void) | null
  cancelled: boolean
  next: RunCaptureSlot | null
}

export interface ReservedRunCapture<T> {
  deliver(message: string): void
  start(capture: () => Promise<T> | T): Promise<T>
  cancel(): void
}

export interface RunSubscriptionStore {
  getRun(runId: string): AnalysisRun
  getThread(threadId: string): unknown
  listPresentationSnapshot(runId: string): Promise<{
    items: ConversationItem[]
    events: RunEvent[]
    itemStream: RunItemStreamSnapshot
    sourceSequence: number
  }>
}

export function subscribeToRun(
  ws: WebSocket,
  runId: string,
  store: RunSubscriptionStore,
  events: PlatformEventHub,
  subscriptions: Map<string, () => void>,
): void {
  store.getRun(runId)
  if (subscriptions.has(runId)) return
  const unsubscribeItem = events.conversationItemUpserts.subscribe(
    runId,
    update => {
      const item = projectConversationItemForTransport(update.item)
      sendRunWs(ws, runId, push('run.item', {
        ...update,
        cursor: { ...update.cursor, utf16Offset: (item.body ?? '').length },
        item,
      }))
    },
  )
  const unsubscribeItemDelta = events.conversationItemDeltas.subscribe(
    runId,
    delta => sendRunWs(ws, runId, push('run.item.delta', delta)),
  )
  const unsubscribeEvent = events.runEvents.subscribe(
    runId,
    event => sendRunWs(ws, runId, push('run.event', projectRunEventForTransport(event))),
  )
  const unsubscribeRun = events.runs.subscribe(runId, () => void sendRunSnapshot(ws, runId, store))
  subscriptions.set(runId, () => {
    unsubscribeItem()
    unsubscribeItemDelta()
    unsubscribeEvent()
    unsubscribeRun()
  })
}

export function subscribeToThread(
  ws: WebSocket,
  threadId: string,
  store: RunSubscriptionStore,
  events: PlatformEventHub,
  subscriptions: Map<string, () => void>,
): void {
  store.getThread(threadId)
  const key = `thread:${threadId}`
  if (subscriptions.has(key)) return
  const unsubscribeEntry = events.threadEntries.subscribe(threadId, entry => sendWs(ws, push('thread.entry', entry)))
  const unsubscribeUpdate = events.threadUpdates.subscribe(threadId, update => sendWs(ws, push('thread.updated', update)))
  const unsubscribeCompact = events.threadCompactions.subscribe(threadId, record => sendWs(ws, push('thread.compacted', record)))
  const unsubscribeMemory = events.threadMemories.subscribe(threadId, memory => sendWs(ws, push('thread.memory.updated', memory)))
  const unsubscribeMapScene = events.mapScenes.subscribe(threadId, scene => sendWs(ws, push('map.scene.updated', scene)))
  subscriptions.set(key, () => {
    unsubscribeEntry()
    unsubscribeUpdate()
    unsubscribeCompact()
    unsubscribeMemory()
    unsubscribeMapScene()
  })
}

export async function snapshotRun(runId: string, store: RunSubscriptionStore) {
  const presentation = await store.listPresentationSnapshot(runId)
  return projectRunSnapshotForTransport({
    run: store.getRun(runId),
    items: presentation.items,
    events: presentation.events,
    itemStream: presentation.itemStream,
  })
}

export async function sendRunSnapshot(ws: WebSocket, runId: string, store: RunSubscriptionStore): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return
  const scheduled = reserveRunCapture<Awaited<ReturnType<typeof snapshotRun>>>(ws, runId)
  try {
    const snapshot = await scheduled.start(() => snapshotRun(runId, store))
    scheduled.deliver(push('run.snapshot', snapshot))
  } catch (error) {
    if (ws.readyState !== WebSocket.OPEN) return
    logger.warn({ error: errorLogPayload(error), runId }, 'run snapshot projection failed')
    terminateConnection(ws)
  }
}

/** Atomically reserve matching positions in the delivery FIFO and capture FIFO. */
export function reserveRunCapture<T>(ws: WebSocket, runId: string): ReservedRunCapture<T> {
  if (ws.readyState !== WebSocket.OPEN) return closedRunCaptureReservation()
  const deliver = reserveRunDelivery(ws, runId)
  if (!runDeliveryStates.has(ws)) return closedRunCaptureReservation()

  let connectionQueues = runCaptureStates.get(ws)
  if (!connectionQueues) {
    connectionQueues = new Map<string, RunCaptureQueue>()
    runCaptureStates.set(ws, connectionQueues)
  }
  let queue = connectionQueues.get(runId)
  if (!queue) {
    queue = { running: false, head: null, tail: null }
    connectionQueues.set(runId, queue)
  }
  const slot: RunCaptureSlot = {
    operation: null,
    resolve: null,
    reject: null,
    cancelled: false,
    next: null,
  }
  if (queue.tail) queue.tail.next = slot
  else queue.head = slot
  queue.tail = slot

  let result: Promise<T> | null = null
  return {
    deliver,
    start(capture) {
      if (result) return result
      if (slot.cancelled) return Promise.reject(new Error('Run capture reservation was cancelled.'))
      slot.operation = capture
      result = new Promise<T>((resolve, reject) => {
        slot.resolve = value => resolve(value as T)
        slot.reject = reject
      })
      drainRunCapture(ws, runId, queue)
      return result
    },
    cancel() {
      if (result || slot.cancelled) return
      slot.cancelled = true
      drainRunCapture(ws, runId, queue)
    },
  }
}

function closedRunCaptureReservation<T>(): ReservedRunCapture<T> {
  return {
    deliver: () => {},
    start: () => Promise.reject(new Error('WebSocket connection is closed.')),
    cancel: () => {},
  }
}

function drainRunCapture(ws: WebSocket, runId: string, queue: RunCaptureQueue): void {
  if (queue.running) return
  while (queue.head?.cancelled) detachCaptureHead(ws, runId, queue, queue.head)
  const slot = queue.head
  if (!slot || !slot.operation) return
  if (ws.readyState !== WebSocket.OPEN) {
    const reject = slot.reject
    detachCaptureHead(ws, runId, queue, slot)
    reject?.(new Error('WebSocket connection is closed.'))
    drainRunCapture(ws, runId, queue)
    return
  }

  queue.running = true
  let captured: Promise<unknown>
  try {
    captured = Promise.resolve(slot.operation())
  } catch (error) {
    captured = Promise.reject(error)
  }
  void captured.then(
    value => settleRunCapture(ws, runId, queue, slot, { value }),
    error => settleRunCapture(ws, runId, queue, slot, { error }),
  )
}

function settleRunCapture(
  ws: WebSocket,
  runId: string,
  queue: RunCaptureQueue,
  slot: RunCaptureSlot,
  outcome: { value: unknown } | { error: unknown },
): void {
  const resolve = slot.resolve
  const reject = slot.reject
  if (!detachCaptureHead(ws, runId, queue, slot)) return
  if ('error' in outcome) reject?.(outcome.error)
  else resolve?.(outcome.value)
  drainRunCapture(ws, runId, queue)
}

function detachCaptureHead(
  ws: WebSocket,
  runId: string,
  queue: RunCaptureQueue,
  slot: RunCaptureSlot,
): boolean {
  const connectionQueues = runCaptureStates.get(ws)
  if (connectionQueues?.get(runId) !== queue || queue.head !== slot) return false
  queue.head = slot.next
  if (!queue.head) queue.tail = null
  queue.running = false
  slot.operation = null
  slot.resolve = null
  slot.reject = null
  slot.next = null
  if (!queue.head) {
    connectionQueues.delete(runId)
    if (connectionQueues.size === 0) runCaptureStates.delete(ws)
  }
  return true
}

/**
 * Reserve one FIFO position before starting asynchronous work. Filling the
 * returned slot later cannot overtake an older unfinished delivery for the same
 * WebSocket/run pair. The returned sender is single-use and never throws.
 */
export function reserveRunDelivery(ws: WebSocket, runId: string): (message: string) => void {
  if (ws.readyState !== WebSocket.OPEN) return () => {}
  let state = runDeliveryStates.get(ws)
  if (!state) {
    state = { queuedBytes: 0, slotCount: 0, queues: new Map<string, RunDeliveryQueue>() }
    runDeliveryStates.set(ws, state)
  }
  if (state.slotCount >= MAX_QUEUED_RUN_DELIVERY_SLOTS) {
    logger.warn({ queuedSlots: state.slotCount, runId }, 'run delivery slot limit exceeded')
    terminateConnection(ws)
    return () => {}
  }
  let queue = state.queues.get(runId)
  if (!queue) {
    queue = { draining: false, head: null, tail: null }
    state.queues.set(runId, queue)
  }
  const slot: RunDeliverySlot = { message: null, next: null }
  if (queue.tail) queue.tail.next = slot
  else queue.head = slot
  queue.tail = slot
  state.slotCount += 1

  let filled = false
  return message => {
    if (filled) return
    filled = true
    const currentState = runDeliveryStates.get(ws)
    if (currentState !== state || state.queues.get(runId) !== queue) return
    const byteLength = Buffer.byteLength(message, 'utf8')
    const socketBufferedBytes = ws.bufferedAmount ?? 0
    if (socketBufferedBytes + state.queuedBytes + byteLength > MAX_QUEUED_RUN_DELIVERY_BYTES) {
      logger.warn({ queuedBytes: state.queuedBytes, socketBufferedBytes, runId }, 'run delivery buffer exceeded')
      terminateConnection(ws)
      return
    }
    slot.message = { body: message, byteLength }
    state.queuedBytes += byteLength
    drainRunDelivery(ws, runId, state, queue)
  }
}

/** Reserve and immediately fill a FIFO slot for a ready run-scoped push. */
export function sendRunWs(ws: WebSocket, runId: string, message: string): void {
  reserveRunDelivery(ws, runId)(message)
}

function drainRunDelivery(
  ws: WebSocket,
  runId: string,
  state: RunDeliveryState,
  queue: RunDeliveryQueue,
): void {
  if (queue.draining) return
  queue.draining = true
  try {
    while (
      runDeliveryStates.get(ws) === state
      && state.queues.get(runId) === queue
    ) {
      const slot = queue.head
      const message = slot?.message
      if (!message) break
      queue.head = slot.next
      if (!queue.head) queue.tail = null
      slot.message = null
      slot.next = null
      state.queuedBytes -= message.byteLength
      state.slotCount -= 1
      sendWs(ws, message.body)
    }
  } finally {
    queue.draining = false
    if (runDeliveryStates.get(ws) !== state || state.queues.get(runId) !== queue) return
    if (!queue.head) state.queues.delete(runId)
    if (state.queues.size === 0) runDeliveryStates.delete(ws)
  }
}

export function sendWs(ws: WebSocket, message: string): void {
  if (ws.readyState !== WebSocket.OPEN) return
  const bufferedAmount = ws.bufferedAmount ?? 0
  const queuedRunBytes = runDeliveryStates.get(ws)?.queuedBytes ?? 0
  const byteLength = Buffer.byteLength(message, 'utf8')
  if (bufferedAmount + queuedRunBytes + byteLength > MAX_WS_BUFFERED_BYTES) {
    logger.warn({ bufferedAmount, queuedRunBytes }, 'ws send buffer exceeded')
    terminateConnection(ws)
    return
  }
  try {
    ws.send(message, error => {
      if (!error) return
      logger.warn({ error: errorLogPayload(error) }, 'ws send failed')
      terminateConnection(ws)
    })
  } catch (error) {
    logger.warn({ error: errorLogPayload(error) }, 'ws send failed synchronously')
    terminateConnection(ws)
  }
}

export function clearRunDeliveries(ws: WebSocket): void {
  const state = runDeliveryStates.get(ws)
  if (state) {
    for (const queue of state.queues.values()) {
      let slot = queue.head
      while (slot) {
        const next = slot.next
        slot.message = null
        slot.next = null
        slot = next
      }
      queue.head = null
      queue.tail = null
      queue.draining = false
    }
    state.queues.clear()
    state.queuedBytes = 0
    state.slotCount = 0
    runDeliveryStates.delete(ws)
  }

  const captureQueues = runCaptureStates.get(ws)
  if (!captureQueues) return
  const closedError = new Error('WebSocket connection is closed.')
  for (const queue of captureQueues.values()) {
    let slot = queue.head
    while (slot) {
      const next = slot.next
      const reject = slot.reject
      slot.operation = null
      slot.resolve = null
      slot.reject = null
      slot.cancelled = true
      slot.next = null
      reject?.(closedError)
      slot = next
    }
    queue.head = null
    queue.tail = null
    queue.running = false
  }
  captureQueues.clear()
  runCaptureStates.delete(ws)
}

function terminateConnection(ws: WebSocket): void {
  clearRunDeliveries(ws)
  if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
}

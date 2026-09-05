// +-------------------------------------------------------------------------
//
//   地理智能平台 - Run 展示记录日志与确定性投影
//
//   文件:       runPresentation.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

import {
  conversationItemSchema,
  runEventSchema,
  toolValueRefSchema,
  type ConversationItem,
  type RunEvent,
  type ToolValueRef,
} from './core.js'

export const RUN_PRESENTATION_PROJECTION_SCHEMA_VERSION = 1 as const

export const runPresentationRecordSchema = z.object({
  recordId: z.string().min(1),
  runId: z.string().min(1),
  threadId: z.string().min(1).nullable(),
  sequence: z.number().int().positive(),
  recordType: z.string().min(1),
  payload: z.unknown(),
  createdAt: z.string().min(1),
}).strict()

export const runPresentationProjectionSchema = z.object({
  schemaVersion: z.literal(RUN_PRESENTATION_PROJECTION_SCHEMA_VERSION),
  runId: z.string().min(1),
  sourceSequence: z.number().int().nonnegative(),
  items: z.array(conversationItemSchema),
  events: z.array(runEventSchema),
  values: z.array(toolValueRefSchema),
}).strict()

export type RunPresentationRecord = z.infer<typeof runPresentationRecordSchema>
export type RunPresentationProjection = z.infer<typeof runPresentationProjectionSchema>

/**
 * 从 sequence 0 重放 append-only 展示记录。记录顺序是事实；item 是按稳定
 * itemId 更新的投影，event/value 则是不可变 ID，重复内容只视作幂等重试。
 */
export function replayRunPresentationRecords(
  rawRecords: readonly RunPresentationRecord[],
): RunPresentationProjection | null {
  if (!rawRecords.length) return null
  const records = rawRecords.map(record => runPresentationRecordSchema.parse(record))
  const runId = records[0]!.runId
  const items = new Map<string, ConversationItem>()
  const events = new Map<string, RunEvent>()
  const values = new Map<string, ToolValueRef>()

  for (const [index, record] of records.entries()) {
    const expectedSequence = index + 1
    if (record.runId !== runId) {
      throw new Error(`Run 展示记录 '${record.recordId}' 不属于 run '${runId}'`)
    }
    if (record.sequence !== expectedSequence) {
      throw new Error(
        `Run '${runId}' 展示记录 sequence 不连续：期望 ${expectedSequence}，收到 ${record.sequence}`,
      )
    }
    if (record.recordType === 'item') {
      const item = conversationItemSchema.parse(record.payload)
      if (item.runId !== runId) throw new Error(`ConversationItem '${item.itemId}' 的 runId 不一致`)
      if (item.threadId !== record.threadId) throw new Error(`ConversationItem '${item.itemId}' 的 threadId 不一致`)
      items.set(item.itemId, item)
      continue
    }
    if (record.recordType === 'event') {
      const event = runEventSchema.parse(record.payload)
      if (event.runId !== runId) throw new Error(`RunEvent '${event.eventId}' 的 runId 不一致`)
      if (event.threadId !== record.threadId) throw new Error(`RunEvent '${event.eventId}' 的 threadId 不一致`)
      insertImmutable(events, event.eventId, event, 'RunEvent')
      continue
    }
    if (record.recordType === 'value') {
      const value = toolValueRefSchema.parse(record.payload)
      insertImmutable(values, value.refId, value, 'ToolValueRef')
      continue
    }
    if (!/^input\.(queued|leased|included|requeued|checkpointed)$/u.test(record.recordType)) {
      throw new Error(`Run '${runId}' 包含未知展示记录类型 '${record.recordType}'`)
    }
  }

  return runPresentationProjectionSchema.parse({
    schemaVersion: RUN_PRESENTATION_PROJECTION_SCHEMA_VERSION,
    runId,
    sourceSequence: records.length,
    items: [...items.values()].sort(comparePresentationTime),
    events: [...events.values()],
    values: [...values.values()],
  })
}

function insertImmutable<T>(
  records: Map<string, T>,
  id: string,
  value: T,
  kind: string,
): void {
  const existing = records.get(id)
  if (existing === undefined) {
    records.set(id, value)
    return
  }
  if (JSON.stringify(existing) !== JSON.stringify(value)) {
    throw new Error(`${kind} '${id}' 的稳定 ID 被不同内容重复使用`)
  }
}

function comparePresentationTime(left: ConversationItem, right: ConversationItem): number {
  // Array.sort 是稳定排序；同一 timestamp 保留 canonical record 首次出现顺序。
  return left.timestamp.localeCompare(right.timestamp)
}

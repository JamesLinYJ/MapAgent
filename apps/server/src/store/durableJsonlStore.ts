// +-------------------------------------------------------------------------
//
//   地理智能平台 - Durable JSONL 存储队列
//
//   文件:       durableJsonlStore.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import PQueue from 'p-queue'
import { errorLogPayload, logger } from '../observability/logger.js'
import { jsonlFlushLatencyMs, jsonlQueueDepth } from '../observability/metrics.js'
import { appendJsonLineDurable, recordJsonLineCorruption } from './durableFileIo.js'

interface JsonlQueueState {
  queue: PQueue
  failure: Error | null
}

export interface DurableJsonlStoreOptions {
  appendRecord?: typeof appendJsonLineDurable
}

export class JsonlQueuePoisonedError extends Error {
  constructor(filePath: string, cause: Error) {
    super(`JSONL 文件写入队列已因前序失败而关闭：${path.basename(filePath)}`, { cause })
    this.name = 'JsonlQueuePoisonedError'
  }
}

// DurableJsonlStore 是 JSONL append/read/flush 的唯一拥有者。
// ConversationPayloadStore 负责资源编排；本类负责按文件串行追加、行级恢复和损坏行登记。
export class DurableJsonlStore {
  private readonly writeQueues = new Map<string, JsonlQueueState>()
  private readonly appendRecord: typeof appendJsonLineDurable

  constructor(options: DurableJsonlStoreOptions = {}) {
    this.appendRecord = options.appendRecord ?? appendJsonLineDurable
  }

  async append(filePath: string, record: unknown): Promise<void> {
    const state = this.requireQueue(filePath)
    if (state.failure) throw new JsonlQueuePoisonedError(filePath, state.failure)
    const operation = state.queue.add(async () => {
      if (state.failure) throw new JsonlQueuePoisonedError(filePath, state.failure)
      try {
        await mkdir(path.dirname(filePath), { recursive: true })
        await this.appendRecord(filePath, record)
      } catch (error) {
        const failure = toError(error)
        state.failure = failure
        logger.error({ error: errorLogPayload(failure), filePath }, 'jsonl append failed; queue poisoned')
        throw failure
      }
    })
    this.updateQueueDepth()
    try {
      await operation
    } finally {
      this.updateQueueDepth()
      this.scheduleHealthyQueueCleanup(filePath, state)
    }
  }

  async read<T>(
    filePath: string,
    threadId: string,
    schema: { parse(value: unknown): T },
  ): Promise<T[]> {
    let text: string
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const lines = text.split('\n')
    const records: T[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line === undefined) continue
      if (!line.trim()) continue
      try {
        records.push(schema.parse(JSON.parse(line)))
      } catch (error) {
        const isFinalPartialLine = index === lines.length - 1 && !text.endsWith('\n')
        if (isFinalPartialLine) break
        await recordJsonLineCorruption(filePath, threadId, index + 1, error)
      }
    }
    return records
  }

  async flush(): Promise<void> {
    const started = performance.now()
    while (true) {
      const states = [...this.writeQueues.values()]
      await Promise.all(states.map(state => state.queue.onIdle()))
      if ([...this.writeQueues.values()].every(state => state.queue.size === 0 && state.queue.pending === 0)) break
    }
    jsonlFlushLatencyMs.observe({ scope: 'conversation_store' }, performance.now() - started)
    this.updateQueueDepth()
    const failures = [...this.writeQueues.entries()]
      .filter((entry): entry is [string, JsonlQueueState & { failure: Error }] => entry[1].failure !== null)
      .map(([filePath, state]) => new JsonlQueuePoisonedError(filePath, state.failure))
    if (failures.length) {
      throw new AggregateError(failures, `JSONL 写入队列 flush 失败：${failures.length} 个文件已停止写入`)
    }
  }

  private requireQueue(filePath: string): JsonlQueueState {
    const existing = this.writeQueues.get(filePath)
    if (existing) return existing
    const created: JsonlQueueState = {
      queue: new PQueue({ concurrency: 1 }),
      failure: null,
    }
    this.writeQueues.set(filePath, created)
    return created
  }

  private scheduleHealthyQueueCleanup(filePath: string, state: JsonlQueueState): void {
    if (state.failure) return
    void state.queue.onIdle().then(() => {
      if (this.writeQueues.get(filePath) !== state || state.failure) return
      if (state.queue.size === 0 && state.queue.pending === 0) this.writeQueues.delete(filePath)
      this.updateQueueDepth()
    })
  }

  private updateQueueDepth(): void {
    const depth = [...this.writeQueues.values()]
      .reduce((total, state) => total + state.queue.size + state.queue.pending, 0)
    jsonlQueueDepth.set({ scope: 'conversation_store' }, depth)
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

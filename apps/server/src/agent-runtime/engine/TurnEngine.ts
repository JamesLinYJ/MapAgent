// +-------------------------------------------------------------------------
//
//   地理智能平台 - Turn 身份与单段执行边界
//
//   文件:       TurnEngine.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { makeId } from '../../utils/ids.js'

export type RestoredTurnIdResolver = (threadId: string, runId: string) => Promise<string>

/**
 * TurnEngine 在任何展示投影创建前确定稳定 turnId，并保证同一 Turn 不会并行
 * 驱动两个 SDK Runner segment。它不复制 SDK 内部的模型/工具循环。
 */
export class TurnEngine {
  private readonly activeSegments = new Set<string>()

  constructor(private readonly resolveRestoredTurnId: RestoredTurnIdResolver) {}

  async resolveTurnId(input: {
    runId: string
    threadId: string
    resume: boolean
  }): Promise<string> {
    const turnId = input.resume
      ? await this.resolveRestoredTurnId(input.threadId, input.runId)
      : makeId('turn')
    if (!turnId.trim()) throw new Error(`运行 '${input.runId}' 缺少有效 turnId`)
    return turnId
  }

  async executeSegment<TStream extends TurnSegmentStream>(
    input: TurnSegmentExecution<TStream>,
  ): Promise<TurnSegmentResult<TStream>> {
    const executionKey = `${input.runId}:${input.turnId}`
    if (this.activeSegments.has(executionKey)) {
      throw new Error(`Turn '${input.turnId}' 已有活动 Runner segment`)
    }
    this.activeSegments.add(executionKey)
    try {
      const stream = await input.start()
      await input.onStarted?.(stream)
      let error: unknown = null
      try {
        for await (const event of stream) {
          await input.onEvent(event as TurnSegmentEvent<TStream>)
        }
        await stream.completed
      } catch (segmentError) {
        error = segmentError
      }
      return { stream, error }
    } finally {
      this.activeSegments.delete(executionKey)
    }
  }
}

export interface TurnSegmentStream extends AsyncIterable<unknown> {
  completed: Promise<unknown>
}

type TurnSegmentEvent<TStream extends TurnSegmentStream> =
  TStream extends AsyncIterable<infer TEvent> ? TEvent : never

export interface TurnSegmentExecution<TStream extends TurnSegmentStream> {
  runId: string
  turnId: string
  start(): Promise<TStream>
  onStarted?(stream: TStream): void | Promise<void>
  onEvent(event: TurnSegmentEvent<TStream>): void | Promise<void>
}

export interface TurnSegmentResult<TStream extends TurnSegmentStream> {
  stream: TStream
  error: unknown | null
}

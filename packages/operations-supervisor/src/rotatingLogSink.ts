// +-------------------------------------------------------------------------
//
//   地理智能平台 - 无外部日志依赖的轮转文件流
//
//   文件:       rotatingLogSink.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'

import type { RotatingFileStream } from 'rotating-file-stream'

/**
 * 文件流失败后按指数退避重建。调用方保留自己的有界内存事实源，本类不复制
 * 日志队列，也不读取或继承宿主进程环境。
 */
export class RetryingRotatingFileSink extends Writable {
  private active: RotatingFileStream | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private retryDelayMs = 1_000
  private consecutiveFailures = 0
  private closing = false

  constructor(
    private readonly create: () => RotatingFileStream,
    private readonly onHealthy: (message: string) => void,
    private readonly onFailure: (error: Error, retrying: boolean) => void,
  ) {
    super()
    this.open()
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const stream = this.active
    if (!stream) {
      callback()
      return
    }
    stream.write(chunk, encoding, error => {
      if (error) this.handleFailure(stream, error)
      else if (stream === this.active) this.onHealthy('日志文件可写。')
      callback()
    })
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.closing = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const stream = this.active
    this.active = null
    if (!stream) {
      callback()
      return
    }
    stream.end()
    void finished(stream).then(() => callback(), callback)
  }

  private open(): void {
    if (this.closing) return
    try {
      const stream = this.create()
      this.active = stream
      stream.once('open', () => {
        if (stream !== this.active) return
        this.consecutiveFailures = 0
        this.retryDelayMs = 1_000
        this.onHealthy('日志文件可写。')
      })
      stream.on('warning', error => this.onFailure(error, true))
      stream.on('error', error => this.handleFailure(stream, error))
    } catch (error) {
      this.handleOpenFailure(toError(error))
    }
  }

  private handleFailure(stream: RotatingFileStream, error: Error): void {
    if (stream !== this.active) return
    this.active = null
    stream.destroy()
    this.handleOpenFailure(error)
  }

  private handleOpenFailure(error: Error): void {
    this.consecutiveFailures += 1
    this.onFailure(error, this.consecutiveFailures < 5)
    if (this.closing || this.retryTimer) return
    const delay = this.retryDelayMs
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, delay)
    this.retryTimer.unref()
  }
}

export function rotatedLogFileName(prefix: string, time: number | Date, index: number): string {
  const timestamp = (time instanceof Date ? time : new Date(time))
    .toISOString()
    .replace(/[:.]/gu, '-')
  return `${prefix}.${timestamp}.${index}.jsonl`
}

/** 文件名使用轮转真正发生时的 UTC 时间，相同边界和索引重复求名时保持稳定。 */
export function createActualUtcRotationNameGenerator(
  activeName: string,
  prefix: string,
  extension: '.jsonl' | '.log',
  now: () => Date = () => new Date(),
): (time: number | Date, index?: number) => string {
  const actualTimes = new Map<string, Date>()
  return (time, index = 0) => {
    if (!time) return activeName
    const boundary = time instanceof Date ? time.getTime() : time
    const key = `${boundary}:${index}`
    let actual = actualTimes.get(key)
    if (!actual) {
      actual = now()
      actualTimes.set(key, actual)
      if (actualTimes.size > 128) {
        const oldest = actualTimes.keys().next().value
        if (oldest !== undefined) actualTimes.delete(oldest)
      }
    }
    const timestamp = actual.toISOString().replace(/[:.]/gu, '-')
    return `${prefix}.${timestamp}.${index}${extension}`
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

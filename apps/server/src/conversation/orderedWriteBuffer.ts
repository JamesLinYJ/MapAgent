// +-------------------------------------------------------------------------
//
//   地理智能平台 - 有序写入缓冲区
//
//   文件:       orderedWriteBuffer.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

/**
 * 保持运行时发射顺序，并在异步持久化失败的同一轮微任务中接管 rejection。
 * 首次失败后不再写后续记录，flush 会把原始失败交给 run 生命周期处理。
 */
export class OrderedWriteBuffer {
  private tail: Promise<void> = Promise.resolve()
  private failure: Error | null = null

  enqueue(write: () => void | Promise<void>): void {
    this.tail = this.tail
      .then(async () => {
        if (this.failure) return
        await write()
      })
      .catch(error => {
        this.failure ??= toError(error)
      })
  }

  async flush(): Promise<void> {
    await this.tail
    if (this.failure) throw this.failure
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

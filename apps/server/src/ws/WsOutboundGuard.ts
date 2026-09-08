// +-------------------------------------------------------------------------
//   地理智能平台 - 实时推送发送前授权与有界队列
//   文件: WsOutboundGuard.ts
//   日期: 2026年09月08日
//   AI 协助: OpenAI ChatGPT (GPT-6 Astra Pro)
// --------------------------------------------------------------------------

export interface WsDeliveryScope {
  object: 'run' | 'thread'
  resourceId: string
}

interface PendingDelivery {
  scope: WsDeliveryScope | null
  message: string
  byteLength: number
}

export interface WsOutboundGuardOptions {
  authorize(scopes: readonly WsDeliveryScope[]): Promise<boolean>
  isCurrent(): boolean
  deliver(message: string): void
  onDenied(): void
  maxBytes?: number
  maxMessages?: number
}

/**
 * 授权检查不能用无界 Promise 链替代发送队列。每个批次只检查入队时已经
 * 存在的消息，新来的消息进入下一批；关闭后，迟到的检查结果不能再发送。
 */
export class WsOutboundGuard {
  private queue: Array<PendingDelivery | undefined> = []
  private head = 0
  private bytes = 0
  private draining = false
  private disposed = false
  private readonly options: WsOutboundGuardOptions

  constructor(options: WsOutboundGuardOptions) {
    this.options = options
  }

  get bufferedBytes(): number { return this.bytes }

  enqueue(scope: WsDeliveryScope | null, message: string, byteLength: number): void {
    if (this.disposed) return
    if (
      !this.options.isCurrent()
      || this.bytes + byteLength > (this.options.maxBytes ?? 8 * 1024 * 1024)
      || this.queue.length - this.head >= (this.options.maxMessages ?? 4_096)
    ) {
      this.deny()
      return
    }
    this.queue.push({ scope, message, byteLength })
    this.bytes += byteLength
    if (!this.draining) void this.drain()
  }

  dispose(): void {
    this.disposed = true
    this.queue = []
    this.head = 0
    this.bytes = 0
  }

  private deny(): void {
    if (this.disposed) return
    this.dispose()
    this.options.onDenied()
  }

  private async drain(): Promise<void> {
    this.draining = true
    try {
      while (!this.disposed && this.head < this.queue.length) {
        const end = this.queue.length
        const scopes: WsDeliveryScope[] = []
        for (let index = this.head; index < end; index += 1) {
          const scope = this.queue[index]?.scope
          if (scope) scopes.push(scope)
        }
        const allowed = await this.options.authorize(scopes)
        if (this.disposed) return
        if (!allowed) { this.deny(); return }
        while (!this.disposed && this.head < end) {
          // 会话可以在 await 期间自然过期，不能仅检查批次开始时的时间。
          if (!this.options.isCurrent()) { this.deny(); return }
          const item = this.queue[this.head]
          this.queue[this.head] = undefined
          this.head += 1
          if (!item) continue
          this.bytes -= item.byteLength
          this.options.deliver(item.message)
        }
        if (!this.disposed) {
          this.queue = this.queue.slice(this.head)
          this.head = 0
        }
      }
    } catch {
      // 授权服务失败也必须关闭发送边界，不能以旧角色快照继续推送。
      this.deny()
    } finally {
      this.draining = false
    }
  }
}

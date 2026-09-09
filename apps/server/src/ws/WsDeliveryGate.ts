// +-------------------------------------------------------------------------
//
//   地理智能平台 - WebSocket 出站授权与有界交付
//
//   文件:       WsDeliveryGate.ts
//   日期:       2026年09月08日
//   协助:       OpenAI ChatGPT
// --------------------------------------------------------------------------

export type WsDeliveryScope =
  | { object: 'connection' }
  | { object: 'run' | 'thread'; resourceId: string }

export type WsDeliveryAuthorize = (scopes: readonly WsDeliveryScope[]) => Promise<void>

interface Delivery {
  body: string
  byteLength: number
  scope: WsDeliveryScope
}

/** 每批发送重新授权，不缓存授权结果；异步校验不得重排消息或无界积压正文。 */
export class WsDeliveryGate {
  private pending: Delivery[] = []
  private active: Delivery[] = []
  private draining = false
  private disposed = false
  private bytes = 0
  private slots = 0

  constructor(
    private readonly authorize: WsDeliveryAuthorize,
    private readonly deliver: (message: string) => void,
    private readonly onFailure: (error: unknown) => void,
    private readonly maxSlots = 4_096,
  ) {}

  get queuedBytes(): number { return this.bytes }

  enqueue(body: string, scope: WsDeliveryScope): void {
    if (this.disposed) return
    if (this.slots >= this.maxSlots) {
      this.fail(new Error('WebSocket 待授权消息数量超过上限。'))
      return
    }
    const byteLength = Buffer.byteLength(body, 'utf8')
    this.pending.push({ body, byteLength, scope })
    this.bytes += byteLength
    this.slots += 1
    void this.drain()
  }

  dispose(): void {
    this.disposed = true
    // active 不保存在 await 栈上的局部变量中，断开时可立即释放大正文。
    this.pending = []
    this.active = []
    this.bytes = 0
    this.slots = 0
  }

  private async drain(): Promise<void> {
    if (this.draining || this.disposed) return
    this.draining = true
    try {
      while (!this.disposed && this.pending.length) {
        this.active = this.pending
        this.pending = []
        // scope 跟随消息，而不是读取当前订阅表；取消订阅也不能让旧队列绕过校验。
        await this.authorize(this.active.map(delivery => delivery.scope))
        if (this.disposed) return
        for (const delivery of this.active) {
          this.bytes -= delivery.byteLength
          this.slots -= 1
          this.deliver(delivery.body)
          if (this.disposed) return
        }
        this.active = []
      }
    } catch (error) {
      this.fail(error)
    } finally {
      this.draining = false
    }
  }

  private fail(error: unknown): void {
    if (this.disposed) return
    this.dispose()
    this.onFailure(error)
  }
}

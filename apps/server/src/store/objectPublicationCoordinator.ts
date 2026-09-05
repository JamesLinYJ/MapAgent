// +-------------------------------------------------------------------------
//
//   地理智能平台 - 内容对象发布/垃圾回收线性化边界
//
//   单 API writer 进程内，所有“put 对象 -> 提交数据库引用”与“读取引用全集
//   -> GC”共享这一临界区，避免 GC 删除尚未来得及挂引用的新对象。
// --------------------------------------------------------------------------

export class ObjectPublicationCoordinator {
  private activePublishers = 0
  private collecting = false
  private readonly waitingPublishers: Array<() => void> = []
  private readonly waitingCollectors: Array<() => void> = []

  async publish<T>(work: () => Promise<T>): Promise<T> {
    await this.acquirePublisher()
    try {
      return await work()
    } finally {
      this.releasePublisher()
    }
  }

  async collect<T>(work: () => Promise<T>): Promise<T> {
    await this.acquireCollector()
    try {
      return await work()
    } finally {
      this.releaseCollector()
    }
  }

  private acquirePublisher(): Promise<void> {
    // 一旦 GC 排队，后来的 publisher 不再插队，避免持续 checkpoint 使 GC 饥饿。
    if (!this.collecting && this.waitingCollectors.length === 0) {
      this.activePublishers += 1
      return Promise.resolve()
    }
    return new Promise(resolve => this.waitingPublishers.push(resolve))
  }

  private acquireCollector(): Promise<void> {
    if (!this.collecting && this.activePublishers === 0) {
      this.collecting = true
      return Promise.resolve()
    }
    return new Promise(resolve => this.waitingCollectors.push(resolve))
  }

  private releasePublisher(): void {
    this.activePublishers -= 1
    if (this.activePublishers !== 0 || this.collecting) return
    const collector = this.waitingCollectors.shift()
    if (!collector) return
    this.collecting = true
    collector()
  }

  private releaseCollector(): void {
    this.collecting = false
    const collector = this.waitingCollectors.shift()
    if (collector) {
      this.collecting = true
      collector()
      return
    }
    const publishers = this.waitingPublishers.splice(0)
    this.activePublishers += publishers.length
    for (const publisher of publishers) publisher()
  }
}

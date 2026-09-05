import { describe, expect, it } from 'vitest'

import { ObjectPublicationCoordinator } from './objectPublicationCoordinator.js'

describe('ObjectPublicationCoordinator', () => {
  it('allows independent object publications to run concurrently', async () => {
    const coordinator = new ObjectPublicationCoordinator()
    const first = deferred<void>()
    const second = deferred<void>()
    const entered: string[] = []
    const firstRun = coordinator.publish(async () => {
      entered.push('first')
      await first.promise
    })
    const secondRun = coordinator.publish(async () => {
      entered.push('second')
      await second.promise
    })
    await waitFor(() => entered.length === 2)
    first.resolve()
    second.resolve()
    await Promise.all([firstRun, secondRun])
  })

  it('waits for every active publication before entering GC', async () => {
    const coordinator = new ObjectPublicationCoordinator()
    const release = deferred<void>()
    let collecting = false
    const publication = coordinator.publish(() => release.promise)
    const collection = coordinator.collect(async () => { collecting = true })
    await Promise.resolve()
    expect(collecting).toBe(false)
    release.resolve()
    await Promise.all([publication, collection])
    expect(collecting).toBe(true)
  })

  it('blocks new publications behind an already waiting GC operation', async () => {
    const coordinator = new ObjectPublicationCoordinator()
    const releaseFirst = deferred<void>()
    const releaseCollection = deferred<void>()
    const order: string[] = []
    const first = coordinator.publish(async () => {
      order.push('publish:first')
      await releaseFirst.promise
    })
    const collection = coordinator.collect(async () => {
      order.push('collect')
      await releaseCollection.promise
    })
    const second = coordinator.publish(async () => { order.push('publish:second') })
    releaseFirst.resolve()
    await waitFor(() => order.includes('collect'))
    expect(order).toEqual(['publish:first', 'collect'])
    releaseCollection.resolve()
    await Promise.all([first, collection, second])
    expect(order).toEqual(['publish:first', 'collect', 'publish:second'])
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('等待并发测试状态超时')
}

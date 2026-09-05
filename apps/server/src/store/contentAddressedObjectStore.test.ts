import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ContentAddressedObjectStore } from './contentAddressedObjectStore.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('ContentAddressedObjectStore durable publication', () => {
  it('repairs a partial object left at the final hash path before returning the reference', async () => {
    const root = await temporaryRoot()
    const content = Buffer.from('完整 checkpoint 内容'.repeat(256))
    const hash = createHash('sha256').update(content).digest('hex')
    const directory = path.join(root, hash.slice(0, 2))
    const target = path.join(directory, hash)
    await mkdir(directory, { recursive: true })
    await writeFile(target, content.subarray(0, 17), { mode: 0o600 })

    const reference = await new ContentAddressedObjectStore(root).put(content)

    expect(reference).toMatchObject({ hash, sizeBytes: content.byteLength })
    expect(await readFile(target)).toEqual(content)
  })

  it('publishes concurrent writes of the same hash completely without temporary-file leaks', async () => {
    const root = await temporaryRoot()
    const content = Buffer.from('同一 checkpoint 并发发布'.repeat(1024))
    const store = new ContentAddressedObjectStore(root)

    const references = await Promise.all(Array.from({ length: 24 }, () => store.put(content)))
    const hash = references[0]!.hash
    expect(new Set(references.map(reference => reference.hash))).toEqual(new Set([hash]))
    expect(await store.readByHash(hash)).toEqual(content)
    expect(await readdir(path.join(root, hash.slice(0, 2)))).toEqual([hash])
  })

  it('does not let a same-hash fast path outrun rename durability', async () => {
    const root = await temporaryRoot()
    const content = Buffer.from('rename 后必须等待 fsync'.repeat(512))
    let releaseSync!: () => void
    const syncBarrier = new Promise<void>(resolve => { releaseSync = resolve })
    let atomicPublishReached!: () => void
    const atomicPublish = new Promise<void>(resolve => { atomicPublishReached = resolve })
    const store = new ContentAddressedObjectStore(root, {
      afterAtomicPublishBeforeSync: async () => {
        atomicPublishReached()
        await syncBarrier
      },
    })

    const first = store.put(content)
    await atomicPublish
    let secondResolved = false
    const second = store.put(content).then(reference => {
      secondResolved = true
      return reference
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(secondResolved).toBe(false)

    releaseSync()
    const [firstReference, secondReference] = await Promise.all([first, second])
    expect(secondReference.hash).toBe(firstReference.hash)
    expect(await store.read(secondReference)).toEqual(content)
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-content-addressed-store-'))
  roots.push(root)
  return root
}

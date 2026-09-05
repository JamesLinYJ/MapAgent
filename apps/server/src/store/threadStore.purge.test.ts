// +-------------------------------------------------------------------------
//
//   地理智能平台 - 线程永久清理顺序测试
//
//   文件:       threadStore.purge.test.ts
//   日期:       2026年08月04日
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PersistenceFacadeTestHarness } from '../../test-support/persistenceFacadeHarness.js'
import { ConversationPayloadStore } from './conversationPayloadStore.js'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('ThreadStore purge ordering', () => {
  it('does not touch physical projections when the database purge fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-thread-purge-order-'))
    roots.push(root)
    const harness = new PersistenceFacadeTestHarness()
    const store = harness.create(root)
    await store.initialize()
    const session = await store.createSession()
    const thread = await store.createThread(session.id, '待永久清理')
    await store.deleteThread(thread.id)

    vi.spyOn(harness.conversationPersistence, 'purgeThread')
      .mockRejectedValue(new Error('database purge failed'))
    const filePurge = vi.spyOn(store.fileLifecycle, 'purgeThreadFiles')
    const payloadPurge = vi.spyOn(ConversationPayloadStore.prototype, 'purgeThreadPayload')

    await expect(store.purgeThread(thread.id)).rejects.toThrow('database purge failed')

    expect(filePurge).not.toHaveBeenCalled()
    expect(payloadPurge).not.toHaveBeenCalled()
  })
})

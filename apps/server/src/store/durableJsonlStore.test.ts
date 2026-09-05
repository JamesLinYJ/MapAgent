// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久 JSONL 存储测试
//
//   文件:       durableJsonlStore.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { appendJsonLineDurable } from './durableFileIo.js'
import { DurableJsonlStore, JsonlQueuePoisonedError } from './durableJsonlStore.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('DurableJsonlStore', () => {
  it('serializes records for the same file in declaration order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-jsonl-order-'))
    roots.push(root)
    const filePath = path.join(root, 'events.jsonl')
    const store = new DurableJsonlStore()

    await Promise.all([
      store.append(filePath, { sequence: 1 }),
      store.append(filePath, { sequence: 2 }),
      store.append(filePath, { sequence: 3 }),
    ])
    await store.flush()

    const records = (await readFile(filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(records).toEqual([{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }])
  })

  it('poisons only the failed file queue and never continues after a missing write', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-jsonl-failure-'))
    roots.push(root)
    const failedPath = path.join(root, 'failed.jsonl')
    const healthyPath = path.join(root, 'healthy.jsonl')
    const writer = vi.fn(async (filePath: string, record: unknown) => {
      if (filePath === failedPath) throw new Error('disk unavailable')
      await appendJsonLineDurable(filePath, record)
    })
    const store = new DurableJsonlStore({ appendRecord: writer })

    await expect(store.append(failedPath, { sequence: 1 })).rejects.toThrow('disk unavailable')
    await expect(store.append(failedPath, { sequence: 2 })).rejects.toBeInstanceOf(JsonlQueuePoisonedError)
    await expect(store.append(healthyPath, { sequence: 1 })).resolves.toBeUndefined()
    await expect(store.flush()).rejects.toThrow('1 个文件已停止写入')

    expect(writer).toHaveBeenCalledTimes(2)
    expect(JSON.parse((await readFile(healthyPath, 'utf8')).trim())).toEqual({ sequence: 1 })
  })
})

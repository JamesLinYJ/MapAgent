// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机监督 IPC 集成测试
//
//   文件:       ipcServer.test.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OperationsClient } from './client.js'
import { OperationsIpcServer } from './ipcServer.js'
import { OperationsLogBuffer } from './logBuffer.js'
import { resolveOperationsPaths } from './paths.js'
import { OperationsSupervisor } from './supervisor.js'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('OperationsIpcServer', () => {
  it('rejects a wrong token and returns a flushed shutdown result for an authenticated client', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-ipc-'))
    cleanupPaths.push(projectRoot)
    const paths = await resolveOperationsPaths({ projectRoot, profile: 'development' })
    const logger = pino({ enabled: false })
    const supervisor = new OperationsSupervisor({
      paths,
      profile: 'development',
      environment: {},
      logBuffer: new OperationsLogBuffer(),
      logger,
    })
    const shutdownRequested = vi.fn()
    const server = new OperationsIpcServer({
      endpoint: paths.endpoint,
      token: 'correct-token-value-that-is-at-least-32-characters',
      supervisor,
      logger,
      onShutdownRequested: shutdownRequested,
    })
    await server.listen()
    try {
      await expect(OperationsClient.connect({
        endpoint: paths.endpoint,
        token: 'wrong-token-value-that-is-at-least-32-characters',
        interactive: false,
      })).rejects.toThrow('监督令牌无效')

      const client = await OperationsClient.connect({
        endpoint: paths.endpoint,
        token: 'correct-token-value-that-is-at-least-32-characters',
        interactive: false,
      })
      expect((await client.status()).services.map(service => service.serviceId))
        .toEqual(['infra', 'worker', 'api'])
      const operation = await client.shutdown()
      expect(operation).toMatchObject({ action: 'shutdown', outcome: 'succeeded' })
      await vi.waitFor(() => expect(shutdownRequested).toHaveBeenCalledOnce())
      client.close()
    } finally {
      await server.close()
      await supervisor.close()
    }
  })
})

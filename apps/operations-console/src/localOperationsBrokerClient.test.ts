// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机运维 Broker 客户端测试
//
//   文件:       localOperationsBrokerClient.test.ts
//
//   日期:       2026年08月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import {
  createLocalOperationsBrokerEnvironment,
  LocalOperationsBrokerClient,
} from './localOperationsBrokerClient.js'

describe('LocalOperationsBrokerClient agent authorization', () => {
  let child: FakeChildProcess

  beforeEach(() => {
    child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
  })

  afterEach(() => {
    vi.useRealTimers()
    spawnMock.mockReset()
  })

  it('rejects immediately with bounded sanitized stderr when the broker exits before authorization', async () => {
    const client = LocalOperationsBrokerClient.open('C:\\workspace', 'agent')
    const authorization = client.waitForAgentAuthorization(60_000)
    child.stderr.write(`${'x'.repeat(10_000)}\u001B[31m数据库版本不兼容\u001B[0m`)
    child.emitExit(1, null)

    const error = await authorization.catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('本机运维 Broker 已退出（1）')
    expect((error as Error).message).toContain('数据库版本不兼容')
    expect((error as Error).message).not.toContain('\u001B')
    expect((error as Error).message.length).toBeLessThan(2_300)
  })

  it('retains an immediate startup failure until authorization is awaited', async () => {
    const client = LocalOperationsBrokerClient.open('C:\\workspace', 'agent')
    child.stderr.write('数据库迁移记录缺失')
    child.emitExit(null, 'SIGTERM')

    await expect(client.waitForAgentAuthorization(60_000)).rejects.toThrow(
      '本机运维 Broker 已退出（SIGTERM）：数据库迁移记录缺失',
    )
  })

  it('rejects an authorization waiter when spawning the broker emits an error', async () => {
    const client = LocalOperationsBrokerClient.open('C:\\workspace', 'agent')
    const authorization = client.waitForAgentAuthorization(60_000)

    child.emit('error', new Error('spawn denied'))

    await expect(authorization).rejects.toThrow('spawn denied')
  })

  it('resolves authorization when the broker publishes it', async () => {
    const client = LocalOperationsBrokerClient.open('C:\\workspace', 'agent')
    const authorization = client.waitForAgentAuthorization(60_000)

    child.stdout.write(`${JSON.stringify(agentAuthorization())}\n`)

    await expect(authorization).resolves.toMatchObject({
      type: 'agent.authorization',
      csrfToken: 'csrf_test',
    })
  })

  it('retains the explicit timeout when the broker stays alive without authorizing', async () => {
    vi.useFakeTimers()
    const client = LocalOperationsBrokerClient.open('C:\\workspace', 'agent')
    const authorization = client.waitForAgentAuthorization(50)

    const assertion = expect(authorization).rejects.toThrow('本机 Agent Broker 授权超时。')
    await vi.advanceTimersByTimeAsync(50)
    await assertion
  })

  it('does not read or forward inherited Provider credentials to the broker', () => {
    let reads = 0
    const environment = {
      PATH: 'test-path',
      API_PORT: '8000',
      DATABASE_URL: 'postgresql://local/database',
    } as NodeJS.ProcessEnv
    Object.defineProperty(environment, 'DEEPSEEK_API_KEY', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'must-not-be-read'
      },
    })

    expect(createLocalOperationsBrokerEnvironment(environment)).toEqual({
      PATH: 'test-path',
      API_PORT: '8000',
      DATABASE_URL: 'postgresql://local/database',
    })
    expect(reads).toBe(0)
  })
})

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code
    this.emit('exit', code, signal)
  }
}

function agentAuthorization(): Record<string, unknown> {
  return {
    type: 'agent.authorization',
    appBaseUrl: 'http://127.0.0.1:8000',
    origin: 'geo-agent-platform://app',
    cookie: 'session=test',
    csrfToken: 'csrf_test',
    actor: {
      osUser: 'tester',
      hostname: 'test-host',
      processId: 123,
      keyVersion: 'key-v1',
      transport: 'loopback_websocket',
    },
  }
}

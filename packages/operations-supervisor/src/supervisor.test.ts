// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机进程监督运行时测试
//
//   文件:       supervisor.test.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'

import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OperationsLogBuffer } from './logBuffer.js'
import { resolveOperationsPaths } from './paths.js'
import { OperationsSupervisor } from './supervisor.js'

const cleanupPaths: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(cleanupPaths.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('OperationsSupervisor operations', () => {
  it('deduplicates an in-flight operationId instead of replaying the write', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-supervisor-'))
    cleanupPaths.push(projectRoot)
    const paths = await resolveOperationsPaths({ projectRoot, profile: 'development' })
    const logBuffer = new OperationsLogBuffer()
    const supervisor = new OperationsSupervisor({
      paths,
      profile: 'development',
      environment: {},
      logBuffer,
      logger: pino({ enabled: false }),
    })
    const observed = vi.fn()
    const unsubscribe = supervisor.onOperation(observed)
    const operation = {
      action: 'stop' as const,
      target: 'all' as const,
      operationId: 'same-operation-id',
      actor: { osUser: 'tester', hostname: 'test-host', processId: 42 },
    }

    try {
      const first = supervisor.execute(operation)
      const duplicate = supervisor.execute(operation)
      expect(duplicate).toBe(first)
      await expect(Promise.all([first, duplicate])).resolves.toMatchObject([
        { operationId: operation.operationId, outcome: 'succeeded' },
        { operationId: operation.operationId, outcome: 'succeeded' },
      ])
      expect(observed).toHaveBeenCalledOnce()
      expect(logBuffer.query({
        services: ['infra', 'worker', 'api'],
        levels: ['info'],
        streams: ['supervisor'],
        categories: [],
        events: [],
        retentions: [],
        correlationId: '',
        search: '停止 全部服务',
        includeSupervisor: true,
        afterSequence: null,
        tail: 10,
      })).toHaveLength(1)
      await expect(supervisor.execute(operation)).resolves.toMatchObject({
        operationId: operation.operationId,
        outcome: 'succeeded',
      })
      expect(observed).toHaveBeenCalledOnce()
    } finally {
      unsubscribe()
      await supervisor.close()
    }
  })

  it('ignores a stale health probe after the supervised command closes', async () => {
    const { supervisor } = await createSupervisor()
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'infra'): {
        command: object | null
        stopping: boolean
        state: string
      }
      monitorHealth(record: unknown): Promise<void>
      probe(record: unknown): Promise<{ ok: boolean; message: string }>
      runShutdownHook(record: unknown): Promise<void>
    }
    const record = harness.requireRecord('infra')
    record.command = { pid: 42, process: {} }
    let releaseProbe: ((value: { ok: boolean; message: string }) => void) | undefined
    harness.probe = vi.fn(() => new Promise<{ ok: boolean; message: string }>(resolve => { releaseProbe = resolve }))
    harness.runShutdownHook = vi.fn(async () => undefined)

    try {
      const monitoring = harness.monitorHealth(record)
      await vi.waitFor(() => expect(releaseProbe).toBeTypeOf('function'))
      record.command = null
      record.state = 'restart_wait'
      releaseProbe?.({ ok: false, message: '旧探针失败' })
      await expect(monitoring).resolves.toBeUndefined()
      expect(record.state).toBe('restart_wait')
    } finally {
      await supervisor.close()
    }
  })

  it('marks a native service stopped when its complete process handle is already gone', async () => {
    const { supervisor } = await createSupervisor()
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'infra'): {
        command: object | null
        state: string
        healthMessage: string
      }
      runShutdownHook(record: unknown): Promise<void>
      waitForPortsReleased(record: unknown, timeoutMs: number): Promise<void>
    }
    const record = harness.requireRecord('infra')
    record.command = null
    record.state = 'healthy'
    harness.runShutdownHook = vi.fn(async () => undefined)
    harness.waitForPortsReleased = vi.fn(async () => undefined)
    try {
      await expect(supervisor.execute({
        action: 'shutdown',
        target: 'all',
        operationId: 'shutdown-without-infra-command',
        actor: { osUser: 'tester', hostname: 'test-host', processId: 42 },
      })).resolves.toMatchObject({ outcome: 'succeeded' })
      expect(harness.runShutdownHook).toHaveBeenCalledOnce()
      expect(harness.waitForPortsReleased).toHaveBeenCalledWith(record, 40_000)
      expect(record.state).toBe('stopped')
      expect(record.healthMessage).toBe('已停止')
    } finally {
      await supervisor.close()
    }
  })

  it('serializes slow health probes instead of accumulating overlapping checks', async () => {
    const { supervisor } = await createSupervisor()
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'infra'): {
        command: object | null
        stopping: boolean
        healthProbeInFlight: boolean
      }
      monitorHealth(record: unknown): Promise<void>
      probe(record: unknown): Promise<{ ok: boolean; message: string }>
      runShutdownHook(record: unknown): Promise<void>
    }
    const record = harness.requireRecord('infra')
    record.command = { pid: 42, process: {} }
    const pending: Array<(value: { ok: boolean; message: string }) => void> = []
    harness.probe = vi.fn(() => new Promise<{ ok: boolean; message: string }>(resolve => pending.push(resolve)))
    harness.runShutdownHook = vi.fn(async () => undefined)

    try {
      const first = harness.monitorHealth(record)
      await vi.waitFor(() => expect(pending).toHaveLength(1))
      await expect(harness.monitorHealth(record)).resolves.toBeUndefined()
      expect(harness.probe).toHaveBeenCalledOnce()
      expect(record.healthProbeInFlight).toBe(true)
      pending[0]?.({ ok: true, message: '健康' })
      await first
      expect(record.healthProbeInFlight).toBe(false)

      const next = harness.monitorHealth(record)
      await vi.waitFor(() => expect(pending).toHaveLength(2))
      pending[1]?.({ ok: true, message: '健康' })
      await next
      expect(harness.probe).toHaveBeenCalledTimes(2)
    } finally {
      record.command = null
      await supervisor.close()
    }
  })

  it('keeps successful steady-state probes silent and records only failure transitions', async () => {
    const { supervisor, logBuffer } = await createSupervisor()
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'worker'): {
        command: object | null
        stopping: boolean
        state: string
        healthMessage: string
        healthFailures: number
      }
      monitorHealth(record: unknown): Promise<void>
      probe(record: unknown, purpose: 'readiness' | 'liveness'): Promise<{ ok: boolean; message: string }>
    }
    const record = harness.requireRecord('worker')
    record.command = { pid: 42, process: {} }
    record.stopping = false
    record.state = 'healthy'
    record.healthMessage = '存活检查通过（HTTP 200）'
    record.healthFailures = 0
    let probeResult = { ok: true, message: '存活检查通过（HTTP 200）' }
    harness.probe = vi.fn(async () => probeResult)

    try {
      for (let index = 0; index < 120; index += 1) await harness.monitorHealth(record)
      expect(logBuffer.tail(['worker'], 20)).toEqual([])

      probeResult = { ok: false, message: '存活检查返回 HTTP 503' }
      await harness.monitorHealth(record)
      await harness.monitorHealth(record)
      await harness.monitorHealth(record)
      probeResult = { ok: true, message: '存活检查通过（HTTP 200）' }
      await harness.monitorHealth(record)

      expect(logBuffer.tail(['worker'], 20).map(entry => entry.event)).toEqual([
        'health.probe.failed',
        'health.service.degraded',
        'health.service.recovered',
      ])
      expect(harness.probe).toHaveBeenLastCalledWith(record, 'liveness')
    } finally {
      record.command = null
      await supervisor.close()
    }
  })

  it('persists operational child events while keeping diagnostics in memory only', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-supervisor-log-route-'))
    cleanupPaths.push(projectRoot)
    const paths = await resolveOperationsPaths({ projectRoot, profile: 'development' })
    const logBuffer = new OperationsLogBuffer()
    const persisted: string[] = []
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        persisted.push(chunk.toString())
        callback()
      },
    })
    const supervisor = new OperationsSupervisor({
      paths,
      profile: 'development',
      environment: {},
      logBuffer,
      logger: pino({ level: 'debug' }, destination),
    })
    const harness = supervisor as unknown as {
      appendLines(
        serviceId: 'api',
        stream: 'stdout',
        lines: readonly string[],
        processId: number,
      ): void
    }

    try {
      harness.appendLines('api', 'stdout', [
        JSON.stringify({
          level: 20,
          event: 'agent.sdk.span.completed',
          category: 'agent',
          retention: 'diagnostic',
          message: '内存诊断',
        }),
        JSON.stringify({
          level: 30,
          event: 'lifecycle.api.ready',
          category: 'lifecycle',
          retention: 'operational',
          message: '关键事件',
        }),
      ], 42)

      expect(logBuffer.tail(['api'], 10).map(entry => entry.message)).toEqual(['内存诊断', '关键事件'])
      expect(persisted.join('')).toContain('关键事件')
      expect(persisted.join('')).not.toContain('内存诊断')
    } finally {
      await supervisor.close()
      destination.destroy()
    }
  })

  it('expires the fixed thirty-minute diagnostic mode and restores the normal memory budget', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'))
    const { supervisor } = await createSupervisor()
    try {
      const enabled = supervisor.startDiagnostics()
      expect(enabled).toMatchObject({ enabled: true, maxBytes: 32 * 1024 * 1024 })
      expect(enabled.expiresAt).toBe('2026-08-03T00:30:00.000Z')

      await vi.advanceTimersByTimeAsync(30 * 60_000)

      expect(supervisor.snapshot().observability.diagnostics).toMatchObject({
        enabled: false,
        expiresAt: null,
        maxBytes: 8 * 1024 * 1024,
      })
    } finally {
      await supervisor.close()
    }
  })

  it('rechecks a retryable port conflict instead of rejecting the stale state', async () => {
    const { supervisor } = await createSupervisor()
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'infra'): {
        state: string
        healthMessage: string
        conflictKind: 'port' | 'unverified_lease' | null
      }
      assertPortsAvailable(record: unknown): Promise<void>
      startSingle(serviceId: 'infra', automatic: boolean): Promise<void>
    }
    const record = harness.requireRecord('infra')
    record.state = 'conflict'
    record.conflictKind = 'port'
    record.healthMessage = 'POSTGIS_PORT 端口被占用'
    harness.assertPortsAvailable = vi.fn(async () => {
      throw new Error('端口已被重新检查')
    })

    try {
      await expect(harness.startSingle('infra', false)).rejects.toThrow('端口已被重新检查')
      expect(harness.assertPortsAvailable).toHaveBeenCalledOnce()
    } finally {
      await supervisor.close()
    }
  })

  it('clears a port conflict after the external listener releases the port', async () => {
    const listener = net.createServer()
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
    })
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('测试监听器没有 TCP 端口。')
    const { supervisor } = await createSupervisor({ POSTGIS_PORT: String(address.port) })
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'infra'): {
        state: string
        healthMessage: string
        conflictKind: 'port' | 'unverified_lease' | null
      }
      assertPortsAvailable(record: unknown): Promise<void>
    }
    const record = harness.requireRecord('infra')

    try {
      await expect(harness.assertPortsAvailable(record)).rejects.toThrow(`端口 ${address.port}`)
      expect(record).toMatchObject({ state: 'conflict', conflictKind: 'port' })

      await new Promise<void>((resolve, reject) => {
        listener.close(error => error ? reject(error) : resolve())
      })
      await expect(harness.assertPortsAvailable(record)).resolves.toBeUndefined()
      expect(record).toMatchObject({
        state: 'stopped',
        conflictKind: null,
        healthMessage: '端口占用已解除，可以重新启动。',
      })
    } finally {
      if (listener.listening) {
        await new Promise<void>(resolve => listener.close(() => resolve()))
      }
      await supervisor.close()
    }
  })

  it('refuses to report a stopped service while its fixed port remains occupied', async () => {
    const listener = net.createServer()
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject)
      listener.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
    })
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('测试监听器没有 TCP 端口。')
    const { supervisor } = await createSupervisor({ API_PORT: String(address.port) })
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'api'): {
        state: string
        healthMessage: string
        conflictKind: 'port' | 'unverified_lease' | null
      }
      waitForPortsReleased(record: unknown, timeoutMs: number): Promise<void>
    }
    const record = harness.requireRecord('api')

    try {
      await expect(harness.waitForPortsReleased(record, 50)).rejects.toThrow(
        `API_PORT=${address.port}`,
      )
      expect(record).toMatchObject({
        state: 'conflict',
        conflictKind: 'port',
      })
    } finally {
      await new Promise<void>(resolve => listener.close(() => resolve()))
      await supervisor.close()
    }
  })

  it('keeps an unverified lease conflict non-retryable', async () => {
    const { supervisor } = await createSupervisor()
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'infra'): {
        state: string
        healthMessage: string
        conflictKind: 'port' | 'unverified_lease' | null
      }
      assertPortsAvailable(record: unknown): Promise<void>
      startSingle(serviceId: 'infra', automatic: boolean): Promise<void>
    }
    const record = harness.requireRecord('infra')
    record.state = 'conflict'
    record.conflictKind = 'unverified_lease'
    record.healthMessage = '旧租约无法验证'
    harness.assertPortsAvailable = vi.fn(async () => undefined)

    try {
      await expect(harness.startSingle('infra', false)).rejects.toThrow('存在未解决的进程冲突')
      expect(harness.assertPortsAvailable).not.toHaveBeenCalled()
    } finally {
      await supervisor.close()
    }
  })

  it('shares one in-flight start attempt between manual start and automatic restart', async () => {
    const { supervisor } = await createSupervisor()
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'infra'): {
        startPromise: Promise<void> | null
      }
      startSingle(serviceId: 'infra', automatic: boolean): Promise<void>
      startSingleAttempt(record: unknown, automatic: boolean): Promise<void>
    }
    let releaseStart: (() => void) | undefined
    harness.startSingleAttempt = vi.fn(() => new Promise<void>(resolve => { releaseStart = resolve }))

    try {
      const manualStart = harness.startSingle('infra', false)
      const automaticRestart = harness.startSingle('infra', true)

      expect(automaticRestart).toBe(manualStart)
      expect(harness.startSingleAttempt).toHaveBeenCalledOnce()
      releaseStart?.()
      await expect(Promise.all([manualStart, automaticRestart])).resolves.toEqual([undefined, undefined])
      await vi.waitFor(() => expect(harness.requireRecord('infra').startPromise).toBeNull())
    } finally {
      releaseStart?.()
      await supervisor.close()
    }
  })

  it('does not let an old close handler overwrite a newer command generation', async () => {
    const { supervisor } = await createSupervisor()
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'infra'): {
        command: object | null
        commandGeneration: number
        desiredRunning: boolean
        stopping: boolean
        state: string
        healthMessage: string
        lastExitCode: string | number | null
      }
      handleClose(
        record: unknown,
        command: object,
        generation: number,
        event: { exitCode: number },
      ): Promise<void>
      writeLeases(): Promise<void>
      scheduleRestart(record: unknown, generation: number): void
    }
    const record = harness.requireRecord('infra')
    const oldCommand = { pid: 101 }
    const newCommand = { pid: 202 }
    record.command = oldCommand
    record.commandGeneration = 7
    record.desiredRunning = true
    record.stopping = false
    record.state = 'healthy'
    record.healthMessage = '旧代健康'
    let releaseLeaseWrite: (() => void) | undefined
    harness.writeLeases = vi.fn(() => new Promise<void>(resolve => { releaseLeaseWrite = resolve }))
    harness.scheduleRestart = vi.fn()

    try {
      const closing = harness.handleClose(record, oldCommand, 7, { exitCode: 1 })
      await vi.waitFor(() => expect(releaseLeaseWrite).toBeTypeOf('function'))
      expect(record.command).toBeNull()

      record.command = newCommand
      record.commandGeneration = 8
      record.state = 'starting'
      record.healthMessage = '新代正在启动'
      record.lastExitCode = null
      releaseLeaseWrite?.()
      await closing

      expect(record.command).toBe(newCommand)
      expect(record.state).toBe('starting')
      expect(record.healthMessage).toBe('新代正在启动')
      expect(record.lastExitCode).toBeNull()
      expect(harness.scheduleRestart).not.toHaveBeenCalled()
    } finally {
      releaseLeaseWrite?.()
      record.command = null
      record.desiredRunning = false
      await supervisor.close()
    }
  })

  it('does not let an old startup probe mark a newer command healthy', async () => {
    const { supervisor } = await createSupervisor()
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'infra'): {
        command: object | null
        commandGeneration: number
        state: string
        healthMessage: string
      }
      waitForHealthy(
        record: unknown,
        command: object,
        generation: number,
        timeoutMs: number,
      ): Promise<void>
      probe(record: unknown): Promise<{ ok: boolean; message: string }>
    }
    const record = harness.requireRecord('infra')
    const oldCommand = { pid: 101 }
    const newCommand = { pid: 202 }
    record.command = oldCommand
    record.commandGeneration = 3
    record.state = 'starting'
    let releaseProbe: ((result: { ok: boolean; message: string }) => void) | undefined
    harness.probe = vi.fn(() => new Promise<{ ok: boolean; message: string }>(
      resolve => { releaseProbe = resolve },
    ))

    try {
      const checking = harness.waitForHealthy(record, oldCommand, 3, 5_000)
      await vi.waitFor(() => expect(releaseProbe).toBeTypeOf('function'))
      record.command = newCommand
      record.commandGeneration = 4
      record.state = 'starting'
      record.healthMessage = '新代正在启动'
      releaseProbe?.({ ok: true, message: '旧探针健康' })

      await expect(checking).rejects.toThrow('启动已被新的进程代次取代')
      expect(record.command).toBe(newCommand)
      expect(record.state).toBe('starting')
      expect(record.healthMessage).toBe('新代正在启动')
    } finally {
      releaseProbe?.({ ok: false, message: '测试结束' })
      record.command = null
      await supervisor.close()
    }
  })

  it('reports the redacted startup stderr instead of a later restart generation', async () => {
    const { supervisor } = await createSupervisor()
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'infra'): {
        command: object | null
        commandGeneration: number
        startupFailures: Map<number, string>
      }
      assertCurrentCommand(record: unknown, command: object, generation: number): void
    }
    const record = harness.requireRecord('infra')
    const failedCommand = { pid: 101 }
    record.command = { pid: 202 }
    record.commandGeneration = 4
    record.startupFailures.set(
      3,
      '基础设施 启动进程在就绪前退出（退出码 1）：PostgreSQL 运行时组件缺失。',
    )

    try {
      expect(() => harness.assertCurrentCommand(record, failedCommand, 3))
        .toThrow('PostgreSQL 运行时组件缺失')
    } finally {
      record.command = null
      await supervisor.close()
    }
  })

  it('ignores a restart timer that belongs to an older command generation', async () => {
    vi.useFakeTimers()
    const { supervisor } = await createSupervisor()
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'infra'): {
        command: object | null
        commandGeneration: number
        desiredRunning: boolean
        stopping: boolean
        restartTimer: NodeJS.Timeout | null
        failureTimes: number[]
      }
      scheduleRestart(record: unknown, generation: number): void
      startSingle(serviceId: 'infra', automatic: boolean): Promise<void>
    }
    const record = harness.requireRecord('infra')
    record.command = null
    record.commandGeneration = 11
    record.desiredRunning = true
    record.stopping = false
    record.failureTimes = []
    harness.startSingle = vi.fn(async () => undefined)

    try {
      harness.scheduleRestart(record, 11)
      record.commandGeneration = 12
      record.command = { pid: 303 }
      await vi.advanceTimersByTimeAsync(2_000)

      expect(harness.startSingle).not.toHaveBeenCalled()
      expect(record.restartTimer).toBeNull()
    } finally {
      record.command = null
      record.desiredRunning = false
      if (record.restartTimer) clearTimeout(record.restartTimer)
      record.restartTimer = null
      await supervisor.close()
    }
  })

  it('preserves a port conflict discovered by an automatic restart', async () => {
    vi.useFakeTimers()
    const { supervisor } = await createSupervisor()
    const harness = supervisor as unknown as {
      requireRecord(serviceId: 'infra'): {
        command: object | null
        commandGeneration: number
        desiredRunning: boolean
        stopping: boolean
        restartTimer: NodeJS.Timeout | null
        failureTimes: number[]
        state: string
        healthMessage: string
        conflictKind: 'port' | 'unverified_lease' | null
      }
      scheduleRestart(record: unknown, generation: number): void
      startSingle(serviceId: 'infra', automatic: boolean): Promise<void>
    }
    const record = harness.requireRecord('infra')
    record.command = null
    record.commandGeneration = 5
    record.desiredRunning = true
    record.stopping = false
    record.failureTimes = []
    harness.startSingle = vi.fn(async () => {
      record.state = 'conflict'
      record.conflictKind = 'port'
      record.healthMessage = 'POSTGIS_PORT 端口仍被占用'
      throw new Error(record.healthMessage)
    })

    try {
      harness.scheduleRestart(record, 5)
      await vi.advanceTimersByTimeAsync(2_000)

      expect(harness.startSingle).toHaveBeenCalledWith('infra', true)
      expect(record).toMatchObject({
        state: 'conflict',
        conflictKind: 'port',
        healthMessage: 'POSTGIS_PORT 端口仍被占用',
      })
    } finally {
      record.desiredRunning = false
      if (record.restartTimer) clearTimeout(record.restartTimer)
      record.restartTimer = null
      await supervisor.close()
    }
  })
})

async function createSupervisor(environment: NodeJS.ProcessEnv = {}): Promise<{
  supervisor: OperationsSupervisor
  logBuffer: OperationsLogBuffer
}> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-supervisor-'))
  cleanupPaths.push(projectRoot)
  const paths = await resolveOperationsPaths({ projectRoot, profile: 'development' })
  const logBuffer = new OperationsLogBuffer()
  return {
    logBuffer,
    supervisor: new OperationsSupervisor({
      paths,
      profile: 'development',
      environment: {
        POSTGIS_PORT: '65431',
        WORKER_PORT: '65432',
        API_PORT: '65433',
        ...environment,
      },
      logBuffer,
      logger: pino({ enabled: false }),
    }),
  }
}

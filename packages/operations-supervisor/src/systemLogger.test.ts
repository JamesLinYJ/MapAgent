// +-------------------------------------------------------------------------
//
//   地理智能平台 - Supervisor 轮转日志测试
//
//   文件:       systemLogger.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { finished } from 'node:stream/promises'

import type { RotatingFileStream } from 'rotating-file-stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveOperationsPaths } from './paths.js'
import {
  createActualUtcRotationNameGenerator,
  createSupervisorLogger,
  RetryingRotatingFileSink,
  rotatedLogFileName,
} from './systemLogger.js'

const cleanupPaths: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(cleanupPaths.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('createSupervisorLogger', () => {
  it('writes structured JSONL and redacts secret-bearing fields', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-system-log-'))
    cleanupPaths.push(projectRoot)
    const paths = await resolveOperationsPaths({ projectRoot, profile: 'development' })
    const output = createSupervisorLogger(paths, 'debug', {
      includeStdout: false,
    })

    output.logger.debug({ prompt: '调试提示词不得持久化' }, '仅内存诊断')

    output.logger.info({
      serviceId: 'api',
      password: 'do-not-store-this',
      nested: { token: 'also-secret' },
      requestBody: { messages: ['用户正文'] },
      localPath: 'C:\\private\\workspace\\runtime.json',
      apiKey: 'direct-secret-value',
      connection: 'postgresql://geo_agent:db-password@127.0.0.1/runtime',
    }, 'API 监督事件')
    await output.close()

    const lines = (await readFile(paths.systemLogFile, 'utf8'))
      .split(/\r?\n/u)
      .filter(Boolean)
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    expect(entry).toMatchObject({
      component: 'supervisor',
      serviceId: 'api',
      password: '[REDACTED]',
      msg: 'API 监督事件',
    })
    expect(entry).not.toHaveProperty('nested.token', 'also-secret')
    expect(JSON.stringify(entry)).not.toContain('do-not-store-this')
    expect(JSON.stringify(entry)).not.toContain('also-secret')
    expect(JSON.stringify(entry)).not.toContain('用户正文')
    expect(JSON.stringify(entry)).not.toContain('调试提示词')
    expect(JSON.stringify(entry)).not.toContain('direct-secret-value')
    expect(JSON.stringify(entry)).not.toContain('db-password')
    expect(JSON.stringify(entry)).not.toContain('C:\\private')
  })

  it('rotates a previous UTC day before accepting the first new record', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-system-log-'))
    cleanupPaths.push(projectRoot)
    const paths = await resolveOperationsPaths({ projectRoot, profile: 'development' })
    const previousRecord = '{"msg":"前一 UTC 日"}\n'
    const currentTime = new Date()
    currentTime.setUTCHours(0, 1, 0, 0)
    const previousTime = new Date(currentTime)
    previousTime.setUTCDate(previousTime.getUTCDate() - 1)
    previousTime.setUTCHours(23, 59, 0, 0)
    await writeFile(paths.systemLogFile, previousRecord, 'utf8')
    await utimes(paths.systemLogFile, previousTime, previousTime)

    const output = createSupervisorLogger(paths, 'info', {
      includeStdout: false,
      now: () => currentTime,
    })
    output.logger.info({ serviceId: 'api' }, '当前 UTC 日')
    await output.close()

    const active = await readFile(paths.systemLogFile, 'utf8')
    expect(active).toContain('当前 UTC 日')
    expect(active).not.toContain('前一 UTC 日')
    const rotated = (await readdir(paths.operationsRoot))
      .filter(file => file.startsWith(`supervisor-${paths.workspaceId}.`))
      .filter(file => file.endsWith('.jsonl'))
      .filter(file => file !== path.basename(paths.systemLogFile))
    expect(rotated).toHaveLength(1)
    expect(await readFile(path.join(paths.operationsRoot, rotated[0] ?? ''), 'utf8'))
      .toBe(previousRecord)
  })

  it('serializes the UTC day change between two records in the same process', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-system-log-'))
    cleanupPaths.push(projectRoot)
    const paths = await resolveOperationsPaths({ projectRoot, profile: 'development' })
    let currentTime = new Date('2026-08-06T23:59:59.999Z')
    const output = createSupervisorLogger(paths, 'info', {
      includeStdout: false,
      now: () => currentTime,
    })

    output.logger.info({ serviceId: 'api' }, 'UTC 日界前')
    currentTime = new Date('2026-08-07T00:00:00.001Z')
    output.logger.info({ serviceId: 'api' }, 'UTC 日界后')
    await output.close()

    const active = await readFile(paths.systemLogFile, 'utf8')
    expect(active).toContain('UTC 日界后')
    expect(active).not.toContain('UTC 日界前')
    const rotated = (await readdir(paths.operationsRoot))
      .filter(file => file.startsWith(`supervisor-${paths.workspaceId}.`))
      .filter(file => file.endsWith('.jsonl'))
      .filter(file => file !== path.basename(paths.systemLogFile))
    expect(rotated).toHaveLength(1)
    const previous = await readFile(path.join(paths.operationsRoot, rotated[0] ?? ''), 'utf8')
    expect(previous).toContain('UTC 日界前')
    expect(previous).not.toContain('UTC 日界后')
  })

  it('rebuilds a failed file stream with exponential backoff without buffering duplicate writes', async () => {
    vi.useFakeTimers()
    const failures: Array<{ message: string; retrying: boolean }> = []
    const healthy = vi.fn()
    const persisted: string[] = []
    let attempts = 0
    let recovered: PassThrough | null = null
    const sink = new RetryingRotatingFileSink(
      () => {
        attempts += 1
        if (attempts === 1) throw new Error('磁盘暂时不可写')
        recovered = new PassThrough()
        recovered.on('data', chunk => persisted.push(chunk.toString()))
        queueMicrotask(() => recovered?.emit('open', 'test.jsonl'))
        return recovered as unknown as RotatingFileStream
      },
      healthy,
      (error, retrying) => failures.push({ message: error.message, retrying }),
    )

    sink.write('故障期间只留在上游内存\n')
    expect(attempts).toBe(1)
    expect(failures).toEqual([{ message: '磁盘暂时不可写', retrying: true }])

    await vi.advanceTimersByTimeAsync(1_000)
    sink.write('恢复后持久化\n')
    await vi.runAllTicks()

    expect(attempts).toBe(2)
    expect(healthy).toHaveBeenCalled()
    expect(persisted.join('')).toBe('恢复后持久化\n')
    sink.end()
    await finished(sink)
  })

  it('derives rotated names from the actual UTC rotation time after a date change', () => {
    expect(rotatedLogFileName(
      'supervisor-workspace',
      new Date('2026-08-04T01:02:03.456Z'),
      2,
    )).toBe('supervisor-workspace.2026-08-04T01-02-03-456Z.2.jsonl')
  })

  it('uses wake-up time rather than a stale scheduled boundary and keeps repeated names stable', () => {
    const generator = createActualUtcRotationNameGenerator(
      'supervisor-workspace.jsonl',
      'supervisor-workspace',
      '.jsonl',
      () => new Date('2026-08-04T01:02:03.456Z'),
    )
    const boundary = new Date('2026-08-04T00:00:00.000Z')

    expect(generator(boundary, 0)).toBe('supervisor-workspace.2026-08-04T01-02-03-456Z.0.jsonl')
    expect(generator(boundary, 0)).toBe('supervisor-workspace.2026-08-04T01-02-03-456Z.0.jsonl')
  })
})

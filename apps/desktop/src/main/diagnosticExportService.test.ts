// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机诊断包导出服务测试
//
//   文件:       diagnosticExportService.test.ts
//
//   日期:       2026年08月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { OperationsSnapshot } from '@geo-agent-platform/shared-types/operations'
import { afterEach, describe, expect, it } from 'vitest'

import { writeDiagnosticBundle } from './diagnosticExportService.js'
import type { DesktopDiagnosticBundle } from './supervisorGateway.js'

const cleanupDirectories: string[] = []

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('writeDiagnosticBundle', () => {
  it('streams a bounded JSONL package and reapplies path and secret redaction', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-diagnostics-'))
    cleanupDirectories.push(directory)
    const outputPath = path.join(directory, 'diagnostics.jsonl')
    const bundle: DesktopDiagnosticBundle = {
      formatVersion: 1,
      capturedAt: '2026-08-03T00:00:00.000Z',
      snapshot: snapshotFixture(),
      entries: [{
        sequence: 1,
        serviceId: 'api',
        component: 'server',
        processId: 42,
        stream: 'stdout',
        level: 'error',
        event: 'model.request.failed',
        category: 'model',
        retention: 'operational',
        correlation: { requestId: 'request_1' },
        message: 'Bearer hidden-token-value C:\\private\\server.ts',
        errorStack: 'at handler (C:\\private\\server.ts:12:3)',
        attributes: { apiKey: 'environment-secret-value' },
        createdAt: '2026-08-03T00:00:01.000Z',
      }],
    }

    await writeDiagnosticBundle(outputPath, bundle)

    const content = await readFile(outputPath, 'utf8')
    const records = content.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ recordType: 'manifest', entryCount: 1 })
    expect(records[1]).toMatchObject({ recordType: 'log' })
    expect(content).not.toContain('hidden-token-value')
    expect(content).not.toContain('environment-secret-value')
    expect(content).not.toContain('C:\\private')
    expect(content).toContain('[REDACTED]')
    expect(content).toContain('[LOCAL_PATH]')
  })
})

function snapshotFixture(): OperationsSnapshot {
  const metric = { value: null, unavailableReason: '测试未采样。' }
  return {
    sequence: 1,
    host: {
      hostname: 'test-host',
      platform: 'win32',
      release: 'test',
      profile: 'development',
      supervisorPid: 42,
      supervisorStartedAt: '2026-08-03T00:00:00.000Z',
      cpuPercent: metric,
      memoryUsedBytes: { value: null, unavailableReason: '测试未采样。' },
      memoryTotalBytes: { value: null, unavailableReason: '测试未采样。' },
      runtimeDiskUsedBytes: { value: null, unavailableReason: '测试未采样。' },
      runtimeDiskTotalBytes: { value: null, unavailableReason: '测试未采样。' },
      sampledAt: '2026-08-03T00:00:00.000Z',
    },
    services: (['infra', 'worker', 'api'] as const).map(serviceId => ({
      serviceId,
      displayName: serviceId,
      description: '测试服务',
      state: 'healthy' as const,
      healthMessage: '正常',
      pid: 42,
      cpuPercent: metric,
      memoryBytes: { value: null, unavailableReason: '测试未采样。' },
      startedAt: '2026-08-03T00:00:00.000Z',
      uptimeSeconds: 1,
      restartCount: 0,
      lastExitCode: null,
      blockedBy: [],
    })),
    observability: {
      diagnostics: {
        enabled: true,
        expiresAt: '2026-08-03T00:30:00.000Z',
        retainedEntries: 1,
        retainedBytes: 100,
        maxBytes: 32 * 1024 * 1024,
        oldestCreatedAt: '2026-08-03T00:00:01.000Z',
      },
      persistence: {
        state: 'healthy',
        message: '日志持久化正常。',
        lastSuccessAt: '2026-08-03T00:00:00.000Z',
        lastErrorAt: null,
      },
    },
  }
}

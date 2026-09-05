// +-------------------------------------------------------------------------
//
//   地理智能平台 - 远程运行状态网关测试
//
//   文件:       remoteOperationsGateway.test.ts
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import { operationsSnapshotSchema } from '@geo-agent-platform/shared-types/operations'

import { RemoteDesktopOperationsGateway } from './remoteOperationsGateway.js'
import type { DesktopProductSetupService } from './productSetup.js'

describe('RemoteDesktopOperationsGateway', () => {
  it('projects a compatible remote readiness check without exposing local process controls', async () => {
    const setup = {
      test: vi.fn(async () => ({
        ok: true,
        apiBaseUrl: 'https://geo.example.com',
        latencyMs: 18,
        releaseId: 'release-1',
        databaseSchemaVersion: 12,
        message: '连接成功',
      })),
    } as unknown as DesktopProductSetupService
    const gateway = new RemoteDesktopOperationsGateway('https://geo.example.com', setup)

    const status = await gateway.handle({
      version: 1,
      requestId: '019fa8d2-d331-7c48-a667-68383b815be9',
      command: 'status',
      payload: {},
    })
    expect(status.ok).toBe(true)
    const snapshot = operationsSnapshotSchema.parse(status.data)
    expect(snapshot.services).toHaveLength(3)
    expect(snapshot.services.every(service => service.state === 'healthy')).toBe(true)
    expect(snapshot.host).toMatchObject({ hostname: 'geo.example.com', release: 'release-1' })

    const operation = await gateway.handle({
      version: 1,
      requestId: '019fa8d2-d331-7c48-a667-68383b815bea',
      command: 'restart',
      payload: {
        target: 'all',
        operationId: '019fa8d2-d331-7c48-a667-68383b815beb',
      },
    })
    expect(operation).toMatchObject({
      ok: true,
      data: { outcome: 'failed', message: expect.stringContaining('服务端主机') },
    })
  })

  it('reports an unavailable remote endpoint through the normal supervisor error envelope', async () => {
    const setup = {
      test: vi.fn(async () => ({
        ok: false,
        apiBaseUrl: 'https://geo.example.com',
        latencyMs: 8_000,
        releaseId: null,
        databaseSchemaVersion: null,
        message: '服务健康检查返回 HTTP 503。',
      })),
    } as unknown as DesktopProductSetupService
    const gateway = new RemoteDesktopOperationsGateway('https://geo.example.com', setup)

    await expect(gateway.handle({
      version: 1,
      requestId: '019fa8d2-d331-7c48-a667-68383b815bec',
      command: 'status',
      payload: {},
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'remote_service_unavailable', message: expect.stringContaining('503') },
    })
  })
})

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面后台可用性监视器测试
//
//   文件:       desktopBackendMonitor.test.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OperationsServiceSnapshot, OperationsSnapshot } from '@geo-agent-platform/shared-types/operations'

import {
  BackendStatusNotice,
  DesktopBackendMonitor,
} from '../app/DesktopBackendMonitor'
import {
  DesktopEventRouterContext,
  type DesktopEventConsumer,
} from '../app/events/DesktopEventRouterContext'
import {
  assertRuntimeCapabilities,
  ensureRuntimeCompatibility,
} from '../app/runtimeCompatibility'
import { useBackendAvailabilityStore } from '../app/stores/backendAvailabilityStore'

describe('DesktopBackendMonitor', () => {
  beforeEach(() => {
    useBackendAvailabilityStore.setState({
      availability: 'checking',
      snapshot: null,
      errorMessage: null,
      onlineRevision: 0,
    })
  })

  it('mounts the workbench immediately while backend services are still checking', () => {
    const html = renderToStaticMarkup(
      <DesktopEventRouterContext.Provider value={noDesktopEvents}>
        <DesktopBackendMonitor>
          <main data-testid="desktop-workbench">独立桌面工作台</main>
        </DesktopBackendMonitor>
      </DesktopEventRouterContext.Provider>,
    )

    expect(html).toContain('独立桌面工作台')
    expect(html).toContain('正在检查本机服务')
    expect(html).toContain('工作台已启动')
  })

  it('keeps the renderer content visible while showing a recoverable offline state', () => {
    const html = renderToStaticMarkup(
      <>
        <main>地图与本地布局</main>
        <BackendStatusNotice
          availability="offline"
          snapshot={null}
          errorMessage="平台 API 未运行。"
          onRetry={() => undefined}
          onOpenLogs={() => undefined}
        />
      </>,
    )

    expect(html).toContain('地图与本地布局')
    expect(html).toContain('当前处于离线工作台')
    expect(html).toContain('平台 API 未运行')
    expect(html).toContain('系统日志')
    expect(html).toContain('重新连接')
  })

  it('rejects an API/Desktop protocol mismatch before marking services online', () => {
    expect(() => assertRuntimeCapabilities({
      apiProtocolVersion: 99,
      minDesktopProtocol: 1,
      maxDesktopProtocol: 1,
    })).toThrow('运行时 API 协议不兼容')
    expect(() => assertRuntimeCapabilities({
      apiProtocolVersion: 1,
      minDesktopProtocol: 2,
      maxDesktopProtocol: 3,
    })).toThrow('桌面协议不兼容')
  })

  it('caches a successful handshake by stable API process identity instead of snapshot sequence', async () => {
    const handshakeIdentity = { current: null as string | null }
    const loadCapabilities = vi.fn(async () => compatibleCapabilities())

    await ensureRuntimeCompatibility(
      runtimeSnapshot({ sequence: 1, pid: 42, startedAt: '2026-08-04T00:00:00.000Z', restartCount: 0 }),
      handshakeIdentity,
      loadCapabilities,
    )
    await ensureRuntimeCompatibility(
      runtimeSnapshot({ sequence: 2, pid: 42, startedAt: '2026-08-04T00:00:00.000Z', restartCount: 0 }),
      handshakeIdentity,
      loadCapabilities,
    )

    expect(loadCapabilities).toHaveBeenCalledTimes(1)
  })

  it('performs a new handshake after the API process restarts', async () => {
    const handshakeIdentity = { current: null as string | null }
    const loadCapabilities = vi.fn(async () => compatibleCapabilities())

    await ensureRuntimeCompatibility(
      runtimeSnapshot({ sequence: 1, pid: 42, startedAt: '2026-08-04T00:00:00.000Z', restartCount: 0 }),
      handshakeIdentity,
      loadCapabilities,
    )
    await ensureRuntimeCompatibility(
      runtimeSnapshot({ sequence: 9, pid: 84, startedAt: '2026-08-04T00:05:00.000Z', restartCount: 1 }),
      handshakeIdentity,
      loadCapabilities,
    )

    expect(loadCapabilities).toHaveBeenCalledTimes(2)
  })

  it('does not poison the process cache when a restarted API handshake fails transiently', async () => {
    const handshakeIdentity = { current: null as string | null }
    const loadCapabilities = vi.fn()
      .mockResolvedValueOnce(compatibleCapabilities())
      .mockRejectedValueOnce(new Error('capabilities unavailable'))
      .mockResolvedValueOnce(compatibleCapabilities())
    const original = runtimeSnapshot({
      sequence: 1,
      pid: 42,
      startedAt: '2026-08-04T00:00:00.000Z',
      restartCount: 0,
    })
    const restarted = runtimeSnapshot({
      sequence: 2,
      pid: 84,
      startedAt: '2026-08-04T00:05:00.000Z',
      restartCount: 1,
    })

    await ensureRuntimeCompatibility(original, handshakeIdentity, loadCapabilities)
    const originalIdentity = handshakeIdentity.current
    await expect(ensureRuntimeCompatibility(restarted, handshakeIdentity, loadCapabilities))
      .rejects.toThrow('capabilities unavailable')
    expect(handshakeIdentity.current).toBe(originalIdentity)

    await ensureRuntimeCompatibility(restarted, handshakeIdentity, loadCapabilities)
    expect(loadCapabilities).toHaveBeenCalledTimes(3)
    expect(handshakeIdentity.current).not.toBe(originalIdentity)
  })
})

const noDesktopEvents: DesktopEventConsumer = {
  subscribe: () => () => undefined,
}

function compatibleCapabilities() {
  return {
    releaseId: 'test-release',
    apiProtocolVersion: 1,
    minDesktopProtocol: 1,
    maxDesktopProtocol: 1,
    databaseSchemaVersion: 1,
    workerContractDigest: null,
  }
}

function runtimeSnapshot(input: {
  sequence: number
  pid: number
  startedAt: string
  restartCount: number
}): OperationsSnapshot {
  return {
    sequence: input.sequence,
    services: [{
      serviceId: 'api',
      pid: input.pid,
      startedAt: input.startedAt,
      restartCount: input.restartCount,
    } as OperationsServiceSnapshot],
  } as OperationsSnapshot
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 中文本地运维台测试
//
//   文件:       localConsole.test.tsx
//
//   日期:       2026年07月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-07-22):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 覆盖响应式中文 TUI、数据库隔离与分离行为。
// --------------------------------------------------------------------------

import { EventEmitter } from 'node:events'
import { stripVTControlCharacters } from 'node:util'

import type { OperationsClient } from '@geo-agent-platform/operations-supervisor/client'
import {
  OPERATIONS_PROTOCOL_VERSION,
  type OperationsLogEntry,
  type OperationsSnapshot,
} from '@geo-agent-platform/shared-types/operations'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'
import { ThemeProvider } from '@inkjs/ui'
import { cleanup, render } from 'ink-testing-library'
import stringWidth from 'string-width'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LocalConsoleApp } from './localConsole.js'
import { platformConsoleTheme } from './localConsoleTheme.js'
import type { LocalConsoleDataPlane, LocalConsoleOptions } from './localConsoleTypes.js'
import type { TerminalMouseEvent, TerminalMouseSource } from './terminalMouse.js'

afterEach(() => cleanup())

describe('LocalConsoleApp', () => {
  it.each([
    [80, `${PRODUCT_CODENAME} 本地运维台`],
    [100, '杭州基础设施'],
    [140, '服务检查器'],
    [180, '实时日志'],
  ])('renders a stable Chinese layout at %i columns', async (columns, expected) => {
    const client = createClient()
    const instance = renderConsole(client)
    resize(instance.stdout, columns, 36)

    await vi.waitFor(() => {
      expect(instance.lastFrame()).toContain(expected)
      assertFrameFits(instance.lastFrame(), columns, 36)
    })
  })

  it('shows a non-broken size guard below 80x24', async () => {
    const instance = renderConsole(createClient())
    resize(instance.stdout, 79, 23)

    await vi.waitFor(() => expect(instance.lastFrame()).toContain('终端尺寸不足'))
    expect(instance.lastFrame()).toContain('至少需要 80×24')
  })

  it('keeps the complete control shell usable at the minimum 80x24 size', async () => {
    const instance = renderConsole(createClient())
    resize(instance.stdout, 80, 24)

    await vi.waitFor(() => {
      expect(instance.lastFrame()).toContain('服务操作')
      assertFrameFits(instance.lastFrame(), 80, 24)
    })
    expect(instance.lastFrame()).not.toContain('终端尺寸不足')
    expect(instance.lastFrame()).toContain('鼠标不可用')
    expect(instance.lastFrame()).toContain('分离')
  })

  it('keeps every page within the minimum terminal viewport', async () => {
    const instance = renderConsole(createClient())
    resize(instance.stdout, 80, 24)

    for (const [key, expected] of [
      ['2', '服务:all'],
      ['3', 'admin@example.com'],
      ['4', 'console.account.grant'],
    ] as const) {
      instance.stdin.write(key)
      await vi.waitFor(() => {
        expect(instance.lastFrame()).toContain(expected)
        assertFrameFits(instance.lastFrame(), 80, 24)
      })
    }
  })

  it('keeps service controls visible when the account database is unavailable', async () => {
    const client = createClient()
    const options = createOptions(client, vi.fn().mockRejectedValue(new Error('database offline')))
    const instance = render(
      <ThemeProvider theme={platformConsoleTheme}><LocalConsoleApp options={options} /></ThemeProvider>,
    )
    resize(instance.stdout, 140, 36)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('杭州基础设施'))

    instance.stdin.write('3')

    await vi.waitFor(() => expect(instance.lastFrame()).toContain('账户数据不可用：database offline'))
    expect(instance.lastFrame()).toContain(`${PRODUCT_CODENAME} 本地运维台`)
  })

  it('q detaches the client without issuing a shutdown operation', async () => {
    const client = createClient()
    const instance = renderConsole(client)
    resize(instance.stdout, 100, 30)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('杭州基础设施'))

    instance.stdin.write('q')

    await vi.waitFor(() => expect(client.close).toHaveBeenCalled())
    expect(client.shutdown).not.toHaveBeenCalled()
  })

  it('switches pages through a real measured mouse hit region', async () => {
    const mouse = new TestMouseSource()
    const instance = renderConsole(createClient(), mouse)
    resize(instance.stdout, 140, 36)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('服务检查器'))

    mouse.click(12, 5)

    await vi.waitFor(() => expect(instance.lastFrame()).toContain('服务:all'))
    expect(instance.lastFrame()).toContain('鼠标开启')
  })

  it('pauses and scrolls the log window with the mouse wheel', async () => {
    const mouse = new TestMouseSource()
    const client = createClient(createLogs(40))
    const instance = renderConsole(client, mouse)
    resize(instance.stdout, 140, 36)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('服务检查器'))
    mouse.click(12, 5)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('20–40/40'))

    mouse.wheel(80, 15, -1)

    await vi.waitFor(() => expect(instance.lastFrame()).toContain('Ⅱ 已暂停'))
    expect(instance.lastFrame()).toContain('17–37/40')
  })

  it('routes a mouse service action through the typed supervisor client', async () => {
    const mouse = new TestMouseSource()
    const client = createClient()
    const instance = renderConsole(client, mouse)
    resize(instance.stdout, 140, 36)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('服务操作'))
    await new Promise(resolve => setTimeout(resolve, 20))

    mouse.move(14, 8)
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('› 启动'))
    mouse.click(14, 8)

    await vi.waitFor(() => expect(client.operate).toHaveBeenCalledWith({ action: 'start', target: 'infra' }))
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('启动杭州基础设施完成'))
  })
})

function renderConsole(
  client: OperationsClient,
  mouse?: TerminalMouseSource,
  openDataPlane: LocalConsoleOptions['openDataPlane'] = async () => createDataPlane(),
) {
  return render(
    <ThemeProvider theme={platformConsoleTheme}>
      <LocalConsoleApp options={createOptions(client, openDataPlane)} {...(mouse ? { mouse } : {})} />
    </ThemeProvider>,
  )
}

class TestMouseSource implements TerminalMouseSource {
  readonly enabled = true
  private readonly events = new EventEmitter()

  subscribe(listener: (event: TerminalMouseEvent) => void): () => void {
    this.events.on('mouse', listener)
    return () => this.events.off('mouse', listener)
  }

  click(column: number, row: number): void {
    this.events.emit('mouse', mouseEvent('press', column, row))
    this.events.emit('mouse', mouseEvent('release', column, row))
  }

  wheel(column: number, row: number, deltaY: -1 | 1): void {
    this.events.emit('mouse', { ...mouseEvent('wheel', column, row), button: 'none', deltaY })
  }

  move(column: number, row: number): void {
    this.events.emit('mouse', { ...mouseEvent('move', column, row), button: 'none' })
  }
}

function mouseEvent(kind: TerminalMouseEvent['kind'], column: number, row: number): TerminalMouseEvent {
  return { kind, column, row, button: 'left', deltaY: 0, shift: false, meta: false, ctrl: false }
}

function createOptions(client: OperationsClient, openDataPlane: LocalConsoleOptions['openDataPlane']): LocalConsoleOptions {
  return {
    connectSupervisor: vi.fn().mockResolvedValue(client),
    openDataPlane,
    minPasswordLength: 12,
  }
}

function createClient(logs: OperationsLogEntry[] = []): OperationsClient {
  const events = new EventEmitter()
  const client = {
    server: {
      kind: 'welcome',
      protocolVersion: OPERATIONS_PROTOCOL_VERSION,
      daemonId: '12345678-1234-4234-8234-123456789abc',
      workspaceId: '1234567890abcdef',
      profile: 'development',
    },
    status: vi.fn().mockResolvedValue(snapshot),
    logs: vi.fn().mockResolvedValue({
      entries: logs,
      nextCursor: logs.at(-1)?.sequence ?? null,
      hasMore: false,
    }),
    subscribe: vi.fn().mockResolvedValue(undefined),
    operate: vi.fn().mockResolvedValue({
      operationId: '12345678-1234-4234-8234-123456789abc',
      action: 'start',
      target: 'infra',
      outcome: 'succeeded',
      message: '基础设施已启动。',
      startedAt: '2026-07-22T00:00:00.000Z',
      completedAt: '2026-07-22T00:00:01.000Z',
    }),
    shutdown: vi.fn(),
    close: vi.fn(() => events.emit('disconnected', new Error('client detached'))),
    onEvent: vi.fn((listener: (...args: unknown[]) => void) => {
      events.on('event', listener)
      return () => events.off('event', listener)
    }),
    onDisconnected: vi.fn((listener: (...args: unknown[]) => void) => {
      events.on('disconnected', listener)
      return () => events.off('disconnected', listener)
    }),
  }
  return client as unknown as OperationsClient
}

function createLogs(count: number): OperationsLogEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    sequence: index + 1,
    serviceId: 'api',
    component: 'http',
    processId: 8_000 + index,
    stream: 'stdout',
    level: 'info',
    message: `日志 ${index + 1}`,
    attributes: {},
    createdAt: new Date(Date.UTC(2026, 6, 22, 0, 0, index)).toISOString(),
  }))
}

function createDataPlane(): LocalConsoleDataPlane {
  return {
    accounts: {
      listAccounts: vi.fn().mockResolvedValue([{
        authUserId: 'auth-user-1',
        email: 'admin@example.com',
        displayName: '杭州平台管理员',
        authRole: 'admin',
        banned: false,
        platformUserId: 'platform-user-1',
        platformStatus: 'active',
        platformRoles: [{ workspaceId: 'platform', role: 'platform_admin' }],
      }]),
      createPlatformAdmin: vi.fn(),
      grantPlatformAdmin: vi.fn(),
      revokePlatformAdmin: vi.fn(),
      setAccountEnabled: vi.fn(),
      resetPassword: vi.fn(),
      revokeSessions: vi.fn(),
    },
    listAuditEvents: vi.fn().mockResolvedValue([{
      auditEventId: 'audit-1',
      actorUserId: 'local-operator',
      workspaceId: null,
      action: 'console.account.grant',
      objectType: 'platform_user',
      objectId: 'platform-user-1',
      outcome: 'allowed',
      metadata: {},
      createdAt: '2026-07-22T00:00:00.000Z',
    }]),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

function resize(stdout: EventEmitter, columns: number, rows: number): void {
  Object.defineProperty(stdout, 'columns', { configurable: true, value: columns })
  Object.defineProperty(stdout, 'rows', { configurable: true, value: rows })
  stdout.emit('resize')
}

function assertFrameFits(frame: string, columns: number, rows: number): void {
  const lines = frame.split('\n')
  expect(lines.length).toBeLessThanOrEqual(rows)
  for (const line of lines) {
    const width = stringWidth(stripVTControlCharacters(line))
    expect(width, width > columns ? `${line}\n\n完整画面：\n${frame}` : line).toBeLessThanOrEqual(columns)
  }
}

const unavailable = { value: null, unavailableReason: '尚未采集' } as const
const snapshot: OperationsSnapshot = {
  sequence: 1,
  host: {
    hostname: '杭州开发机',
    platform: 'win32',
    release: 'test',
    profile: 'development',
    supervisorPid: 42,
    supervisorStartedAt: '2026-07-22T00:00:00.000Z',
    cpuPercent: { value: 12.5 },
    memoryUsedBytes: { value: 4 * 1024 ** 3 },
    memoryTotalBytes: { value: 16 * 1024 ** 3 },
    runtimeDiskUsedBytes: { value: 20 * 1024 ** 3 },
    runtimeDiskTotalBytes: { value: 100 * 1024 ** 3 },
    sampledAt: '2026-07-22T00:00:00.000Z',
  },
  services: [
    service('infra', '杭州基础设施', []),
    service('worker', '科学计算', ['infra']),
    service('api', '平台 API', ['infra', 'worker']),
  ],
}

function service(
  serviceId: 'infra' | 'worker' | 'api',
  displayName: string,
  blockedBy: Array<'infra' | 'worker' | 'api'>,
): OperationsSnapshot['services'][number] {
  return {
    serviceId,
    displayName,
    description: `${displayName}测试服务`,
    state: blockedBy.length ? 'stopped' : 'healthy',
    healthMessage: blockedBy.length ? '未启动' : '健康检查通过',
    pid: blockedBy.length ? null : 1234,
    cpuPercent: blockedBy.length ? unavailable : { value: 18.2 },
    memoryBytes: blockedBy.length ? unavailable : { value: 512 * 1024 ** 2 },
    startedAt: blockedBy.length ? null : '2026-07-22T00:00:00.000Z',
    uptimeSeconds: blockedBy.length ? null : 360,
    restartCount: 0,
    lastExitCode: null,
    blockedBy,
  }
}

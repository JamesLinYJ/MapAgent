// +-------------------------------------------------------------------------
//
//   地理智能平台 - 麦克风授权 IPC 测试
//
//   文件:       ipcHandlers.microphone.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({
  dialogResponse: 1,
  handlers: new Map<string, (event: unknown, input: unknown) => unknown>(),
  showMessageBox: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { showAboutPanel: vi.fn() },
  BrowserWindow: class {
    static getFocusedWindow() {
      return null
    }
  },
  clipboard: { writeText: vi.fn() },
  dialog: {
    showMessageBox: electronState.showMessageBox,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, input: unknown) => unknown) => {
      electronState.handlers.set(channel, handler)
    }),
  },
  Menu: {
    buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
    getApplicationMenu: vi.fn(() => null),
    setApplicationMenu: vi.fn(),
  },
}))

import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_CONTROL_FRAME_MAX_BYTES,
  desktopControlResponseTransportSchema,
  desktopMicrophonePermissionResultSchema,
  desktopSupervisorLogsResponseSchema,
  type DesktopControlRequest,
} from '../contracts/desktopIpc.js'
import {
  installDesktopIpcHandlers,
  type DesktopIpcDependencies,
} from './ipcHandlers.js'
import { MicrophonePermissionGate } from './microphonePermissionGate.js'

describe('microphone permission IPC', () => {
  beforeEach(() => {
    electronState.handlers.clear()
    electronState.dialogResponse = 1
    electronState.showMessageBox.mockReset()
    electronState.showMessageBox.mockImplementation(async () => ({
      response: electronState.dialogResponse,
    }))
  })

  it('arms one owner-bound grant only after Main authentication and native confirmation', async () => {
    const gate = new MicrophonePermissionGate(() => 1_000, 60_000)
    const fixture = installFixture(gate)
    const handler = requireHandler()

    const result = desktopMicrophonePermissionResultSchema.parse(
      await handler(fixture.event, { purpose: 'speech-recognition' }),
    )

    expect(result).toEqual({ granted: true, message: null })
    expect(fixture.authorization).toHaveBeenCalledTimes(2)
    expect(electronState.showMessageBox).toHaveBeenCalledWith(
      fixture.window,
      expect.objectContaining({
        title: '允许本次使用麦克风',
        defaultId: 0,
        cancelId: 0,
      }),
    )
    expect(gate.hasActiveGrant(61)).toBe(true)
    expect(fixture.sender.on).toHaveBeenCalledWith(
      'did-start-navigation',
      expect.any(Function),
    )
    expect(fixture.sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function))

    const navigated = fixture.sender.on.mock.calls[0]?.[1] as (
      event: unknown,
      url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ) => void
    navigated({}, 'geo-agent-platform://app/next', false, true)
    expect(gate.hasActiveGrant(61)).toBe(false)
    expect(gate.grant(61)).toBe(false)
    const destroyed = fixture.sender.once.mock.calls[0]?.[1] as (() => void) | undefined
    destroyed?.()
    expect(gate.hasActiveGrant(61)).toBe(false)
    expect(gate.grant(61)).toBe(true)
  })

  it('fails closed for rejection, malformed requests, and unknown windows', async () => {
    const gate = new MicrophonePermissionGate(() => 1_000, 60_000)
    const fixture = installFixture(gate)
    const handler = requireHandler()
    gate.grant(61)
    electronState.dialogResponse = 0

    await expect(handler(
      fixture.event,
      { purpose: 'speech-recognition' },
    )).resolves.toEqual({
      granted: false,
      message: '你已取消本次麦克风授权，语音识别未启动。',
    })
    expect(gate.hasActiveGrant(61)).toBe(false)

    await expect(handler(fixture.event, { purpose: 'camera' })).rejects.toThrow()
    fixture.getForWebContents.mockReturnValue(null)
    await expect(handler(
      fixture.event,
      { purpose: 'speech-recognition' },
    )).rejects.toThrow('未知窗口')
    expect(gate.hasActiveGrant(61)).toBe(false)
  })
})

describe('desktop IPC transport ownership', () => {
  beforeEach(() => {
    electronState.handlers.clear()
  })

  it('compresses large auth projections and keeps bulk logs off the control channel', async () => {
    const frame = { url: 'geo-agent-platform://app/workspace' }
    const sender = {
      id: 62,
      isDestroyed: () => false,
      on: vi.fn(),
      once: vi.fn(),
    }
    const window = {
      webContents: {
        id: 62,
        mainFrame: frame,
      },
      isDestroyed: () => false,
    }
    const logs = Array.from({ length: 1_000 }, (_, index) => ({
      sequence: index + 1,
      serviceId: 'api' as const,
      component: 'server',
      processId: 42,
      stream: 'stdout' as const,
      level: 'info' as const,
      event: 'request.http.completed',
      category: 'request' as const,
      retention: 'operational' as const,
      correlation: { requestId: `request_${index}` },
      message: `日志 ${index} ${'运行信息'.repeat(30)}`,
      errorStack: null,
      attributes: {},
      createdAt: '2026-07-30T08:00:00.000Z',
    }))
    installDesktopIpcHandlers({
      api: {},
      auth: {
        handle: vi.fn(async (request: DesktopControlRequest) => ({
          version: request.version,
          requestId: request.requestId,
          ok: true,
          data: { memberships: '工作区成员'.repeat(40_000) },
        })),
      },
      control: {},
      downloads: {},
      exports: {},
      files: {},
      logger: {},
      microphone: {},
      supervisor: {
        handle: vi.fn(),
        logs: vi.fn(async () => ({ entries: logs, nextCursor: 1_000, hasMore: false })),
      },
      windows: {
        getForWebContents: vi.fn(() => window),
      },
    } as unknown as DesktopIpcDependencies)
    const event = { sender, senderFrame: frame }
    const authHandler = requireChannelHandler(DESKTOP_IPC_CHANNELS.authRequest)
    const logsHandler = requireChannelHandler(DESKTOP_IPC_CHANNELS.supervisorLogs)

    const authTransport = desktopControlResponseTransportSchema.parse(
      await authHandler(event, {
        version: 1,
        requestId: '019fa8d2-d331-7c48-a667-68383b815be9',
        command: 'projection',
        payload: {},
      }),
    )
    expect(authTransport).toMatchObject({ encoding: 'gzip-base64' })

    const logResponse = await logsHandler(event, {
      services: ['infra', 'worker', 'api'],
      levels: [],
      streams: [],
      categories: [],
      events: [],
      retentions: [],
      correlationId: '',
      search: '',
      includeSupervisor: true,
      afterSequence: null,
      tail: 2_000,
    })
    const parsedLogResponse = desktopSupervisorLogsResponseSchema.parse(logResponse)
    expect(parsedLogResponse).toMatchObject({ hasMore: true })
    expect(parsedLogResponse.entries.length).toBeLessThan(logs.length)
    expect(new TextEncoder().encode(JSON.stringify(parsedLogResponse)).byteLength)
      .toBeLessThanOrEqual(DESKTOP_CONTROL_FRAME_MAX_BYTES)
  })
})

function installFixture(gate: MicrophonePermissionGate) {
  const frame = { url: 'geo-agent-platform://app/workspace' }
  const sender = {
    id: 61,
    isDestroyed: () => false,
    on: vi.fn(),
    once: vi.fn(),
  }
  const window = {
    webContents: {
      id: 61,
      mainFrame: frame,
    },
    isDestroyed: () => false,
  }
  const getForWebContents = vi.fn((): typeof window | null => window)
  const authorization = vi.fn(() => ({
    userId: 'user_1',
    csrfToken: 'main-only-csrf',
    revision: 1,
    platformRoles: ['platform_admin'] as const,
    permissions: [],
  }))
  installDesktopIpcHandlers({
    api: {},
    auth: { requireAuthorizationContext: authorization },
    control: {},
    downloads: {},
    exports: {},
    files: {},
    microphone: gate,
    supervisor: {},
    windows: { getForWebContents },
  } as unknown as DesktopIpcDependencies)
  return {
    authorization,
    event: { sender, senderFrame: frame },
    getForWebContents,
    sender,
    window,
  }
}

function requireHandler() {
  return requireChannelHandler(DESKTOP_IPC_CHANNELS.microphonePermission)
}

function requireChannelHandler(channel: string) {
  const handler = electronState.handlers.get(channel)
  if (!handler) throw new Error(`桌面 IPC 通道未注册：${channel}`)
  return handler
}

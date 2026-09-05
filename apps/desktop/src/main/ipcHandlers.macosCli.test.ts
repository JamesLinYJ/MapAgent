// +-------------------------------------------------------------------------
//
//   地理智能平台 - macOS 终端命令 IPC 测试
//
//   文件:       ipcHandlers.macosCli.test.ts
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => unknown>(),
}))

vi.mock('electron', () => ({
  app: { showAboutPanel: vi.fn() },
  BrowserWindow: class {
    static getFocusedWindow() {
      return null
    }
  },
  clipboard: { writeText: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, input?: unknown) => unknown) => {
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
  desktopMacosCliStatusSchema,
} from '../contracts/desktopIpc.js'
import {
  installDesktopIpcHandlers,
  type DesktopIpcDependencies,
} from './ipcHandlers.js'

const installed = {
  state: 'installed' as const,
  commandPath: '/usr/local/bin/geo-agent-platform' as const,
  message: '终端命令已安装。',
  canInstall: false,
  canRepair: false,
  canRemove: true,
}

describe('macOS terminal command IPC', () => {
  beforeEach(() => {
    electronState.handlers.clear()
  })

  it('accepts only fixed actions from a trusted top-level application frame', async () => {
    const fixture = installFixture()
    const statusHandler = requireHandler(DESKTOP_IPC_CHANNELS.macosCliStatus)
    const actionHandler = requireHandler(DESKTOP_IPC_CHANNELS.macosCliAction)

    expect(desktopMacosCliStatusSchema.parse(
      await statusHandler(fixture.event),
    )).toEqual(installed)
    expect(desktopMacosCliStatusSchema.parse(
      await actionHandler(fixture.event, 'repair'),
    )).toEqual(installed)
    expect(fixture.perform).toHaveBeenCalledWith('repair')

    await expect(actionHandler(fixture.event, {
      action: 'repair',
      commandPath: '/tmp/attacker',
    })).rejects.toThrow()
    expect(fixture.perform).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown windows before reading or changing command state', async () => {
    const fixture = installFixture()
    fixture.getForWebContents.mockReturnValue(null)

    await expect(requireHandler(DESKTOP_IPC_CHANNELS.macosCliStatus)(fixture.event))
      .rejects.toThrow('未知窗口')
    await expect(requireHandler(DESKTOP_IPC_CHANNELS.macosCliAction)(fixture.event, 'remove'))
      .rejects.toThrow('未知窗口')
    expect(fixture.status).not.toHaveBeenCalled()
    expect(fixture.perform).not.toHaveBeenCalled()
  })
})

function installFixture() {
  const frame = { url: 'geo-agent-platform://app/workspace' }
  const sender = { id: 71 }
  const window = {
    webContents: { id: 71, mainFrame: frame },
    isDestroyed: () => false,
  }
  const getForWebContents = vi.fn((): typeof window | null => window)
  const status = vi.fn(async () => installed)
  const perform = vi.fn(async () => installed)
  installDesktopIpcHandlers({
    installedCli: { status, perform },
    windows: { getForWebContents },
  } as unknown as DesktopIpcDependencies)
  return {
    event: { sender, senderFrame: frame },
    getForWebContents,
    perform,
    status,
  }
}

function requireHandler(channel: string) {
  const handler = electronState.handlers.get(channel)
  if (!handler) throw new Error(`桌面 IPC 通道未注册：${channel}`)
  return handler
}

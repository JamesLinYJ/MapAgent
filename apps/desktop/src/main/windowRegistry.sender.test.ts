// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区窗口 IPC 所有权测试
//
//   文件:       windowRegistry.sender.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

const { getAllWindows } = vi.hoisted(() => ({
  getAllWindows: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class MockBrowserWindow {
    static getAllWindows = getAllWindows

    private destroyed = false
    private readonly contents = {
      id: 41,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    }
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

    get webContents() {
      if (this.destroyed) throw new TypeError('Object has been destroyed')
      return this.contents
    }

    isDestroyed = () => this.destroyed
    isMinimized = () => false
    isFullScreen = () => false
    isMaximized = vi.fn(() => false)
    restore = vi.fn()
    show = vi.fn()
    focus = vi.fn()
    setMenuBarVisibility = vi.fn()
    setTitle = vi.fn()
    setFullScreen = vi.fn()
    unmaximize = vi.fn()
    setBounds = vi.fn()
    setSize = vi.fn()
    center = vi.fn()
    loadURL = vi.fn(async () => undefined)

    once(event: string, listener: (...args: unknown[]) => void) {
      return this.on(event, listener)
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }

    destroyForTest(): void {
      this.destroyed = true
      for (const listener of this.listeners.get('closed') ?? []) listener()
    }
  },
  dialog: {},
  shell: {},
}))
vi.mock('electron-window-state', () => ({
  default: vi.fn(() => ({
    width: 1_580,
    height: 960,
    x: undefined,
    y: undefined,
    manage: vi.fn(),
    saveState: vi.fn(),
    unmanage: vi.fn(),
  })),
}))
vi.mock('./nativeMenus.js', () => ({
  installNativeContextMenu: vi.fn(),
}))

import { WorkspaceWindowRegistry } from './windowRegistry.js'

describe('WorkspaceWindowRegistry IPC ownership', () => {
  it('resolves only registry-owned windows, never arbitrary same-process windows', () => {
    const registry = new WorkspaceWindowRegistry({
      releaseForWebContents: vi.fn(),
    } as never)
    const registered = fakeWindow(11)
    const unregistered = fakeWindow(22)
    registeredWindows(registry).set('workspace_1', registered)
    getAllWindows.mockReturnValue([registered, unregistered])

    expect(registry.getForWebContents(11)).toBe(registered)
    expect(registry.getForWebContents(22)).toBeNull()
    expect(registry.first()).toBe(registered)
    expect(getAllWindows).not.toHaveBeenCalled()
  })

  it('releases file handles after Electron has destroyed the BrowserWindow object', () => {
    const releaseForWebContents = vi.fn()
    const registry = new WorkspaceWindowRegistry({ releaseForWebContents } as never)
    const window = registry.openBootstrap() as unknown as { destroyForTest(): void }

    expect(() => window.destroyForTest()).not.toThrow()
    expect(releaseForWebContents).toHaveBeenCalledWith(41)
  })

  it('uses the locally configured product name in workspace window titles', () => {
    const registry = new WorkspaceWindowRegistry(
      { releaseForWebContents: vi.fn() } as never,
      '团队地理工作台',
    )
    const window = registry.openBootstrap() as never

    registry.bind(window, {
      workspaceId: 'workspace_1',
      workspaceName: '测试工作区',
      sessionId: null,
      threadId: null,
    })

    expect((window as { setTitle: ReturnType<typeof vi.fn> }).setTitle)
      .toHaveBeenCalledWith('测试工作区 — 团队地理工作台')
  })

  it('keeps a maximized window unchanged when the same workspace metadata is rebound', () => {
    const registry = new WorkspaceWindowRegistry({
      releaseForWebContents: vi.fn(),
    } as never)
    const window = registry.openBootstrap() as unknown as {
      isMaximized: ReturnType<typeof vi.fn>
      setSize: ReturnType<typeof vi.fn>
      unmaximize: ReturnType<typeof vi.fn>
    }

    registry.bind(window as never, {
      workspaceId: 'workspace_1',
      workspaceName: '测试工作区',
      sessionId: 'session_1',
      threadId: 'thread_1',
    })
    expect(window.setSize).toHaveBeenCalledOnce()

    window.isMaximized.mockReturnValue(true)
    registry.bind(window as never, {
      workspaceId: 'workspace_1',
      workspaceName: '测试工作区',
      sessionId: 'session_1',
      threadId: 'thread_2',
    })

    expect(window.setSize).toHaveBeenCalledOnce()
    expect(window.unmaximize).not.toHaveBeenCalled()
  })
})

function registeredWindows(
  registry: WorkspaceWindowRegistry,
): Map<string, ReturnType<typeof fakeWindow>> {
  return (registry as unknown as {
    windows: Map<string, ReturnType<typeof fakeWindow>>
  }).windows
}

function fakeWindow(webContentsId: number) {
  return {
    isDestroyed: () => false,
    webContents: { id: webContentsId },
  }
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Windows Squirrel 安装生命周期测试
//
//   文件:       squirrelLifecycle.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import {
  PLATFORM_TECHNICAL_ID,
  PRODUCT_EXECUTABLE_BASENAME,
} from '@geo-agent-platform/shared-types/product-identity'

import { handleSquirrelLifecycle } from './squirrelLifecycle.js'

describe('handleSquirrelLifecycle', () => {
  const executableName = `${PRODUCT_EXECUTABLE_BASENAME}.exe`
  const installedApplicationDirectory = path.win32.join(
    'C:\\Users\\operator\\AppData\\Local',
    PLATFORM_TECHNICAL_ID,
    'app-0.1.0',
  )
  const installedExecutable = path.win32.join(installedApplicationDirectory, executableName)

  it.each([
    ['--squirrel-install', '--createShortcut'],
    ['--squirrel-updated', '--createShortcut'],
    ['--squirrel-uninstall', '--removeShortcut'],
  ] as const)('handles %s before normal application startup', (event, expectedVerb) => {
    const quit = vi.fn()
    const runUpdate = vi.fn()

    expect(handleSquirrelLifecycle({
      platform: 'win32',
      arguments: [installedExecutable, event],
      executablePath: installedExecutable,
      quit,
      runUpdate,
    })).toBe(true)

    expect(runUpdate).toHaveBeenCalledWith(
      path.win32.join(path.win32.dirname(installedApplicationDirectory), 'Update.exe'),
      [expectedVerb, executableName],
      quit,
    )
    expect(quit).not.toHaveBeenCalled()
  })

  it('quits obsolete versions without invoking Update.exe', () => {
    const quit = vi.fn()
    const runUpdate = vi.fn()

    expect(handleSquirrelLifecycle({
      platform: 'win32',
      arguments: [executableName, '--squirrel-obsolete'],
      executablePath: path.win32.join('C:\\PlatformFixture\\app-0.1.0', executableName),
      quit,
      runUpdate,
    })).toBe(true)
    expect(quit).toHaveBeenCalledOnce()
    expect(runUpdate).not.toHaveBeenCalled()
  })

  it('leaves normal launches and non-Windows platforms untouched', () => {
    const quit = vi.fn()
    const runUpdate = vi.fn()
    const normal = {
      arguments: [executableName, '--squirrel-firstrun'],
      executablePath: path.win32.join('C:\\PlatformFixture\\app-0.1.0', executableName),
      quit,
      runUpdate,
    }

    expect(handleSquirrelLifecycle({ ...normal, platform: 'win32' })).toBe(false)
    expect(handleSquirrelLifecycle({
      ...normal,
      platform: 'linux',
      arguments: ['platform-fixture', '--squirrel-install'],
    })).toBe(false)
    expect(quit).not.toHaveBeenCalled()
    expect(runUpdate).not.toHaveBeenCalled()
  })
})

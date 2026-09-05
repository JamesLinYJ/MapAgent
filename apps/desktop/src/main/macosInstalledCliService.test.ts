// +-------------------------------------------------------------------------
//
//   地理智能平台 - macOS 安装版命令行链接服务测试
//
//   文件:       macosInstalledCliService.test.ts
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import { DESKTOP_MACOS_CLI_COMMAND_PATH } from '../contracts/desktopIpc.js'
import {
  MACOS_INSTALLED_CLI_PRIVILEGED_PROGRAM,
  MacosInstalledCliService,
} from './macosInstalledCliService.js'

type Entry =
  | { kind: 'missing' }
  | { kind: 'symlink'; target: string }
  | { kind: 'other' }

const resourcesPath = '/Applications/MapAgents.app/Contents/Resources'
const launcherPath = `${resourcesPath}/io.geoagentplatform.desktop-cli/geo-agent-platform`

describe('MacosInstalledCliService', () => {
  it('only exposes the fixed command path and strict state capabilities', async () => {
    for (const fixture of [
      {
        entry: { kind: 'missing' } as Entry,
        state: 'not_installed',
        capabilities: [true, false, false],
      },
      {
        entry: { kind: 'symlink', target: launcherPath } as Entry,
        state: 'installed',
        capabilities: [false, false, true],
      },
      {
        entry: {
          kind: 'symlink',
          target: '/Applications/Old.app/Contents/Resources/io.geoagentplatform.desktop-cli/geo-agent-platform',
        } as Entry,
        state: 'needs_repair',
        capabilities: [false, true, false],
      },
      {
        entry: { kind: 'other' } as Entry,
        state: 'conflict',
        capabilities: [false, false, false],
      },
      {
        entry: { kind: 'symlink', target: '/usr/local/bin/another-command' } as Entry,
        state: 'conflict',
        capabilities: [false, false, false],
      },
      {
        entry: { kind: 'symlink', target: 'relative/geo-agent-platform' } as Entry,
        state: 'conflict',
        capabilities: [false, false, false],
      },
    ] as const) {
      const service = createService(fixture.entry)
      const result = await service.status()
      expect(result.state).toBe(fixture.state)
      expect(result.commandPath).toBe(DESKTOP_MACOS_CLI_COMMAND_PATH)
      expect([result.canInstall, result.canRepair, result.canRemove]).toEqual(fixture.capabilities)
    }
  })

  it('does not inspect or mutate paths outside a packaged macOS application', async () => {
    const inspectLink = vi.fn(async (): Promise<Entry> => ({ kind: 'missing' }))
    const runPrivilegedOperation = vi.fn(async () => {})
    const service = new MacosInstalledCliService({
      platform: 'linux',
      isPackaged: true,
      resourcesPath,
    }, {
      isExecutable: async () => true,
      inspectLink,
      runPrivilegedOperation,
    })

    expect((await service.status()).state).toBe('unavailable')
    await expect(service.perform('install')).rejects.toThrow('仅由 macOS 正式安装包提供')
    expect(inspectLink).not.toHaveBeenCalled()
    expect(runPrivilegedOperation).not.toHaveBeenCalled()
  })

  it('installs an absent link through the fixed inline program and rechecks the result', async () => {
    let entry: Entry = { kind: 'missing' }
    const runPrivilegedOperation = vi.fn(async request => {
      expect(request).toEqual({ action: 'install', launcherPath })
      entry = { kind: 'symlink', target: launcherPath }
    })
    const service = createServiceFromReader(() => entry, runPrivilegedOperation)

    const result = await service.perform('install')

    expect(result.state).toBe('installed')
    expect(runPrivilegedOperation).toHaveBeenCalledTimes(1)
  })

  it('keeps the privileged link program inline and limited to fixed link operations', () => {
    expect(MACOS_INSTALLED_CLI_PRIVILEGED_PROGRAM).toContain(
      "command_path='/usr/local/bin/geo-agent-platform'",
    )
    expect(MACOS_INSTALLED_CLI_PRIVILEGED_PROGRAM).toContain(
      "owned_suffix='/Contents/Resources/io.geoagentplatform.desktop-cli/geo-agent-platform'",
    )
    expect(MACOS_INSTALLED_CLI_PRIVILEGED_PROGRAM).toContain('install|repair|remove')
    expect(MACOS_INSTALLED_CLI_PRIVILEGED_PROGRAM).not.toContain('manage-link')
    expect(MACOS_INSTALLED_CLI_PRIVILEGED_PROGRAM).not.toContain('rm -rf')
    expect(MACOS_INSTALLED_CLI_PRIVILEGED_PROGRAM).not.toContain('ln -sf')
  })

  it('repairs and removes only links carrying the application-owned resource suffix', async () => {
    let entry: Entry = {
      kind: 'symlink',
      target: '/Applications/Old.app/Contents/Resources/io.geoagentplatform.desktop-cli/geo-agent-platform',
    }
    const runPrivilegedOperation = vi.fn(async request => {
      entry = request.action === 'remove'
        ? { kind: 'missing' }
        : { kind: 'symlink', target: launcherPath }
    })
    const service = createServiceFromReader(() => entry, runPrivilegedOperation)

    expect((await service.perform('repair')).state).toBe('installed')
    expect((await service.perform('remove')).state).toBe('not_installed')
    expect(runPrivilegedOperation.mock.calls.map(([request]) => request.action)).toEqual([
      'repair',
      'remove',
    ])
  })

  it('requires repairing an absent old target before it can be removed', async () => {
    const runPrivilegedOperation = vi.fn(async () => {})
    const service = createServiceFromReader(() => ({
      kind: 'symlink',
      target: '/Applications/Old.app/Contents/Resources/io.geoagentplatform.desktop-cli/geo-agent-platform',
    }), runPrivilegedOperation)

    const current = await service.status()
    expect(current.state).toBe('needs_repair')
    expect(current.canRemove).toBe(false)
    await expect(service.perform('remove')).rejects.toThrow('没有可移除')
    expect(runPrivilegedOperation).not.toHaveBeenCalled()
  })

  it('treats another still-existing application with the same resource layout as a conflict', async () => {
    const target = '/Applications/Other.app/Contents/Resources/io.geoagentplatform.desktop-cli/geo-agent-platform'
    const runPrivilegedOperation = vi.fn(async () => {})
    const service = new MacosInstalledCliService({
      platform: 'darwin',
      isPackaged: true,
      resourcesPath,
    }, {
      isExecutable: async () => true,
      pathExists: async candidate => candidate === target,
      inspectLink: async () => ({ kind: 'symlink', target }),
      runPrivilegedOperation,
    })

    const result = await service.status()
    expect(result.state).toBe('conflict')
    expect(result.canRepair).toBe(false)
    expect(result.canRemove).toBe(false)
    await expect(service.perform('repair')).rejects.toThrow('仍然存在的应用')
    await expect(service.perform('remove')).rejects.toThrow('仍然存在的应用')
    expect(runPrivilegedOperation).not.toHaveBeenCalled()
  })

  it('refuses to overwrite or remove a foreign target without requesting authorization', async () => {
    const runPrivilegedOperation = vi.fn(async () => {})
    const service = createServiceFromReader(
      () => ({ kind: 'symlink', target: '/usr/local/bin/foreign-tool' }),
      runPrivilegedOperation,
    )

    await expect(service.perform('install')).rejects.toThrow('不会覆盖或删除')
    await expect(service.perform('repair')).rejects.toThrow('不会覆盖或删除')
    await expect(service.perform('remove')).rejects.toThrow('不会覆盖或删除')
    expect(runPrivilegedOperation).not.toHaveBeenCalled()
  })

  it('fails closed when the privileged operation does not produce the requested state', async () => {
    const service = createServiceFromReader(
      () => ({ kind: 'missing' }),
      vi.fn(async () => {}),
    )

    await expect(service.perform('install')).rejects.toThrow('状态未达到预期')
  })
})

function createService(entry: Entry): MacosInstalledCliService {
  return createServiceFromReader(() => entry, async () => {})
}

function createServiceFromReader(
  read: () => Entry,
  runPrivilegedOperation: NonNullable<
    ConstructorParameters<typeof MacosInstalledCliService>[1]
  >['runPrivilegedOperation'],
): MacosInstalledCliService {
  return new MacosInstalledCliService({
    platform: 'darwin',
    isPackaged: true,
    resourcesPath,
  }, {
    isExecutable: async () => true,
    pathExists: async () => false,
    inspectLink: async filePath => {
      expect(filePath).toBe(DESKTOP_MACOS_CLI_COMMAND_PATH)
      return read()
    },
    runPrivilegedOperation,
  })
}

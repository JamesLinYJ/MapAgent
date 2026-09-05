// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面运行时认证配置测试
//
//   文件:       runtimeConfig.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PLATFORM_TECHNICAL_ID,
} from '@geo-agent-platform/shared-types/product-identity'

import {
  defaultDesktopRuntimeManifestPath,
  resolveDesktopAutoAuthConfig,
  resolveDesktopRuntimeConfig,
} from './runtimeConfig.js'

describe('resolveDesktopAutoAuthConfig', () => {
  const runtimeRoot = path.resolve('runtime-test')

  it('enables a local managed identity by default without account credentials', () => {
    const config = resolveDesktopAutoAuthConfig({
      environment: {},
      profile: 'development',
      runtimeRoot,
      apiBaseUrl: 'http://127.0.0.1:8000',
    })

    expect(config).toEqual({ mode: 'local_managed' })
  })

  it('restores interactive login when development auto auth is explicitly disabled', () => {
    expect(resolveDesktopAutoAuthConfig({
      environment: {
        GEO_AGENT_PLATFORM_DESKTOP_AUTO_AUTH: 'false',
      },
      profile: 'development',
      runtimeRoot,
      apiBaseUrl: 'http://127.0.0.1:8000',
    })).toBeNull()
  })

  it('rejects remote APIs but supports the production local runtime', () => {
    const environment = {
      GEO_AGENT_PLATFORM_DESKTOP_AUTO_AUTH: 'true',
    }
    expect(() => resolveDesktopAutoAuthConfig({
      environment,
      profile: 'development',
      runtimeRoot,
      apiBaseUrl: 'https://api.example.com',
    })).toThrow('回环 API')
    expect(resolveDesktopAutoAuthConfig({
      environment,
      profile: 'production',
      runtimeRoot,
      apiBaseUrl: 'http://127.0.0.1:8000',
    })).toEqual({ mode: 'local_managed' })
  })

  it('lets a production deployment explicitly enable the optional account extension', () => {
    expect(resolveDesktopAutoAuthConfig({
      environment: {
        GEO_AGENT_PLATFORM_DESKTOP_AUTO_AUTH: 'false',
      },
      profile: 'production',
      runtimeRoot,
      apiBaseUrl: 'http://127.0.0.1:8000',
    })).toBeNull()
  })
})

describe('resolveDesktopRuntimeConfig', () => {
  it('locates the workspace root from a nested Electron build directory', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-desktop-dev-root-'))
    try {
      const applicationPath = path.join(directory, 'apps', 'desktop', 'out', 'main')
      await mkdir(applicationPath, { recursive: true })
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({
        private: true,
        workspaces: ['apps/desktop', 'packages/shared-types'],
      }), 'utf8')

      const config = resolveDesktopRuntimeConfig({}, {
        profile: 'development',
        applicationPath,
      })

      expect(config.projectRoot).toBe(directory)
      expect(config.runtimeRoot).toBe(path.join(directory, 'runtime'))
      expect(config.supervisorTokenFile).toBe(path.join(directory, 'runtime', 'ops', 'supervisor.token'))
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('resolves relative runtime paths from the workspace instead of the process directory', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-desktop-relative-runtime-'))
    try {
      const applicationPath = path.join(directory, 'apps', 'desktop', 'out', 'main')
      await mkdir(applicationPath, { recursive: true })
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({
        private: true,
        workspaces: ['apps/desktop'],
      }), 'utf8')

      const config = resolveDesktopRuntimeConfig({
        RUNTIME_ROOT: './var/runtime',
        GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE: './var/secrets/supervisor.token',
      }, {
        profile: 'development',
        applicationPath,
      })

      expect(config.runtimeRoot).toBe(path.join(directory, 'var', 'runtime'))
      expect(config.supervisorTokenFile).toBe(path.join(directory, 'var', 'secrets', 'supervisor.token'))
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('requires an explicitly configured project root to be absolute', () => {
    expect(() => resolveDesktopRuntimeConfig({
      GEO_AGENT_PLATFORM_ROOT: '.',
    }, {
      profile: 'development',
      applicationPath: path.resolve('unused'),
    })).toThrow('路径必须是绝对路径')
  })

  it('fails explicitly when a development build has no workspace root', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-desktop-dev-missing-'))
    try {
      expect(() => resolveDesktopRuntimeConfig({}, {
        profile: 'development',
        applicationPath: path.join(directory, 'out', 'main'),
      })).toThrow('无法从 Desktop 应用目录定位开发工作区')
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('uses the protected production manifest instead of ambient legacy variables', async () => {
    const directory = await realpath(await mkdtemp(
      path.join(os.tmpdir(), 'geo-agent-platform-desktop-config-'),
    ))
    try {
      const runtimeRoot = path.join(directory, 'runtime')
      const projectRoot = path.join(directory, 'project')
      const supervisorTokenFile = path.join(runtimeRoot, 'secrets', 'supervisor.token')
      const manifestPath = path.join(directory, 'runtime-manifest.v1.json')
      await mkdir(projectRoot, { recursive: true })
      await mkdir(path.dirname(supervisorTokenFile), { recursive: true })
      await writeFile(supervisorTokenFile, 'test-supervisor-token\n', 'utf8')
      await writeFile(manifestPath, JSON.stringify({
        kind: 'geo-agent-platform.desktop-runtime',
        schemaVersion: 1,
        projectRoot,
        runtimeRoot,
        apiBaseUrl: 'http://127.0.0.1:8123',
        supervisorTokenFile,
        allowedEnvironmentOverrides: [],
      }), 'utf8')

      const config = resolveDesktopRuntimeConfig({
        API_PORT: '9999',
      }, {
        profile: 'production',
        platform: 'win32',
        runtimeManifestPath: manifestPath,
      })

      expect(config).toMatchObject({
        profile: 'production',
        projectRoot,
        runtimeRoot,
        apiBaseUrl: 'http://127.0.0.1:8123',
        supervisorTokenFile,
        runtimeManifestPath: manifestPath,
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('uses a fixed system manifest location that ambient ProgramData cannot redirect', () => {
    expect(defaultDesktopRuntimeManifestPath('win32', {
      ProgramData: path.win32.join('C:\\', 'ProgramData'),
    }))
      .toBe(path.win32.join('C:\\ProgramData', PLATFORM_TECHNICAL_ID, 'runtime-manifest.v1.json'))
    expect(defaultDesktopRuntimeManifestPath('linux'))
      .toBe('/etc/geo-agent-platform/runtime-manifest.v1.json')
  })

  it('requires the Windows system configuration root instead of embedding a project path', () => {
    expect(defaultDesktopRuntimeManifestPath('win32', {
      ProgramData: path.win32.join('C:\\', 'ProgramData'),
    })).toBe(path.win32.join('C:\\ProgramData', PLATFORM_TECHNICAL_ID, 'runtime-manifest.v1.json'))
    expect(() => defaultDesktopRuntimeManifestPath('win32', {}))
      .toThrow('ProgramData')
  })
})

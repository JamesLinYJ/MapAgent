// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面生产运行时清单测试
//
//   文件:       runtimeManifest.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  applyControlledRuntimeEnvironment,
  loadDesktopRuntimeManifest,
  parseDesktopRuntimeManifest,
} from './runtimeManifest.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { force: true, recursive: true })
  )))
})

describe('desktop runtime manifest', () => {
  it('accepts only the strict v1 contract and normalizes the API origin', () => {
    const runtimeRoot = path.resolve('runtime')
    const manifest = parseDesktopRuntimeManifest({
      kind: 'geo-agent-platform.desktop-runtime',
      schemaVersion: 1,
      projectRoot: path.resolve('project'),
      runtimeRoot,
      apiBaseUrl: 'http://127.0.0.1:8000/',
      supervisorTokenFile: path.join(runtimeRoot, 'ops', 'supervisor.token'),
      allowedEnvironmentOverrides: [],
    })

    expect(manifest.apiBaseUrl).toBe('http://127.0.0.1:8000')
    expect(manifest.schemaVersion).toBe(1)
    expect(() => parseDesktopRuntimeManifest({
      ...manifest,
      schemaVersion: 2,
    })).toThrow()
    expect(() => parseDesktopRuntimeManifest({
      ...manifest,
      undocumentedFallback: true,
    })).toThrow()
  })

  it('rejects relative paths, API subpaths, duplicate overrides and token escape', () => {
    const runtimeRoot = path.resolve('runtime')
    const valid = {
      kind: 'geo-agent-platform.desktop-runtime',
      schemaVersion: 1,
      projectRoot: path.resolve('project'),
      runtimeRoot,
      apiBaseUrl: 'http://127.0.0.1:8000',
      supervisorTokenFile: path.join(runtimeRoot, 'ops', 'supervisor.token'),
      allowedEnvironmentOverrides: [],
    }

    expect(() => parseDesktopRuntimeManifest({
      ...valid,
      projectRoot: './project',
    })).toThrow('绝对路径')
    expect(() => parseDesktopRuntimeManifest({
      ...valid,
      apiBaseUrl: 'http://127.0.0.1:8000/api',
    })).toThrow('根地址')
    expect(() => parseDesktopRuntimeManifest({
      ...valid,
      supervisorTokenFile: path.resolve('outside', 'supervisor.token'),
    })).toThrow('runtimeRoot')
    expect(() => parseDesktopRuntimeManifest({
      ...valid,
      allowedEnvironmentOverrides: ['APP_BASE_URL', 'APP_BASE_URL'],
    })).toThrow('重复项')
  })

  it('hard-fails inherited production variables unless the protected manifest authorizes them', () => {
    const runtimeRoot = path.resolve('runtime')
    const manifest = parseDesktopRuntimeManifest({
      kind: 'geo-agent-platform.desktop-runtime',
      schemaVersion: 1,
      projectRoot: path.resolve('project'),
      runtimeRoot,
      apiBaseUrl: 'http://127.0.0.1:8000',
      supervisorTokenFile: path.join(runtimeRoot, 'ops', 'supervisor.token'),
      allowedEnvironmentOverrides: ['APP_BASE_URL'],
    })

    expect(applyControlledRuntimeEnvironment(manifest, {
      APP_BASE_URL: 'https://api.example.com',
    }).apiBaseUrl).toBe('https://api.example.com')
    expect(() => applyControlledRuntimeEnvironment(manifest, {
      GEO_AGENT_PLATFORM_ROOT: path.resolve('other-project'),
    })).toThrow('未授权环境变量 GEO_AGENT_PLATFORM_ROOT')
  })

  it('loads a bounded ordinary manifest file', async () => {
    const directory = await createTemporaryDirectory()
    const { projectRoot, runtimeRoot, supervisorTokenFile } = await createRuntimeTargets(directory)
    const manifestPath = path.join(directory, 'runtime-manifest.v1.json')
    await writeFile(manifestPath, JSON.stringify({
      kind: 'geo-agent-platform.desktop-runtime',
      schemaVersion: 1,
      projectRoot,
      runtimeRoot,
      apiBaseUrl: 'http://127.0.0.1:8000',
      supervisorTokenFile,
      allowedEnvironmentOverrides: [],
    }), 'utf8')

    expect(loadDesktopRuntimeManifest(manifestPath, {
      platform: 'win32',
    }).kind).toBe('geo-agent-platform.desktop-runtime')
  })

  it.runIf(process.platform !== 'win32')('enforces POSIX ownership and write protection', async () => {
    const directory = await createTemporaryDirectory()
    const { projectRoot, runtimeRoot, supervisorTokenFile } = await createRuntimeTargets(directory)
    const manifestPath = path.join(directory, 'runtime-manifest.v1.json')
    await writeFile(manifestPath, JSON.stringify({
      kind: 'geo-agent-platform.desktop-runtime',
      schemaVersion: 1,
      projectRoot,
      runtimeRoot,
      apiBaseUrl: 'http://127.0.0.1:8000',
      supervisorTokenFile,
      allowedEnvironmentOverrides: [],
    }), 'utf8')
    const statOwner = typeof process.getuid === 'function' ? process.getuid() : 0
    await chmod(manifestPath, 0o644)
    expect(loadDesktopRuntimeManifest(manifestPath, {
      platform: 'linux',
      expectedOwnerUid: statOwner,
    }).schemaVersion).toBe(1)
    await chmod(manifestPath, 0o666)
    expect(() => loadDesktopRuntimeManifest(manifestPath, {
      platform: 'linux',
      expectedOwnerUid: statOwner,
    })).toThrow('group/other')
  })
})

async function createTemporaryDirectory(): Promise<string> {
  // macOS 的 os.tmpdir() 以 /var 开头，而 /var 是 /private/var 的系统链接。
  // 清单边界有意拒绝任何链接父路径，测试夹具先规范化系统临时目录，避免
  // 把操作系统别名误当成待测清单自身的链接。
  const directory = await realpath(await mkdtemp(
    path.join(os.tmpdir(), 'geo-agent-platform-runtime-manifest-'),
  ))
  temporaryDirectories.push(directory)
  return directory
}

async function createRuntimeTargets(directory: string): Promise<{
  projectRoot: string
  runtimeRoot: string
  supervisorTokenFile: string
}> {
  const projectRoot = path.join(directory, 'project')
  const runtimeRoot = path.join(directory, 'runtime')
  const supervisorTokenFile = path.join(runtimeRoot, 'secrets', 'supervisor.token')
  await mkdir(projectRoot, { recursive: true })
  await mkdir(path.dirname(supervisorTokenFile), { recursive: true })
  await writeFile(supervisorTokenFile, 'test-supervisor-token\n', 'utf8')
  return { projectRoot, runtimeRoot, supervisorTokenFile }
}

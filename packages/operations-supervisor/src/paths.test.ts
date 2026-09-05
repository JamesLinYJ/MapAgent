// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运维监督运行时路径测试
//
//   文件:       paths.test.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assertProductionSecretPermissions,
  ensureSecretFile,
  resolveOperationsPaths,
  windowsAclProcessEnvironment,
} from './paths.js'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('operations IPC endpoint', () => {
  it('does not read or pass inherited credentials to Windows ACL helpers', () => {
    let reads = 0
    const source = {
      PATH: 'test-path',
      SystemRoot: 'C:\\Windows',
      GEO_AGENT_PLATFORM_OPERATORS_PRINCIPAL: 'MapAgents Operators',
    } as NodeJS.ProcessEnv
    for (const name of ['OPENAI_API_KEY', 'SIGNING_PASSWORD', 'CSC_LINK']) {
      Object.defineProperty(source, name, {
        enumerable: true,
        get: () => {
          reads += 1
          return 'must-not-be-read'
        },
      })
    }

    expect(windowsAclProcessEnvironment(source)).toEqual({
      PATH: 'test-path',
      SystemRoot: 'C:\\Windows',
      GEO_AGENT_PLATFORM_OPERATORS_PRINCIPAL: 'MapAgents Operators',
    })
    expect(reads).toBe(0)
  })

  it('always uses a short per-user endpoint instead of the data directory', async () => {
    if (process.platform === 'win32') return
    const directory = await mkdtemp('/tmp/geo-agent-platform-paths-')
    cleanupPaths.push(directory)
    const projectRoot = path.join(directory, '长路径'.repeat(24))
    await mkdir(projectRoot, { recursive: true })
    const paths = await resolveOperationsPaths({ projectRoot, profile: 'development' })

    expect(Buffer.byteLength(paths.endpoint, 'utf8')).toBeLessThanOrEqual(100)
    expect(paths.endpoint).not.toContain(projectRoot)
    expect(paths.endpoint).toContain(`/tmp/gap-${process.getuid?.() ?? 'user'}`)
    expect(paths.operationsRoot).toContain(projectRoot)
  })

  it('resolves the same endpoint when parent and supervised processes have different environments', async () => {
    if (process.platform === 'win32') return
    const directory = await mkdtemp('/tmp/geo-agent-platform-paths-')
    cleanupPaths.push(directory)
    const projectRoot = path.join(directory, 'workspace')
    await mkdir(projectRoot, { recursive: true })
    const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR
    process.env.XDG_RUNTIME_DIR = path.join(directory, '很长'.repeat(80))

    try {
      const parentPaths = await resolveOperationsPaths({ projectRoot, profile: 'production' })
      delete process.env.XDG_RUNTIME_DIR
      const supervisedPaths = await resolveOperationsPaths({ projectRoot, profile: 'production' })

      expect(parentPaths.endpoint).toBe(supervisedPaths.endpoint)
      expect(Buffer.byteLength(parentPaths.endpoint, 'utf8')).toBeLessThanOrEqual(100)
      expect(path.basename(parentPaths.endpoint)).toMatch(/^[a-f0-9]{24}\.sock$/u)
    } finally {
      if (previousRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory
    }
  })
})

describe('operations secret files', () => {
  it('can protect an existing development secret repeatedly without rotating it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-secret-'))
    cleanupPaths.push(directory)
    const filePath = path.join(directory, 'supervisor.token')

    const created = await ensureSecretFile(filePath, true)
    const reopened = await ensureSecretFile(filePath, true)

    expect(reopened).toBe(created)
    await expect(assertProductionSecretPermissions(filePath)).resolves.toBeUndefined()
  }, process.platform === 'win32' ? 15_000 : 5_000)
})

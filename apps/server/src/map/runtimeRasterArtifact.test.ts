// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行目录栅格 Artifact 解析测试
//
//   文件:       runtimeRasterArtifact.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RuntimeRasterArtifactResolver } from './runtimeRasterArtifact.js'

const cleanupDirectories: string[] = []

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('RuntimeRasterArtifactResolver', () => {
  it('resolves a regular GeoTIFF under RUNTIME_ROOT with a version fingerprint', async () => {
    const root = await temporaryDirectory()
    const artifact = path.join(root, 'artifacts', 'run_1', 'rain.tif')
    await fs.mkdir(path.dirname(artifact), { recursive: true })
    await fs.writeFile(artifact, new Uint8Array([1, 2, 3]))
    const resolver = new RuntimeRasterArtifactResolver(root)

    const resolved = await resolver.resolve('artifacts/run_1/rain.tif')

    expect(resolved.path).toBe(await fs.realpath(artifact))
    expect(resolved.fingerprint).toContain('\u00003\u0000')
  })

  it('rejects absolute paths, parent traversal, non-TIFF files and symlink escape', async () => {
    const parent = await temporaryDirectory()
    const root = path.join(parent, 'runtime')
    const outside = path.join(parent, 'outside')
    await fs.mkdir(root, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(path.join(root, 'not-raster.txt'), 'x')
    await fs.writeFile(path.join(outside, 'secret.tif'), 'x')
    const junction = path.join(root, 'escaped')
    await fs.symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir')
    const resolver = new RuntimeRasterArtifactResolver(root)

    await expect(resolver.resolve(path.resolve(root, 'not-raster.txt'))).rejects.toThrow('相对路径')
    await expect(resolver.resolve('../outside/secret.tif')).rejects.toThrow('相对路径')
    await expect(resolver.resolve('not-raster.txt')).rejects.toThrow('GeoTIFF')
    await expect(resolver.resolve('escaped/secret.tif')).rejects.toThrow('符号链接')
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-raster-path-'))
  cleanupDirectories.push(directory)
  return directory
}

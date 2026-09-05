// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久文件 IO 测试
//
//   文件:       durableFileIo.test.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'

const testTarget = path.join('runtime', 'atomic-write.json')

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

function installFsMock(renameMock: ReturnType<typeof vi.fn>) {
  const handle = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
  const rmMock = vi.fn().mockResolvedValue(undefined)
  vi.doMock('node:fs/promises', () => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue(handle),
    readFile: vi.fn(),
    readdir: vi.fn(),
    rename: renameMock,
    rm: rmMock,
  }))
  vi.doMock('node:timers/promises', () => ({
    setTimeout: vi.fn().mockResolvedValue(undefined),
  }))
  return { handle, rmMock }
}

describe('durableFileIo atomic writes', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock('node:fs/promises')
    vi.doUnmock('node:timers/promises')
  })

  it('retries transient Windows atomic replace locks', async () => {
    const renameMock = vi.fn()
      .mockRejectedValueOnce(errno('EPERM'))
      .mockResolvedValueOnce(undefined)
    const { handle, rmMock } = installFsMock(renameMock)
    const { atomicWriteText } = await import('./durableFileIo.js')

    await atomicWriteText(testTarget, '{}')

    expect(handle.writeFile).toHaveBeenCalledWith('{}', 'utf8')
    // temp inode 与原子 rename 后的父目录都必须进入 durability 边界。
    expect(handle.sync).toHaveBeenCalledTimes(2)
    expect(handle.close).toHaveBeenCalledTimes(2)
    expect(renameMock).toHaveBeenCalledTimes(2)
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('cleans temporary files when atomic replace cannot be retried', async () => {
    const renameMock = vi.fn().mockRejectedValueOnce(errno('ENOENT'))
    const { rmMock } = installFsMock(renameMock)
    const { atomicWriteText } = await import('./durableFileIo.js')

    await expect(atomicWriteText(testTarget, '{}')).rejects.toThrow('ENOENT')

    expect(renameMock).toHaveBeenCalledTimes(1)
    expect(rmMock).toHaveBeenCalledTimes(1)
  })

})

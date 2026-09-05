// +-------------------------------------------------------------------------
//
//   地理智能平台 - 统一开发启动器测试
//
//   文件:       devLauncher.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  devLauncherChildEnvironment,
  parseDevLauncherCommand,
  prerequisiteBuilds,
  resolveDevelopmentRuntimeRoot,
  rotateDetachedOutput,
  runDevLauncher,
  waitForSupervisorReady,
} from './devLauncher.js'

const cleanupDirectories: string[] = []

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('统一开发启动器', () => {
  it('does not read or pass inherited Provider and signing credentials to child processes', () => {
    let reads = 0
    const source = { PATH: 'test-path', API_PORT: '8000' } as NodeJS.ProcessEnv
    for (const name of ['OPENAI_API_KEY', 'RELEASE_TOKEN', 'CSC_LINK']) {
      Object.defineProperty(source, name, {
        enumerable: true,
        get: () => {
          reads += 1
          return 'must-not-be-read'
        },
      })
    }

    expect(devLauncherChildEnvironment(source)).toEqual({ PATH: 'test-path', API_PORT: '8000' })
    expect(reads).toBe(0)
  })

  it('为 Bash 与 PowerShell 使用同一位置参数和 GNU 长选项', () => {
    const command = [
      'agent', 'all', '--json', '--prompt', '你好', '--mode', 'plan', '--no-reasoning',
    ]

    expect(parseDevLauncherCommand(command)).toEqual({
      action: 'agent',
      service: 'all',
      json: true,
      check: false,
      keepInfra: false,
      follow: false,
      includeSupervisor: false,
      tail: 80,
      prompt: '你好',
      mode: 'plan',
      timeout: 600,
      reasoning: false,
      help: false,
    })
    expect(parseDevLauncherCommand(['restart', 'api']).service).toBe('api')
    expect(() => parseDevLauncherCommand(['restart', '-Service', 'api'])).toThrow()
  })

  it('只有一处声明共享构建顺序', () => {
    expect(prerequisiteBuilds().map(([, args]) => args.at(-1))).toEqual([
      '@geo-agent-platform/db',
      '@geo-agent-platform/shared-types',
      '@geo-agent-platform/conversation-presentation',
      '@geo-agent-platform/operations-supervisor',
    ])
  })

  it('相对运行目录始终以项目根为基准解析', () => {
    const projectRoot = process.platform === 'win32'
      ? 'C:\\workspace\\platform'
      : '/workspace/platform'

    expect(resolveDevelopmentRuntimeRoot(projectRoot, './runtime')).toBe(
      path.resolve(projectRoot, 'runtime'),
    )
    expect(resolveDevelopmentRuntimeRoot(projectRoot, '../shared-runtime')).toBe(
      path.resolve(projectRoot, '../shared-runtime'),
    )
  })

  it('监督器在重试窗口内就绪', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
    const delay = vi.fn().mockResolvedValue(undefined)

    await expect(waitForSupervisorReady(probe, delay, 3)).resolves.toBeUndefined()
    expect(delay).toHaveBeenCalledTimes(2)
  })

  it('启动前按实际 UTC 时间轮转非空捕获文件且不改写内容', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'operations-launch-log-'))
    cleanupDirectories.push(directory)
    const source = path.join(directory, 'supervisor-launch.stdout.log')
    await writeFile(source, '旧启动输出\n')

    const destination = await rotateDetachedOutput(
      source,
      new Date('2026-08-03T04:05:06.789Z'),
      42,
    )

    expect(path.basename(destination ?? '')).toBe(
      'supervisor-launch.stdout.2026-08-03T04-05-06-789Z.42.log',
    )
    await expect(readFile(destination ?? '', 'utf8')).resolves.toBe('旧启动输出\n')
  })

  it('监督器持续不可用时给出日志位置并失败', async () => {
    await expect(waitForSupervisorReady(
      vi.fn().mockResolvedValue(1),
      vi.fn().mockResolvedValue(undefined),
      2,
    )).rejects.toThrow(/runtime\/ops\/supervisor-launch/u)
  })

  it('Desktop 一键启动先重载应用服务再打开界面', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const projectRoot = path.resolve('test-platform-root')
    const nodeExecutable = process.execPath

    const result = await runDevLauncher(
      parseDevLauncherCommand(['desktop']),
      {
        projectRoot,
        nodeExecutable,
        dependencies: {
          run: vi.fn(async (command: string, args: readonly string[]) => {
            calls.push({ command, args })
            return 0
          }),
          delay: vi.fn().mockResolvedValue(undefined),
        },
      },
    )

    const restartWorkerIndex = calls.findIndex(call =>
      call.command === nodeExecutable
      && call.args.includes('restart')
      && call.args.includes('worker'))
    const startApiIndex = calls.findIndex(call =>
      call.command === nodeExecutable
      && call.args.includes('start')
      && call.args.includes('api'))
    const desktopIndex = calls.findIndex(call =>
      call.command === 'npm'
      && call.args.join(' ') === 'run dev --workspace @geo-agent-platform/desktop')

    expect(result).toBe(0)
    expect(restartWorkerIndex).toBeGreaterThanOrEqual(0)
    expect(startApiIndex).toBeGreaterThan(restartWorkerIndex)
    expect(desktopIndex).toBeGreaterThan(startApiIndex)
  })

  it('默认入口以幂等启动连接已有服务，不制造隐式重启', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const result = await runDevLauncher(
      parseDevLauncherCommand([]),
      {
        projectRoot: path.resolve('test-platform-root'),
        nodeExecutable: process.execPath,
        dependencies: {
          run: vi.fn(async (command: string, args: readonly string[]) => {
            calls.push({ command, args })
            return 0
          }),
          delay: vi.fn().mockResolvedValue(undefined),
        },
      },
    )

    const startAllIndex = calls.findIndex(call =>
      call.command === process.execPath && call.args.includes('start') && call.args.includes('all'))
    const consoleIndex = calls.findIndex(call =>
      call.command === 'npm' && call.args.join(' ') === 'run console --workspace @geo-agent-platform/operations-console')

    expect(result).toBe(0)
    expect(calls.some(call => call.args.includes('restart'))).toBe(false)
    expect(startAllIndex).toBeGreaterThanOrEqual(0)
    expect(consoleIndex).toBeGreaterThan(startAllIndex)
  })

  it('Agent 入口只确保 API 已启动，不在每次提问前制造冷启动', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const result = await runDevLauncher(
      parseDevLauncherCommand(['agent']),
      {
        projectRoot: path.resolve('test-platform-root'),
        nodeExecutable: process.execPath,
        dependencies: {
          run: vi.fn(async (command: string, args: readonly string[]) => {
            calls.push({ command, args })
            return 0
          }),
          delay: vi.fn().mockResolvedValue(undefined),
        },
      },
    )

    const startApiIndex = calls.findIndex(call =>
      call.command === process.execPath && call.args.includes('start') && call.args.includes('api'))
    const agentIndex = calls.findIndex(call =>
      call.command === 'npm' && call.args.join(' ').startsWith('run agent --workspace @geo-agent-platform/operations-console'))

    expect(result).toBe(0)
    expect(calls.some(call => call.args.includes('restart'))).toBe(false)
    expect(startApiIndex).toBeGreaterThanOrEqual(0)
    expect(agentIndex).toBeGreaterThan(startApiIndex)
  })
})

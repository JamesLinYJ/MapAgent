// +-------------------------------------------------------------------------
//
//   地理智能平台 - Windows Squirrel 安装生命周期
//
//   文件:       squirrelLifecycle.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { spawn } from 'node:child_process'
import path from 'node:path'

type SquirrelUpdateRunner = (
  updateExecutable: string,
  arguments_: readonly string[],
  onComplete: () => void,
) => void

export interface SquirrelLifecycleContext {
  platform: NodeJS.Platform
  arguments: readonly string[]
  executablePath: string
  quit: () => void
  runUpdate?: SquirrelUpdateRunner
}

type SquirrelLifecycleAction =
  | { kind: 'update'; verb: '--createShortcut' | '--removeShortcut' }
  | { kind: 'quit' }

/**
 * Squirrel 事件必须在单实例锁和窗口创建之前处理。安装、升级与卸载只调用
 * 同级 Update.exe 管理当前可执行文件的快捷方式，随后立即退出桌面进程。
 */
export function handleSquirrelLifecycle(context: SquirrelLifecycleContext): boolean {
  if (context.platform !== 'win32') return false
  const action = squirrelLifecycleAction(context.arguments[1])
  if (!action) return false
  if (action.kind === 'quit') {
    context.quit()
    return true
  }

  const updateExecutable = path.win32.resolve(
    path.win32.dirname(context.executablePath),
    '..',
    'Update.exe',
  )
  const executableName = path.win32.basename(context.executablePath)
  const runUpdate = context.runUpdate ?? runSquirrelUpdate
  runUpdate(updateExecutable, [action.verb, executableName], context.quit)
  return true
}

function squirrelLifecycleAction(argument: string | undefined): SquirrelLifecycleAction | null {
  switch (argument) {
    case '--squirrel-install':
    case '--squirrel-updated':
      return { kind: 'update', verb: '--createShortcut' }
    case '--squirrel-uninstall':
      return { kind: 'update', verb: '--removeShortcut' }
    case '--squirrel-obsolete':
      return { kind: 'quit' }
    default:
      return null
  }
}

function runSquirrelUpdate(
  updateExecutable: string,
  arguments_: readonly string[],
  onComplete: () => void,
): void {
  const child = spawn(updateExecutable, [...arguments_], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  let completed = false
  const completeOnce = (): void => {
    if (completed) return
    completed = true
    onComplete()
  }
  child.once('error', completeOnce)
  child.once('close', completeOnce)
  child.unref()
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - macOS 安装版命令行链接服务
//
//   文件:       macosInstalledCliService.ts
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, readlink } from 'node:fs/promises'
import path from 'node:path'

import {
  DESKTOP_MACOS_CLI_COMMAND_PATH,
  type DesktopMacosCliAction,
  type DesktopMacosCliStatus,
} from '../contracts/desktopIpc.js'

const MACOS_INSTALLED_CLI_RESOURCE_DIRECTORY = 'io.geoagentplatform.desktop-cli'
const MACOS_INSTALLED_CLI_LAUNCHER_FILENAME = 'geo-agent-platform'

const OWNED_LAUNCHER_SUFFIX = path.join(
  'Contents',
  'Resources',
  MACOS_INSTALLED_CLI_RESOURCE_DIRECTORY,
  MACOS_INSTALLED_CLI_LAUNCHER_FILENAME,
)
const PRIVILEGED_OPERATION_TIMEOUT_MS = 120_000

/**
 * 提权 shell 程序固定在受 ASAR 完整性校验保护的 Main 代码中。动态 action 和
 * launcher 只作为位置参数传入，root 不再解释应用包内可被换写的外部脚本。
 */
export const MACOS_INSTALLED_CLI_PRIVILEGED_PROGRAM = [
  'set -eu',
  'umask 022',
  "command_path='/usr/local/bin/geo-agent-platform'",
  "owned_suffix='/Contents/Resources/io.geoagentplatform.desktop-cli/geo-agent-platform'",
  'action=$1',
  'launcher_path=$2',
  'case "$action" in install|repair|remove) ;; *) exit 64 ;; esac',
  'case "$launcher_path" in /*"$owned_suffix") ;; *) exit 64 ;; esac',
  'if [ -L "$launcher_path" ] || [ ! -f "$launcher_path" ] || [ ! -x "$launcher_path" ]; then exit 65; fi',
  'read_owned_target() { [ -L "$command_path" ] || return 1; current_target=$(/usr/bin/readlink "$command_path") || return 1; case "$current_target" in /*"$owned_suffix") return 0 ;; *) return 1 ;; esac; }',
  'case "$action" in install) if [ -e "$command_path" ] || [ -L "$command_path" ]; then if [ -L "$command_path" ] && [ "$(/usr/bin/readlink "$command_path")" = "$launcher_path" ]; then exit 0; fi; exit 73; fi; /bin/mkdir -p /usr/local/bin; /bin/ln -s "$launcher_path" "$command_path" ;; repair) if ! read_owned_target; then exit 73; fi; if [ "$current_target" = "$launcher_path" ]; then exit 0; fi; if [ -e "$current_target" ] || [ -L "$current_target" ]; then exit 73; fi; /bin/rm "$command_path"; /bin/ln -s "$launcher_path" "$command_path" ;; remove) if [ ! -e "$command_path" ] && [ ! -L "$command_path" ]; then exit 0; fi; if ! read_owned_target || [ "$current_target" != "$launcher_path" ]; then exit 73; fi; /bin/rm "$command_path" ;; esac',
].join('; ')

type LinkEntry =
  | { kind: 'missing' }
  | { kind: 'symlink'; target: string }
  | { kind: 'other' }

export interface MacosInstalledCliServiceOptions {
  platform: NodeJS.Platform
  isPackaged: boolean
  resourcesPath: string
}

export interface MacosInstalledCliServiceDependencies {
  isExecutable?: (filePath: string) => Promise<boolean>
  pathExists?: (filePath: string) => Promise<boolean>
  inspectLink?: (filePath: string) => Promise<LinkEntry>
  runPrivilegedOperation?: (request: {
    action: DesktopMacosCliAction
    launcherPath: string
  }) => Promise<void>
}

/**
 * 只管理固定的 /usr/local/bin 链接。提升权限前后都会重新检查目标；普通文件、
 * 相对链接和其它应用的链接永远不会被覆盖或移除。
 */
export class MacosInstalledCliService {
  readonly #platform: NodeJS.Platform
  readonly #isPackaged: boolean
  readonly #launcherPath: string
  readonly #isExecutable: (filePath: string) => Promise<boolean>
  readonly #pathExists: (filePath: string) => Promise<boolean>
  readonly #inspectLink: (filePath: string) => Promise<LinkEntry>
  readonly #runPrivilegedOperation: NonNullable<
    MacosInstalledCliServiceDependencies['runPrivilegedOperation']
  >

  constructor(
    options: MacosInstalledCliServiceOptions,
    dependencies: MacosInstalledCliServiceDependencies = {},
  ) {
    this.#platform = options.platform
    this.#isPackaged = options.isPackaged
    this.#launcherPath = path.join(
      options.resourcesPath,
      MACOS_INSTALLED_CLI_RESOURCE_DIRECTORY,
      MACOS_INSTALLED_CLI_LAUNCHER_FILENAME,
    )
    this.#isExecutable = dependencies.isExecutable ?? isExecutable
    this.#pathExists = dependencies.pathExists ?? pathExists
    this.#inspectLink = dependencies.inspectLink ?? inspectLink
    this.#runPrivilegedOperation = dependencies.runPrivilegedOperation ?? runPrivilegedOperation
  }

  async status(): Promise<DesktopMacosCliStatus> {
    if (this.#platform !== 'darwin' || !this.#isPackaged) {
      return status('unavailable', '终端命令仅由 macOS 正式安装包提供。')
    }
    if (!isSafeBundleResourcePath(this.#launcherPath, OWNED_LAUNCHER_SUFFIX)) {
      return status('unavailable', '当前应用路径不适合安装终端命令。')
    }
    if (!await this.#isExecutable(this.#launcherPath)) {
      return status('unavailable', '当前安装包未包含完整的终端命令组件。')
    }

    const entry = await this.#inspectLink(DESKTOP_MACOS_CLI_COMMAND_PATH)
    if (entry.kind === 'missing') {
      return status('not_installed', '尚未安装终端命令。')
    }
    if (entry.kind !== 'symlink' || !path.isAbsolute(entry.target)) {
      return status('conflict', '固定命令路径已被其他文件占用，应用不会覆盖或删除它。')
    }
    if (entry.target === this.#launcherPath) {
      return status('installed', '终端命令已安装，可以在任意目录使用。')
    }
    if (isOwnedLauncherTarget(entry.target)) {
      if (!await this.#pathExists(entry.target)) {
        return status('needs_repair', '应用位置已经变化，需要修复终端命令链接。')
      }
      return status('conflict', '固定命令路径指向另一个仍然存在的应用，当前应用不会修改它。')
    }
    return status('conflict', '固定命令路径已被其他命令占用，应用不会覆盖或删除它。')
  }

  async perform(action: DesktopMacosCliAction): Promise<DesktopMacosCliStatus> {
    const before = await this.status()
    const noOperationState = expectedNoOperationState(action)
    if (before.state === noOperationState) return before
    if (!canPerform(before, action)) {
      throw new Error(actionUnavailableMessage(before, action))
    }

    try {
      await this.#runPrivilegedOperation({
        action,
        launcherPath: this.#launcherPath,
      })
    } catch (error) {
      const afterFailure = await this.status()
      const expectedState = action === 'remove' ? 'not_installed' : 'installed'
      if (afterFailure.state === expectedState) return afterFailure
      if (afterFailure.state === 'conflict') throw new Error(afterFailure.message)
      throw error
    }

    const after = await this.status()
    const expectedState = action === 'remove' ? 'not_installed' : 'installed'
    if (after.state !== expectedState) {
      throw new Error('系统授权完成后命令状态未达到预期，请重新检查。')
    }
    return after
  }
}

function status(
  state: DesktopMacosCliStatus['state'],
  message: string,
): DesktopMacosCliStatus {
  return {
    state,
    commandPath: DESKTOP_MACOS_CLI_COMMAND_PATH,
    message,
    canInstall: state === 'not_installed',
    canRepair: state === 'needs_repair',
    canRemove: state === 'installed',
  }
}

function expectedNoOperationState(
  action: DesktopMacosCliAction,
): DesktopMacosCliStatus['state'] {
  return action === 'remove' ? 'not_installed' : 'installed'
}

function canPerform(
  current: DesktopMacosCliStatus,
  action: DesktopMacosCliAction,
): boolean {
  if (action === 'install') return current.canInstall
  if (action === 'repair') return current.canRepair
  return current.canRemove
}

function actionUnavailableMessage(
  current: DesktopMacosCliStatus,
  action: DesktopMacosCliAction,
): string {
  if (current.state === 'unavailable' || current.state === 'conflict') return current.message
  if (action === 'install') return '当前状态不需要安装终端命令。'
  if (action === 'repair') return '当前状态不需要修复终端命令。'
  return '当前状态没有可移除的本应用终端命令。'
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    const file = await lstat(filePath)
    if (!file.isFile() || file.isSymbolicLink()) return false
    await access(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function inspectLink(filePath: string): Promise<LinkEntry> {
  try {
    const file = await lstat(filePath)
    if (!file.isSymbolicLink()) return { kind: 'other' }
    return { kind: 'symlink', target: await readlink(filePath) }
  } catch (error) {
    if (isMissingFileError(error)) return { kind: 'missing' }
    throw new Error('无法检查终端命令状态。')
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if (isMissingFileError(error)) return false
    // 无法读取不等于不存在；按仍然存在处理，确保不会取得修改资格。
    return true
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isOwnedLauncherTarget(target: string): boolean {
  return path.isAbsolute(target)
    && isSafeBundleResourcePath(target, OWNED_LAUNCHER_SUFFIX)
}

function isSafeBundleResourcePath(candidate: string, suffix: string): boolean {
  return path.isAbsolute(candidate)
    && !/[\0\r\n]/u.test(candidate)
    && path.normalize(candidate).endsWith(path.sep + suffix)
}

function runPrivilegedOperation(request: {
  action: DesktopMacosCliAction
  launcherPath: string
}): Promise<void> {
  if (!isSafeBundleResourcePath(request.launcherPath, OWNED_LAUNCHER_SUFFIX)) {
    throw new Error('终端命令组件路径无效。')
  }
  const shellCommand = [
    '/bin/sh',
    '-c',
    MACOS_INSTALLED_CLI_PRIVILEGED_PROGRAM,
    'geo-agent-platform-link',
    request.action,
    request.launcherPath,
  ].map(shellQuote).join(' ')
  const appleScript = `do shell script "${escapeAppleScriptString(shellCommand)}" with administrator privileges`

  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', appleScript], {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      maxBuffer: 64 * 1024,
      timeout: PRIVILEGED_OPERATION_TIMEOUT_MS,
    }, (error, _stdout, stderr) => {
      if (!error) {
        resolve()
        return
      }
      const diagnostic = `${error.message}\n${stderr}`
      if (/\(-128\)|user canceled|user cancelled/iu.test(diagnostic)) {
        reject(new Error('已取消系统授权，终端命令没有更改。'))
        return
      }
      if ((error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
        reject(new Error('系统授权等待超时，终端命令没有更改。'))
        return
      }
      reject(new Error('系统未能完成终端命令授权操作。'))
    })
  })
}

function shellQuote(value: string): string {
  if (!isSafeCommandArgument(value)) throw new Error('终端命令组件路径无效。')
  return `'${value.replaceAll("'", "'\\''")}'`
}

function isSafeCommandArgument(value: string): boolean {
  return value.length > 0 && !/[\0\r\n]/u.test(value)
}

function escapeAppleScriptString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

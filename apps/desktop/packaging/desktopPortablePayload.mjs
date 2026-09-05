// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 便携客户端载荷边界
//
//   维护记录 (2026-09-03):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 显式区分远程客户端与本机托管载荷，避免 macOS arm64
//           本机包被错误要求携带远程服务标记。
//
// --------------------------------------------------------------------------

import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REMOTE_CLIENT_MARKER_FILENAME = 'REMOTE-SERVICE-CLIENT.txt'
export const REMOTE_CLIENT_PAYLOAD_MODE = 'remote-client'
export const MANAGED_LOCAL_PAYLOAD_MODE = 'managed-local'
const remoteClientMarkerSource = fileURLToPath(new URL(
  `./${REMOTE_CLIENT_MARKER_FILENAME}`,
  import.meta.url,
))

/** 解析便携桌面产物的部署模式；目前只有 macOS arm64 携带受支持的本机托管运行服务。 */
export function createDesktopPayloadContract(targetPlatform, targetArchitecture) {
  const platform = requiredPlatform(targetPlatform)
  const architecture = requiredText(targetArchitecture, 'target architecture')
  return Object.freeze({
    architecture,
    mode: platform === 'darwin' && architecture === 'arm64'
      ? MANAGED_LOCAL_PAYLOAD_MODE
      : REMOTE_CLIENT_PAYLOAD_MODE,
    platform,
  })
}

/**
 * 暂存便携载荷时不修改 Electron Forge 原始输出。Linux Forge 输出可能包含
 * 供系统包使用的运行服务，远程格式需先移除它并写入标准说明标记。
 */
export async function stageDesktopPayloadDirectory(
  sourceDirectory,
  destinationDirectory,
  payloadContract,
) {
  const contract = normalizePayloadContract(payloadContract)
  const source = path.resolve(requiredText(sourceDirectory, 'source directory'))
  const destination = path.resolve(requiredText(destinationDirectory, 'destination directory'))
  const sourceMetadata = await lstat(source).catch(() => null)
  if (!sourceMetadata?.isDirectory()) throw new Error(`便携客户端源目录不存在：${source}`)
  assertDistinctTrees(source, destination)

  await rm(destination, { recursive: true, force: true })
  await mkdir(path.dirname(destination), { recursive: true })
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  })
  if (contract.mode === REMOTE_CLIENT_PAYLOAD_MODE && contract.platform === 'linux') {
    await removeManagedRuntime(destination, contract.platform)
    await writeFile(
      expectedMarkerPath(destination, contract.platform),
      await canonicalRemoteClientMarker(),
      'utf8',
    )
  }
  await assertDesktopPayload(destination, contract)
  return destination
}

/** 校验指定部署模式下说明标记与运行服务的严格对应关系。 */
export async function assertDesktopPayload(directory, payloadContract) {
  const contract = normalizePayloadContract(payloadContract)
  const root = path.resolve(requiredText(directory, 'desktop payload directory'))
  const markers = await findFiles(root, REMOTE_CLIENT_MARKER_FILENAME)
  const runtimePath = managedRuntimePath(root, contract.platform)
  const runtime = await lstat(runtimePath).catch(() => null)

  if (contract.mode === MANAGED_LOCAL_PAYLOAD_MODE) {
    if (markers.length !== 0) {
      throw new Error('本机托管载荷不得包含远程服务说明标记。')
    }
    if (!runtime?.isDirectory()) {
      throw new Error('本机托管载荷缺少 Runtime Service。')
    }
    return
  }

  if (markers.length !== 1) {
    throw new Error(`远程客户端载荷必须且只能包含一个服务说明标记，实际为 ${markers.length} 个。`)
  }
  const expectedMarker = expectedMarkerPath(root, contract.platform)
  if (path.resolve(markers[0]) !== path.resolve(expectedMarker)) {
    throw new Error('远程客户端服务说明标记位置与平台契约不一致。')
  }
  const markerContent = await readFile(markers[0], 'utf8')
  const canonicalMarker = await canonicalRemoteClientMarker()
  if (normalizeText(markerContent) !== normalizeText(canonicalMarker)) {
    throw new Error('远程客户端服务说明标记内容与发布契约不一致。')
  }
  if (runtime) {
    throw new Error('远程客户端载荷仍包含本机托管 Runtime Service，拒绝打包。')
  }
}

async function canonicalRemoteClientMarker() {
  return readFile(remoteClientMarkerSource, 'utf8')
}

async function removeManagedRuntime(root, platform) {
  await rm(managedRuntimePath(root, platform), { recursive: true, force: true })
}

function managedRuntimePath(root, platform) {
  return platform === 'darwin'
    ? path.join(root, 'Contents', 'Resources', 'runtime-service')
    : path.join(root, 'resources', 'runtime-service')
}

function expectedMarkerPath(root, platform) {
  if (platform === 'darwin') {
    return path.join(root, 'Contents', 'Resources', REMOTE_CLIENT_MARKER_FILENAME)
  }
  if (platform === 'win32') {
    return path.join(root, 'resources', REMOTE_CLIENT_MARKER_FILENAME)
  }
  return path.join(root, REMOTE_CLIENT_MARKER_FILENAME)
}

async function findFiles(root, fileName) {
  const matches = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) matches.push(...await findFiles(fullPath, fileName))
    else if (entry.isFile() && entry.name === fileName) matches.push(fullPath)
  }
  return matches
}

function normalizeText(value) {
  return value.replaceAll('\r\n', '\n')
}

function assertDistinctTrees(source, destination) {
  const sourceRelativeToDestination = path.relative(destination, source)
  const destinationRelativeToSource = path.relative(source, destination)
  if (isInside(sourceRelativeToDestination) || isInside(destinationRelativeToSource)) {
    throw new Error('便携客户端暂存目录不得与源目录相互包含。')
  }
}

function isInside(relativePath) {
  return relativePath === ''
    || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))
}

function requiredPlatform(value) {
  const platform = requiredText(value, 'target platform')
  if (!['win32', 'darwin', 'linux'].includes(platform)) {
    throw new Error(`不支持的便携客户端平台：${platform}`)
  }
  return platform
}

function normalizePayloadContract(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('Desktop 载荷缺少部署模式契约。')
  }
  const platform = requiredPlatform(value.platform)
  const architecture = requiredText(value.architecture, 'target architecture')
  const mode = requiredText(value.mode, 'payload mode')
  if (![REMOTE_CLIENT_PAYLOAD_MODE, MANAGED_LOCAL_PAYLOAD_MODE].includes(mode)) {
    throw new Error(`不支持的 Desktop 载荷模式：${mode}`)
  }
  if (mode === MANAGED_LOCAL_PAYLOAD_MODE && (platform !== 'darwin' || architecture !== 'arm64')) {
    throw new Error('本机托管便携载荷当前只支持 macOS arm64。')
  }
  return { architecture, mode, platform }
}

function requiredText(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`便携客户端载荷缺少 ${label}。`)
  return normalized
}

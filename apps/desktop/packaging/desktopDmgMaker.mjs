// +-------------------------------------------------------------------------
//
//   地理智能平台 - macOS DMG Maker
//
// --------------------------------------------------------------------------

import { MakerBase } from '@electron-forge/maker-base'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  assertNonemptyPackageArtifact,
  resolveMacApplication,
} from './desktopPackageOutput.mjs'
import {
  assertDesktopPayload,
  createDesktopPayloadContract,
} from './desktopPortablePayload.mjs'

export class DesktopDmgMaker extends MakerBase {
  name = 'desktop-dmg'
  defaultPlatforms = ['darwin']
  requiredExternalBinaries = ['hdiutil']

  isSupportedOnCurrentPlatform() {
    return process.platform === 'darwin'
  }

  async make({ dir, makeDir, packageJSON, targetArch }) {
    if (process.platform !== 'darwin') {
      throw new Error('DesktopDmgMaker 只能在 macOS 构建主机上运行。')
    }
    const version = requiredText(packageJSON.version, 'package version')
    const arch = requiredText(targetArch, 'target architecture')
    const payloadContract = createDesktopPayloadContract('darwin', arch)
    const options = this.config.options ?? {}
    const artifactBaseName = requiredText(options.artifactBaseName, 'artifactBaseName')
    const volumeName = requiredText(options.volumeName, 'volumeName')
    const appPath = await resolveMacApplication(dir)
    const outputDirectory = path.join(makeDir, 'dmg', 'darwin', arch)
    const destinationPath = path.join(
      outputDirectory,
      `${artifactBaseName}-${version}-darwin-${arch}.dmg`,
    )
    const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-dmg-'))
    try {
      await mkdir(outputDirectory, { recursive: true })
      await rm(destinationPath, { force: true })
      const stagedApp = path.join(stagingRoot, path.basename(appPath))
      runRequired('ditto', [appPath, stagedApp])
      await assertDesktopPayload(stagedApp, payloadContract)
      await symlink('/Applications', path.join(stagingRoot, 'Applications'))
      runRequired('hdiutil', [
        'create',
        '-ov',
        '-format',
        'UDZO',
        '-volname',
        volumeName,
        '-srcfolder',
        stagingRoot,
        destinationPath,
      ])
      runRequired('hdiutil', ['verify', destinationPath])
      await assertNonemptyPackageArtifact(destinationPath, 'hdiutil DMG')
      return [destinationPath]
    } finally {
      await rm(stagingRoot, { recursive: true, force: true })
    }
  }
}

function runRequired(file, args) {
  const result = spawnSync(file, args, { stdio: 'inherit' })
  if (result.error || result.status !== 0) {
    throw new Error(`DMG 构建命令失败：${file} ${args.join(' ')}`)
  }
}

function requiredText(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`DesktopDmgMaker 缺少 ${label}。`)
  return normalized
}

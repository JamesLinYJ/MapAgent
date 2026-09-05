// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 测试构建标记策略
//
//   文件:       desktopTestBuildPolicy.mjs
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'
import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveMacApplication } from './desktopPackageOutput.mjs'
import { signAdhocMacApplication } from './desktopSigningPolicy.mjs'

const TEST_ARTIFACT_EXTENSION = /\.(AppImage|dmg|zip)$/iu

/** 给本机和 CI 验证包写入明确可见的测试标记。 */
export async function markTestPackageOutput(outputPath, platform) {
  const marker = [
    `${PRODUCT_CODENAME} UNSIGNED TEST BUILD`,
    'This package is for CI/local verification only and must not be distributed as a production release.',
    '',
  ].join(platform === 'win32' ? '\r\n' : '\n')
  if (platform !== 'darwin') {
    await writeFile(path.join(outputPath, 'UNSIGNED-TEST-BUILD.txt'), marker, 'utf8')
    return
  }

  const applicationPath = await resolveMacApplication(outputPath)
  await writeFile(
    path.join(applicationPath, 'Contents', 'Resources', 'UNSIGNED-TEST-BUILD.txt'),
    marker,
    'utf8',
  )
  // Forge 会改写主应用和辅助进程的 Info.plist；标记也是受保护资源，
  // 因此必须在写入完成后统一重新封装测试包。
  signAdhocMacApplication(applicationPath)
}

/** 只重命名可分发测试产物，不改动 Maker 返回的其他文件。 */
export async function markTestMakeArtifacts(makeResults) {
  return Promise.all(makeResults.map(async result => ({
    ...result,
    artifacts: await Promise.all(result.artifacts.map(async artifact => {
      if (!TEST_ARTIFACT_EXTENSION.test(artifact)) return artifact
      const markedArtifact = artifact.replace(
        TEST_ARTIFACT_EXTENSION,
        '-UNSIGNED-TEST.$1',
      )
      await rename(artifact, markedArtifact)
      return markedArtifact
    })),
  })))
}

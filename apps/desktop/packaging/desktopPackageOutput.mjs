// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 打包产物契约
//
//   文件:       desktopPackageOutput.mjs
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'

/** Forge Maker、测试标记和签名验证共用的 macOS 单应用结构契约。 */
export async function resolveMacApplication(outputPath, label = 'macOS 打包输出') {
  const candidate = path.resolve(requiredText(outputPath, label))
  const metadata = await lstat(candidate).catch(() => null)
  if (!metadata?.isDirectory()) throw new Error(`${label}不是存在的目录。`)
  if (candidate.toLowerCase().endsWith('.app')) return candidate

  const applications = (await readdir(candidate, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.toLowerCase().endsWith('.app'))
    .map(entry => path.join(candidate, entry.name))
  if (applications.length !== 1) {
    throw new Error(`${label}必须且只能包含一个 .app，实际为 ${applications.length} 个。`)
  }
  return applications[0]
}

/** 确认 Maker 生成了存在且非空的普通文件。 */
export async function assertNonemptyPackageArtifact(filePath, label) {
  const artifact = path.resolve(requiredText(filePath, '产物路径'))
  const metadata = await lstat(artifact).catch(() => null)
  if (!metadata?.isFile() || metadata.size <= 0) {
    throw new Error(`${requiredText(label, '产物名称')}未生成有效文件。`)
  }
  return artifact
}

function requiredText(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`Desktop 打包产物缺少${label}。`)
  return normalized
}

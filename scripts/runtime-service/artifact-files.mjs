// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runtime Service 制品文件边界
//
//   文件:       artifact-files.mjs
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import {
  RUNTIME_OUTPUT_MARKER,
  RUNTIME_SERVICE_KIND,
  shouldIncludeRuntimeArtifactPath,
} from './artifact-contract.mjs'

/**
 * 只有本脚本创建的专用目录才能被 `--force` 覆盖。仓库根、
 * 仓库祖先和符号链接均是不可删除边界。
 */
export async function prepareArtifactOutput(repositoryRoot, outputPath, force) {
  const root = path.resolve(repositoryRoot)
  const output = path.resolve(outputPath)
  assertOutputDoesNotContainRepository(root, output)

  const metadata = await optionalLstat(output)
  if (metadata) {
    if (metadata.isSymbolicLink()) {
      throw new Error(`Runtime Service 输出目录不得是符号链接：${output}`)
    }
    const [realRoot, realOutput] = await Promise.all([realpath(root), realpath(output)])
    assertOutputDoesNotContainRepository(realRoot, realOutput)
    if (!force) {
      throw new Error(`输出目录已存在：${output}；需要显式 --force 才能覆盖。`)
    }
    if (!(await isOwnedArtifactDirectory(output))) {
      throw new Error(
        `拒绝覆盖非 Runtime Service 专用目录：${output}。`
        + `请改用不存在的新目录，或确认目录内有 ${RUNTIME_OUTPUT_MARKER}。`,
      )
    }
    await rm(output, { recursive: true, force: true })
  }

  await mkdir(output, { recursive: true })
  await writeFile(
    path.join(output, RUNTIME_OUTPUT_MARKER),
    `${JSON.stringify({ schemaVersion: 1, kind: RUNTIME_SERVICE_KIND }, null, 2)}\n`,
    'utf8',
  )
}

/**
 * Postgres.app 的符号链接以挂载目录为绝对根。复制目录后必须把这些链接
 * 改写到制品内部，否则卸载 DMG 后运行时会依赖已经消失的构建机路径。
 */
export async function rebaseCopiedAbsoluteSymlinks(sourceRoot, destinationRoot) {
  const source = path.resolve(sourceRoot)
  const destination = path.resolve(destinationRoot)
  let rewrittenCount = 0

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(candidate)
        continue
      }
      if (!entry.isSymbolicLink()) continue

      const target = await readlink(candidate)
      if (!path.isAbsolute(target)) continue
      const sourceRelativeTarget = path.relative(source, path.resolve(target))
      if (sourceRelativeTarget === '..'
        || sourceRelativeTarget.startsWith(`..${path.sep}`)
        || path.isAbsolute(sourceRelativeTarget)) {
        throw new Error(`复制的运行时符号链接越过来源目录：${candidate} -> ${target}`)
      }

      const destinationTarget = path.join(destination, sourceRelativeTarget)
      if (!await optionalLstat(destinationTarget)) {
        throw new Error(`复制的运行时符号链接目标不存在：${candidate} -> ${target}`)
      }
      const relativeTarget = path.relative(path.dirname(candidate), destinationTarget) || '.'
      await unlink(candidate)
      await symlink(relativeTarget, candidate)
      rewrittenCount += 1
    }
  }

  await visit(destination)
  return rewrittenCount
}

/** 收集清单条目，同时拒绝越过制品根目录的符号链接。 */
export async function listArtifactEntries(artifactRoot, directory = artifactRoot) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await readlink(fullPath)
      const relativePath = path.relative(artifactRoot, fullPath)
      if (path.isAbsolute(target)) {
        throw new Error(`Runtime Service 制品符号链接不得使用绝对目标：${relativePath}`)
      }
      const resolvedTarget = path.resolve(path.dirname(fullPath), target)
      const relativeTarget = path.relative(artifactRoot, resolvedTarget)
      if (relativeTarget === '..'
        || relativeTarget.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativeTarget)) {
        throw new Error(`Runtime Service 制品符号链接越界：${relativePath}`)
      }
      await stat(resolvedTarget)
      result.push({ path: fullPath, kind: 'symlink', target: target.replaceAll(path.sep, '/') })
      continue
    }
    if (entry.isDirectory()) result.push(...await listArtifactEntries(artifactRoot, fullPath))
    else if (entry.isFile()) result.push({ path: fullPath, kind: 'file' })
    else {
      throw new Error(
        `Runtime Service 制品输入包含不支持的文件类型：${path.relative(artifactRoot, fullPath)}`,
      )
    }
  }
  return result
}

export async function listArtifactPaths(root, directory = root) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    const relativePath = path.relative(root, fullPath).replaceAll(path.sep, '/')
    if (entry.isSymbolicLink()) {
      files.push(relativePath)
      continue
    }
    if (entry.isDirectory()) files.push(...await listArtifactPaths(root, fullPath))
    else if (entry.isFile()) files.push(relativePath)
    else throw new Error(`Runtime Service 制品包含不支持的文件类型：${relativePath}`)
  }
  return files
}

/** 删除已确认的一方构建残留和目标平台不需要的文件，并清理空目录。 */
export async function pruneExcludedArtifactFiles(artifactRoot, target) {
  const root = path.resolve(artifactRoot)
  let removedFiles = 0
  let removedDirectories = 0

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      const relativePath = path.relative(root, candidate).replaceAll(path.sep, '/')
      if (entry.isDirectory()) {
        if (!shouldIncludeRuntimeArtifactPath(relativePath, target)) {
          await rm(candidate, { recursive: true, force: true })
          removedDirectories += 1
          continue
        }
        await visit(candidate)
        if ((await readdir(candidate)).length === 0) {
          await rmdir(candidate)
          removedDirectories += 1
        }
        continue
      }
      if (shouldIncludeRuntimeArtifactPath(relativePath, target)) continue
      await rm(candidate, { force: true })
      removedFiles += 1
    }
  }

  await visit(root)
  return { removedFiles, removedDirectories }
}

export function resolveArtifactPath(root, relativePath) {
  if (typeof relativePath !== 'string'
    || !relativePath
    || relativePath.includes('\\')
    || path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || path.posix.normalize(relativePath).startsWith('../')) {
    throw new Error(`Runtime Service manifest 包含非法路径：${String(relativePath)}`)
  }
  const resolved = path.resolve(root, ...relativePath.split('/'))
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Runtime Service manifest 路径越界：${relativePath}`)
  }
  return resolved
}

export async function assertCanonicalArtifactPath(canonicalRoot, candidate, relativePath) {
  const canonical = await realpath(candidate)
  const relative = path.relative(canonicalRoot, canonical)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Runtime Service manifest 路径通过链接越界：${relativePath}`)
  }
}

export function isManifestEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') return false
  if (entry.kind === 'symlink') {
    return typeof entry.target === 'string'
      && entry.target.length > 0
      && !entry.target.includes('\\')
      && !path.posix.isAbsolute(entry.target)
      && path.posix.normalize(entry.target) === entry.target
  }
  return entry.kind === undefined
    && Number.isInteger(entry.sizeBytes)
    && entry.sizeBytes >= 0
    && typeof entry.sha256 === 'string'
    && /^sha256:[a-f0-9]{64}$/u.test(entry.sha256)
}

export function assertArtifactFileSet(actualPaths, manifestEntryPaths, signatureFile = null) {
  const allowed = new Set([
    ...manifestEntryPaths,
    'runtime-service-manifest.json',
    ...(signatureFile ? [signatureFile] : []),
  ])
  const unexpected = [...actualPaths].filter(candidate => !allowed.has(candidate)).sort()
  if (unexpected.length > 0) {
    throw new Error(`Runtime Service 制品包含 manifest 未声明的文件：${unexpected.join('、')}`)
  }
}

function assertOutputDoesNotContainRepository(repositoryRoot, outputPath) {
  const relative = path.relative(outputPath, repositoryRoot)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`Runtime Service 输出目录不得是仓库根或其祖先：${outputPath}`)
  }
}

async function isOwnedArtifactDirectory(output) {
  try {
    const parsed = JSON.parse(await readFile(path.join(output, RUNTIME_OUTPUT_MARKER), 'utf8'))
    return parsed?.kind === RUNTIME_SERVICE_KIND && parsed?.schemaVersion === 1
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function optionalLstat(candidate) {
  try {
    return await lstat(candidate)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

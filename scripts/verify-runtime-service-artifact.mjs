#!/usr/bin/env node

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runtime Service 制品校验入口
//
//   文件:       verify-runtime-service-artifact.mjs
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import path from 'node:path'

import {
  assertRuntimeArtifactHasNoMutableState,
  assertRuntimeArtifactExcludesNonRuntimeGisSources,
  assertRuntimeArtifactMatchesTarget,
  assertRuntimeWorkspaces,
  requiredRuntimeArtifactPaths,
  RUNTIME_SERVICE_KIND,
} from './runtime-service/artifact-contract.mjs'
import {
  assertArtifactFileSet,
  assertCanonicalArtifactPath,
  isManifestEntry,
  listArtifactPaths,
  resolveArtifactPath,
} from './runtime-service/artifact-files.mjs'
import { verifyTrustedManifestSignature } from './runtime-service/manifest-signing.mjs'
import { collectNpmProductionPackages } from './runtime-service/npm-packages.mjs'
import {
  verifyBundledNode,
  verifyDarwinRuntime,
} from './runtime-service/platform-verification.mjs'
import { assertNpmSbomClosure } from './runtime-service/runtime-sbom.mjs'

const args = parseArgs(process.argv.slice(2))
const artifactRoot = path.resolve(args.artifactRoot ?? 'artifacts/runtime-service')
const canonicalArtifactRoot = await realpath(artifactRoot)
const manifestPath = path.join(artifactRoot, 'runtime-service-manifest.json')
await assertCanonicalArtifactPath(canonicalArtifactRoot, manifestPath, 'runtime-service-manifest.json')
if (!(await lstat(manifestPath)).isFile()) throw new Error('运行服务 manifest 不是普通文件。')
const manifestBytes = await readFile(manifestPath)
const manifest = JSON.parse(manifestBytes)
if (manifest.kind !== RUNTIME_SERVICE_KIND
  || manifest.schemaVersion !== 1
  || !Array.isArray(manifest.entries)) {
  throw new Error('运行服务 manifest 版本或类型不受支持。')
}

const entryPaths = new Set()
for (const entry of manifest.entries) {
  if (!isManifestEntry(entry)) throw new Error('运行服务 manifest 包含无效文件记录。')
  if (entryPaths.has(entry.path)) throw new Error(`运行服务 manifest 包含重复路径：${entry.path}`)
  entryPaths.add(entry.path)
  const filePath = resolveArtifactPath(artifactRoot, entry.path)
  await assertCanonicalArtifactPath(canonicalArtifactRoot, filePath, entry.path)
  const metadata = await lstat(filePath)
  if (entry.kind === 'symlink') {
    if (!metadata.isSymbolicLink() || await readlink(filePath) !== entry.target) {
      throw new Error(`运行服务制品符号链接校验失败：${entry.path}`)
    }
    continue
  }
  const content = await readFile(filePath)
  const actualHash = `sha256:${createHash('sha256').update(content).digest('hex')}`
  if (!metadata.isFile() || metadata.size !== entry.sizeBytes || actualHash !== entry.sha256) {
    throw new Error(`运行服务制品校验失败：${entry.path}`)
  }
}

assertRuntimeArtifactExcludesNonRuntimeGisSources(entryPaths)
assertRuntimeArtifactHasNoMutableState(entryPaths)
assertRuntimeArtifactMatchesTarget(entryPaths)
for (const requiredPath of requiredRuntimeArtifactPaths(entryPaths)) {
  if (!entryPaths.has(requiredPath)) throw new Error(`运行服务制品缺少必需文件：${requiredPath}`)
}

if (entryPaths.has('linux-runtime-bundle.json') || entryPaths.has('darwin-runtime-bundle.json')) {
  verifyBundledNode(artifactRoot)
}
if (entryPaths.has('darwin-runtime-bundle.json')) verifyDarwinRuntime(artifactRoot)

const runtimePackage = JSON.parse(await readFile(path.join(artifactRoot, 'package.json'), 'utf8'))
const runtimeLock = JSON.parse(await readFile(path.join(artifactRoot, 'package-lock.json'), 'utf8'))
assertRuntimeWorkspaces(runtimePackage.workspaces, 'package.json')
assertRuntimeWorkspaces(runtimeLock.packages?.['']?.workspaces, 'package-lock.json')

const sbom = JSON.parse(
  await readFile(path.join(artifactRoot, 'runtime-service-sbom.spdx.json'), 'utf8'),
)
if (sbom.spdxVersion !== 'SPDX-2.3' || !Array.isArray(sbom.packages)) {
  throw new Error('运行服务 SBOM 格式不受支持。')
}
const expectedNamespace = `https://geo-agent-platform.invalid/runtime-service/${encodeURIComponent(manifest.releaseId)}`
if (sbom.documentNamespace !== expectedNamespace) {
  throw new Error('运行服务 SBOM 与 manifest 的 releaseId 不一致。')
}
assertNpmSbomClosure(sbom.packages, collectNpmProductionPackages(runtimeLock))

const workerProject = await readFile(path.join(artifactRoot, 'apps/worker/pyproject.toml'), 'utf8')
const workerLock = await readFile(path.join(artifactRoot, 'apps/worker/uv.lock'), 'utf8')
const workerMeteorologyPackage = await lstat(path.join(artifactRoot, 'packages/gis-meteorology'))
if (!workerMeteorologyPackage.isDirectory()
  || !/path\s*=\s*["']\.\.\/\.\.\/packages\/gis-meteorology["']/u.test(workerProject)
  || !/editable\s*=\s*["']\.\.\/\.\.\/packages\/gis-meteorology["']/u.test(workerLock)) {
  throw new Error('运行服务 Worker 制品的 gis-meteorology 锁定相对路径无效。')
}

if (manifest.signing) {
  if (!args.trustedPublicKey) {
    throw new Error('已签名制品必须通过 --trusted-public-key 提供部署侧可信 Ed25519 公钥。')
  }
  const signaturePath = resolveArtifactPath(artifactRoot, manifest.signing.signatureFile)
  await assertCanonicalArtifactPath(
    canonicalArtifactRoot,
    signaturePath,
    manifest.signing.signatureFile,
  )
  if (!(await lstat(signaturePath)).isFile()) throw new Error('运行服务 manifest 签名不是普通文件。')
  const signature = JSON.parse(await readFile(signaturePath, 'utf8'))
  if ('publicKeyPem' in signature) {
    throw new Error('签名文件不得自带并信任公钥；必须使用部署侧信任根。')
  }
  const trustedPublicKey = await readFile(path.resolve(args.trustedPublicKey))
  if (/PRIVATE KEY/u.test(trustedPublicKey.toString('utf8'))) {
    throw new Error('--trusted-public-key 必须指向公钥，不得使用私钥文件。')
  }
  verifyTrustedManifestSignature({
    manifestBytes,
    manifestSigning: manifest.signing,
    signature,
    trustedPublicKey,
  })
} else if (args.requireSignature || args.trustedPublicKey) {
  throw new Error('运行服务制品未签名，不符合当前验证要求。')
}

assertArtifactFileSet(
  await listArtifactPaths(artifactRoot),
  entryPaths,
  manifest.signing?.signatureFile ?? null,
)

process.stdout.write(`${artifactRoot}\n`)

function parseArgs(argv) {
  const result = { artifactRoot: null, trustedPublicKey: null, requireSignature: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--trusted-public-key') {
      result.trustedPublicKey = argv[index + 1] ?? null
      index += 1
      if (!result.trustedPublicKey) throw new Error('--trusted-public-key 需要公钥文件路径。')
    } else if (argument === '--require-signature') {
      result.requireSignature = true
    } else if (argument.startsWith('--')) {
      throw new Error(`未知参数：${argument}`)
    } else if (result.artifactRoot) {
      throw new Error('只能指定一个 Runtime Service 制品目录。')
    } else {
      result.artifactRoot = argument
    }
  }
  return result
}

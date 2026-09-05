#!/usr/bin/env node

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runtime Service 制品生成入口
//
//   文件:       create-runtime-service-artifact.mjs
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  assertRuntimeArtifactHasNoMutableState,
  assertRuntimeArtifactMatchesTarget,
  runtimeArtifactInputsFor,
  runtimeArtifactTargetFor,
  RUNTIME_SERVICE_KIND,
  RUNTIME_WORKSPACE_PATHS,
  shouldIncludeGisMeteorologyRuntimeSource,
  shouldIncludeRuntimeArtifactPath,
} from './runtime-service/artifact-contract.mjs'
import {
  listArtifactEntries,
  prepareArtifactOutput,
  pruneExcludedArtifactFiles,
} from './runtime-service/artifact-files.mjs'
import {
  readSigningMaterial,
  writeManifestSignature,
} from './runtime-service/manifest-signing.mjs'
import {
  createRuntimePackageLock,
  createRuntimeRootPackageManifest,
  createRuntimeWorkspacePackageManifest,
} from './runtime-service/npm-packages.mjs'
import {
  materializeDarwinRuntime,
  materializeLinuxRuntime,
} from './runtime-service/platform-materialization.mjs'
import { writeRuntimeSbom } from './runtime-service/runtime-sbom.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))
const output = path.resolve(root, args.out ?? path.join('artifacts', 'runtime-service'))
const artifactTarget = runtimeArtifactTargetFor(args)

if (args.build) buildRuntimeWorkspaces(root)

await prepareArtifactOutput(root, output, args.force)
await copyArtifactInputs(root, output, artifactTarget)

const rootPackagePath = path.join(output, 'package.json')
const rootLockPath = path.join(output, 'package-lock.json')
const sourceRootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8'))
const runtimeRootPackage = createRuntimeRootPackageManifest(sourceRootPackage)
const sourceRootLock = JSON.parse(await readFile(rootLockPath, 'utf8'))
const runtimeLock = createRuntimePackageLock(sourceRootLock, runtimeRootPackage)
await writeFile(rootPackagePath, `${JSON.stringify(runtimeRootPackage, null, 2)}\n`, 'utf8')
await writeFile(rootLockPath, `${JSON.stringify(runtimeLock, null, 2)}\n`, 'utf8')
for (const workspacePath of RUNTIME_WORKSPACE_PATHS) {
  const packagePath = path.join(output, workspacePath, 'package.json')
  const sourcePackage = JSON.parse(await readFile(packagePath, 'utf8'))
  const runtimePackage = createRuntimeWorkspacePackageManifest(sourcePackage)
  await writeFile(packagePath, `${JSON.stringify(runtimePackage, null, 2)}\n`, 'utf8')
}

if (args.materializeLinux) await materializeLinuxRuntime(output)
if (args.materializeDarwin) await materializeDarwinRuntime(root, output)

const pathsBeforePruning = (await listArtifactEntries(output))
  .map(entry => path.relative(output, entry.path).replaceAll(path.sep, '/'))
assertRuntimeArtifactHasNoMutableState(pathsBeforePruning)
await pruneExcludedArtifactFiles(output, artifactTarget)

const serverPackage = JSON.parse(
  await readFile(path.join(output, 'apps/server/package.json'), 'utf8'),
)
const releaseId = process.env.GEO_AGENT_PLATFORM_RELEASE_ID?.trim()
  || `geo-agent-platform@${String(serverPackage.version)}+runtime-service`
const workerContractDigest = process.env.WORKER_CONTRACT_DIGEST?.trim() || null
if (workerContractDigest !== null && !/^sha256:[a-f0-9]{64}$/u.test(workerContractDigest)) {
  throw new Error('WORKER_CONTRACT_DIGEST 必须是 sha256:<64 位小写十六进制>。')
}
const releaseContracts = await loadReleaseContracts(root)
const signingMaterial = args.signingKey
  ? await readSigningMaterial(root, args.signingKey)
  : null
await writeRuntimeSbom({ artifactRoot: output, npmLock: runtimeLock, releaseId, repositoryRoot: root })

const entries = []
for (const file of await listArtifactEntries(output)) {
  const relativePath = path.relative(output, file.path).replaceAll(path.sep, '/')
  if (file.kind === 'symlink') {
    entries.push({ path: relativePath, kind: 'symlink', target: file.target })
  } else {
    const content = await readFile(file.path)
    entries.push({
      path: relativePath,
      sizeBytes: content.byteLength,
      sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    })
  }
}
assertRuntimeArtifactMatchesTarget(entries.map(entry => entry.path))
entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)

const manifest = {
  schemaVersion: 1,
  kind: RUNTIME_SERVICE_KIND,
  releaseId,
  apiProtocolVersion: releaseContracts.apiProtocolVersion,
  minDesktopProtocol: releaseContracts.desktopProtocolVersion,
  maxDesktopProtocol: releaseContracts.desktopProtocolVersion,
  databaseSchemaVersion: releaseContracts.databaseSchemaVersion,
  workerContractDigest,
  workerContractDigestResolvedAtRuntime: workerContractDigest === null,
  signing: signingMaterial
    ? {
        algorithm: 'ed25519',
        signatureFile: 'runtime-service-manifest.sig',
        keyFingerprint: signingMaterial.keyFingerprint,
      }
    : null,
  entries,
}
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await writeFile(path.join(output, 'runtime-service-manifest.json'), manifestBytes)
if (signingMaterial) await writeManifestSignature(output, manifestBytes, signingMaterial)
process.stdout.write(`${output}${process.platform === 'win32' ? '\\' : '/'}runtime-service-manifest.json\n`)

function parseArgs(argv) {
  const result = {
    build: false,
    force: false,
    materializeDarwin: false,
    materializeLinux: false,
    out: null,
    signingKey: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--build') result.build = true
    else if (argument === '--force') result.force = true
    else if (argument === '--materialize-darwin') result.materializeDarwin = true
    else if (argument === '--materialize-linux') result.materializeLinux = true
    else if (argument === '--out') {
      result.out = argv[index + 1]
      index += 1
      if (!result.out) throw new Error('--out 需要目录参数。')
    } else if (argument === '--signing-key') {
      result.signingKey = argv[index + 1]
      index += 1
      if (!result.signingKey) throw new Error('--signing-key 需要 Ed25519 私钥文件。')
    } else {
      throw new Error(`未知参数：${argument}`)
    }
  }
  if (result.materializeDarwin && result.materializeLinux) {
    throw new Error('Runtime Service 不能同时物化 Linux 与 macOS 运行时。')
  }
  return result
}

function buildRuntimeWorkspaces(repositoryRoot) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const executable = process.platform === 'win32' ? process.env.ComSpec : npm
  if (!executable) throw new Error('Runtime Service 编译需要可用的 ComSpec。')
  for (const workspace of [
    '@geo-agent-platform/shared-types',
    '@geo-agent-platform/conversation-presentation',
    '@geo-agent-platform/operations-supervisor',
    '@geo-agent-platform/db',
    'geo-agent-server',
    '@geo-agent-platform/operations-console',
  ]) {
    const npmArguments = ['run', 'build', '--workspace', workspace]
    const commandArguments = process.platform === 'win32'
      ? ['/d', '/s', '/c', npm, ...npmArguments]
      : npmArguments
    const build = spawnSync(executable, commandArguments, {
      cwd: repositoryRoot,
      stdio: 'inherit',
    })
    if (build.error || build.status !== 0) {
      throw new Error(`Runtime Service 编译失败（${workspace}），未生成发布制品。`)
    }
  }
}

async function copyArtifactInputs(repositoryRoot, artifactRoot, target) {
  for (const specification of runtimeArtifactInputsFor(target)) {
    const sourcePath = path.join(repositoryRoot, specification.source)
    let metadata
    try {
      metadata = await stat(sourcePath)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`Runtime Service 制品缺少输入：${specification.source}`)
      }
      throw error
    }
    if ((specification.kind === 'directory' && !metadata.isDirectory())
      || (specification.kind === 'file' && !metadata.isFile())) {
      throw new Error(`Runtime Service 输入类型不正确：${specification.source}`)
    }
    const destination = path.join(artifactRoot, specification.destination)
    await mkdir(path.dirname(destination), { recursive: true })
    await cp(sourcePath, destination, {
      recursive: specification.kind === 'directory',
      filter: candidate => {
        const sourceRelativePath = path.relative(sourcePath, candidate)
        const artifactRelativePath = path.join(specification.destination, sourceRelativePath)
        return shouldIncludeRuntimeArtifactPath(artifactRelativePath, target)
          && (specification.source !== 'packages/gis-meteorology/src'
            || shouldIncludeGisMeteorologyRuntimeSource(sourceRelativePath))
      },
    })
  }
}

async function loadReleaseContracts(repositoryRoot) {
  const sharedRelease = await import(pathToFileURL(
    path.join(repositoryRoot, 'packages/shared-types/dist/release.js'),
  ).href)
  const schemaContract = await import(pathToFileURL(
    path.join(repositoryRoot, 'apps/server/dist/db/schemaContract.js'),
  ).href)
  const apiProtocolVersion = sharedRelease.API_PROTOCOL_VERSION
  const desktopProtocolVersion = sharedRelease.DESKTOP_PROTOCOL_VERSION
  const databaseSchemaVersion = schemaContract.DATABASE_SCHEMA_CONTRACT_VERSION
  if (![apiProtocolVersion, desktopProtocolVersion, databaseSchemaVersion]
    .every(value => Number.isInteger(value) && value >= 0)) {
    throw new Error('发布协议或数据库版本常量无效。')
  }
  return { apiProtocolVersion, desktopProtocolVersion, databaseSchemaVersion }
}

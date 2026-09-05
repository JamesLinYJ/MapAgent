// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runtime Service 发布边界测试
//
//   文件:       runtime-service-artifact.test.mjs
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { generateKeyPairSync, sign } from 'node:crypto'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import {
  assertRuntimeArtifactHasNoMutableState,
  assertRuntimeArtifactExcludesNonRuntimeGisSources,
  assertRuntimeArtifactMatchesTarget,
  requiredRuntimeArtifactPaths,
  RUNTIME_ARTIFACT_INPUTS,
  RUNTIME_OUTPUT_MARKER,
  RUNTIME_SERVICE_KIND,
  RUNTIME_WORKSPACE_PATHS,
  runtimeArtifactInputsFor,
  runtimeArtifactTargetFor,
  shouldIncludeGisMeteorologyRuntimeSource,
  shouldIncludeRuntimeArtifactPath,
} from './runtime-service/artifact-contract.mjs'
import {
  assertArtifactFileSet,
  prepareArtifactOutput,
  pruneExcludedArtifactFiles,
  rebaseCopiedAbsoluteSymlinks,
} from './runtime-service/artifact-files.mjs'
import {
  publicKeyFingerprint,
  verifyTrustedManifestSignature,
} from './runtime-service/manifest-signing.mjs'
import {
  collectNpmProductionPackages,
  createRuntimePackageLock,
  createRuntimeRootPackageManifest,
  createRuntimeWorkspacePackageManifest,
} from './runtime-service/npm-packages.mjs'
import { verifyDarwinRuntime } from './runtime-service/platform-verification.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('force 只能覆盖已标记的专用制品目录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'geo-runtime-output-'))
  try {
    const unmanaged = path.join(root, 'artifacts', 'unmanaged')
    await mkdir(unmanaged, { recursive: true })
    await writeFile(path.join(unmanaged, 'keep.txt'), 'keep', 'utf8')
    await writeFile(
      path.join(unmanaged, 'runtime-service-manifest.json'),
      JSON.stringify({ schemaVersion: 1, kind: RUNTIME_SERVICE_KIND }),
      'utf8',
    )
    await assert.rejects(
      prepareArtifactOutput(root, unmanaged, true),
      /拒绝覆盖非 Runtime Service 专用目录/u,
    )
    assert.equal(await readFile(path.join(unmanaged, 'keep.txt'), 'utf8'), 'keep')

    await assert.rejects(
      prepareArtifactOutput(root, root, true),
      /不得是仓库根或其祖先/u,
    )

    const managed = path.join(root, 'artifacts', 'managed')
    await mkdir(managed, { recursive: true })
    await writeFile(
      path.join(managed, RUNTIME_OUTPUT_MARKER),
      JSON.stringify({ schemaVersion: 1, kind: RUNTIME_SERVICE_KIND }),
      'utf8',
    )
    await writeFile(path.join(managed, 'stale.txt'), 'stale', 'utf8')
    await prepareArtifactOutput(root, managed, true)
    await access(path.join(managed, RUNTIME_OUTPUT_MARKER))
    await assert.rejects(access(path.join(managed, 'stale.txt')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('复制的运行时绝对符号链接会改写到制品内部', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'geo-runtime-symlinks-'))
  try {
    const source = path.join(root, 'mounted', 'Versions', '16')
    const destination = path.join(root, 'artifact', 'postgresql-portable')
    await mkdir(path.join(source, 'bin'), { recursive: true })
    await mkdir(path.join(source, 'lib'), { recursive: true })
    await mkdir(path.join(destination, 'bin'), { recursive: true })
    await mkdir(path.join(destination, 'lib'), { recursive: true })
    await writeFile(path.join(source, 'bin', 'proj'), 'binary')
    await writeFile(path.join(source, 'lib', 'libzstd.1.5.7.dylib'), 'library')
    await writeFile(path.join(destination, 'bin', 'proj'), 'binary')
    await writeFile(path.join(destination, 'lib', 'libzstd.1.5.7.dylib'), 'library')
    await symlink(path.join(source, 'bin', 'proj'), path.join(destination, 'bin', 'invproj'))
    await symlink(
      path.join(source, 'lib', 'libzstd.1.5.7.dylib'),
      path.join(destination, 'lib', 'libzstd.1.dylib'),
    )
    await symlink('libzstd.1.5.7.dylib', path.join(destination, 'lib', 'libzstd.dylib'))

    assert.equal(await rebaseCopiedAbsoluteSymlinks(source, destination), 2)
    assert.equal(await readlink(path.join(destination, 'bin', 'invproj')), 'proj')
    assert.equal(
      await readlink(path.join(destination, 'lib', 'libzstd.1.dylib')),
      'libzstd.1.5.7.dylib',
    )
    assert.equal(await readlink(path.join(destination, 'lib', 'libzstd.dylib')), 'libzstd.1.5.7.dylib')
    assert.equal(
      await realpath(path.join(destination, 'lib', 'libzstd.1.dylib')),
      await realpath(path.join(destination, 'lib', 'libzstd.1.5.7.dylib')),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('复制的运行时符号链接不得逃逸来源目录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'geo-runtime-symlink-escape-'))
  try {
    const source = path.join(root, 'mounted', 'Versions', '16')
    const destination = path.join(root, 'artifact', 'postgresql-portable')
    const outside = path.join(root, 'host-library.dylib')
    await mkdir(path.join(source, 'lib'), { recursive: true })
    await mkdir(path.join(destination, 'lib'), { recursive: true })
    await writeFile(outside, 'host')
    await symlink(outside, path.join(destination, 'lib', 'libhost.dylib'))

    await assert.rejects(
      rebaseCopiedAbsoluteSymlinks(source, destination),
      /符号链接越过来源目录/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime package 和 lock 只保留生产 workspace', () => {
  const sourcePackage = {
    name: 'platform',
    private: true,
    version: '1.0.0',
    workspaces: [...RUNTIME_WORKSPACE_PATHS, 'apps/desktop'],
    dependencies: { root: '1.0.0' },
    devDependencies: { test: '1.0.0' },
  }
  const runtimePackage = createRuntimeRootPackageManifest(sourcePackage)
  const runtimeLock = createRuntimePackageLock({
    name: 'platform',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': sourcePackage,
      'apps/server': {
        name: 'server',
        version: '1.0.0',
        dependencies: { pino: '1.0.0' },
        devDependencies: { vitest: '1.0.0' },
      },
      'apps/operations-console': { name: 'console', version: '1.0.0' },
      'apps/desktop': { name: 'desktop', version: '1.0.0' },
      'apps/desktop/node_modules/electron': { name: 'electron', version: '1.0.0', dev: true },
      'node_modules/desktop': { resolved: 'apps/desktop', link: true },
      'node_modules/console': { resolved: 'apps/operations-console', link: true },
      'node_modules/server': { resolved: 'apps/server', link: true },
      'node_modules/root': { name: 'root', version: '1.0.0' },
      'node_modules/pino': { name: 'pino', version: '1.0.0' },
      'node_modules/vitest': { name: 'vitest', version: '1.0.0', dev: true },
      'packages/db': { name: 'db', version: '1.0.0' },
      'packages/shared-types': { name: 'shared', version: '1.0.0' },
      'packages/conversation-presentation': { name: 'presentation', version: '1.0.0' },
      'packages/operations-supervisor': {
        name: 'supervisor',
        version: '1.0.0',
        bin: {
          'geo-agent-platform-supervisor': 'dist/cli.js',
          'geo-agent-platform-dev': 'dist/devCli.js',
        },
      },
    },
  }, runtimePackage)

  assert.deepEqual(runtimePackage.workspaces, RUNTIME_WORKSPACE_PATHS)
  assert.equal(runtimePackage.scripts['start:api'], 'node apps/server/dist/main.js')
  assert.equal('devDependencies' in runtimePackage, false)
  assert.equal('allowScripts' in runtimePackage, false)
  assert.deepEqual(runtimeLock.packages[''].workspaces, RUNTIME_WORKSPACE_PATHS)
  assert.deepEqual(runtimeLock.packages['apps/server'].dependencies, { pino: '1.0.0' })
  assert.equal('devDependencies' in runtimeLock.packages['apps/server'], false)
  assert.equal(runtimeLock.packages['apps/desktop'], undefined)
  assert.equal(runtimeLock.packages['apps/desktop/node_modules/electron'], undefined)
  assert.equal(runtimeLock.packages['node_modules/desktop'], undefined)
  assert.deepEqual(runtimeLock.packages['node_modules/console'], {
    resolved: 'apps/operations-console',
    link: true,
  })
  assert.deepEqual(runtimeLock.packages['node_modules/server'], {
    resolved: 'apps/server',
    link: true,
  })
  assert.equal(runtimeLock.packages['node_modules/vitest'], undefined)
  assert.equal(runtimeLock.packages['node_modules/root']?.version, '1.0.0')
  assert.equal(runtimeLock.packages['node_modules/pino']?.version, '1.0.0')
  assert.deepEqual(runtimeLock.packages['packages/operations-supervisor'].bin, {
    'geo-agent-platform-supervisor': 'dist/cli.js',
  })

  const workspacePackage = createRuntimeWorkspacePackageManifest({
    name: 'server',
    types: './dist/index.d.ts',
    files: ['dist'],
    scripts: { test: 'vitest run' },
    bin: {
      'geo-agent-platform-supervisor': './dist/cli.js',
      'geo-agent-platform-dev': './dist/devCli.js',
    },
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
    },
    dependencies: { pino: '1.0.0' },
    devDependencies: { vitest: '1.0.0' },
  })
  assert.deepEqual(workspacePackage.dependencies, { pino: '1.0.0' })
  assert.equal('devDependencies' in workspacePackage, false)
  assert.equal('types' in workspacePackage, false)
  assert.equal('files' in workspacePackage, false)
  assert.equal('scripts' in workspacePackage, false)
  assert.deepEqual(workspacePackage.bin, {
    'geo-agent-platform-supervisor': './dist/cli.js',
  })
  assert.deepEqual(workspacePackage.exports, { '.': { import: './dist/index.js' } })
})

test('npm SBOM 闭包遍历生产依赖且排除无关 workspace', async () => {
  const lock = JSON.parse(await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'))
  const components = collectNpmProductionPackages(lock)
  const names = new Set(components.map(component => component.name))

  assert.ok(components.length > 100)
  assert.ok(names.has('geo-agent-server'))
  assert.ok(names.has('@geo-agent-platform/operations-supervisor'))
  assert.ok(names.has('pino'))
  assert.ok(names.has('zod'))
  assert.equal(names.has('@geo-agent-platform/desktop'), false)
  assert.equal(names.has('electron'), false)
})

test('manifest 签名只信任部署侧公钥', () => {
  const trusted = generateKeyPairSync('ed25519')
  const attacker = generateKeyPairSync('ed25519')
  const manifestBytes = Buffer.from('{"releaseId":"release-1"}\n', 'utf8')
  const keyFingerprint = publicKeyFingerprint(trusted.publicKey)
  const signature = {
    schemaVersion: 1,
    algorithm: 'ed25519',
    keyFingerprint,
    signatureBase64: sign(null, manifestBytes, trusted.privateKey).toString('base64'),
  }
  const manifestSigning = { algorithm: 'ed25519', keyFingerprint }

  assert.doesNotThrow(() => verifyTrustedManifestSignature({
    manifestBytes,
    manifestSigning,
    signature,
    trustedPublicKey: trusted.publicKey,
  }))
  assert.throws(() => verifyTrustedManifestSignature({
    manifestBytes,
    manifestSigning,
    signature,
    trustedPublicKey: attacker.publicKey,
  }), /信任根不一致/u)
})

test('生成器输入和校验器必需路径共用制品契约', () => {
  assert.equal(RUNTIME_ARTIFACT_INPUTS.some(
    specification => specification.source === '.node-version',
  ), false)
  assert.equal(shouldIncludeRuntimeArtifactPath('.node-version'), false)
  const seedInput = RUNTIME_ARTIFACT_INPUTS.find(
    specification => specification.source === 'infra/seeds/layers',
  )
  assert.deepEqual(seedInput, {
    source: 'infra/seeds/layers',
    destination: 'infra/seeds/layers',
    kind: 'directory',
    requiredPaths: [
      'infra/seeds/layers/catalog.json',
      'infra/seeds/layers/hangzhou_districts.geojson',
    ],
  })

  const requiredPaths = new Set(requiredRuntimeArtifactPaths(new Set()))
  for (const specification of RUNTIME_ARTIFACT_INPUTS) {
    for (const requiredPath of specification.requiredPaths) {
      assert.ok(requiredPaths.has(requiredPath), `${requiredPath} 必须由共享契约要求`)
    }
  }
})

test('平台目标只携带本平台启动入口', () => {
  assert.equal(runtimeArtifactTargetFor({ materializeDarwin: true }), 'darwin')
  assert.equal(runtimeArtifactTargetFor({ materializeLinux: true }), 'linux')
  assert.equal(runtimeArtifactTargetFor({}), 'generic')

  const darwinInputs = runtimeArtifactInputsFor('darwin')
  assert.equal(darwinInputs.some(input => input.destination === 'deploy'), false)
  assert.equal(darwinInputs.some(input => input.destination === 'scripts/run-worker.sh'), true)
  assert.equal(darwinInputs.some(input => input.destination.endsWith('.ps1')), false)
  assert.equal(shouldIncludeRuntimeArtifactPath('deploy/bin/geo-agent-platform', 'darwin'), false)

  const linuxInputs = runtimeArtifactInputsFor('linux')
  const linuxDeploy = linuxInputs.find(input => input.destination === 'deploy')
  assert.deepEqual(linuxDeploy?.requiredPaths, [
    'deploy/systemd/geo-agent-platform-supervisor.user.service',
    'deploy/bin/geo-agent-platform',
  ])
  assert.equal(linuxInputs.some(input => input.destination === 'scripts/run-worker.sh'), true)
  assert.equal(linuxInputs.some(input => input.destination.endsWith('.ps1')), false)
  assert.equal(shouldIncludeRuntimeArtifactPath(
    'deploy/bin/geo-agent-platform',
    'linux',
  ), true)
  assert.equal(shouldIncludeRuntimeArtifactPath(
    'deploy/systemd/geo-agent-platform-supervisor.user.service',
    'linux',
  ), true)
  assert.equal(shouldIncludeRuntimeArtifactPath(
    'deploy/systemd/geo-agent-platform-supervisor.service',
    'linux',
  ), false)
  assert.equal(shouldIncludeRuntimeArtifactPath('deploy/runtime.env.example', 'linux'), false)

  const genericInputs = runtimeArtifactInputsFor('generic')
  assert.equal(genericInputs.some(input => input.destination === 'deploy'), true)
  assert.equal(genericInputs.some(input => input.destination === 'scripts/run-worker.ps1'), true)
  assert.equal(genericInputs.some(input => input.destination === 'scripts/run-windows-service.ps1'), true)

  assert.doesNotThrow(() => assertRuntimeArtifactMatchesTarget([
    'darwin-runtime-bundle.json',
    'scripts/run-worker.sh',
  ]))
  assert.throws(() => assertRuntimeArtifactMatchesTarget([
    'darwin-runtime-bundle.json',
    'deploy/bin/geo-agent-platform',
    'scripts/run-worker.ps1',
  ]), /目标平台不需要/u)
  assert.throws(() => assertRuntimeArtifactMatchesTarget([
    'darwin-runtime-bundle.json',
    'linux-runtime-bundle.json',
  ]), /不能同时声明/u)
})

test('制品排除构建内容但保留运行代码、包元数据和许可证', async () => {
  assert.equal(shouldIncludeRuntimeArtifactPath('packages/shared-types/dist/index.js'), true)
  assert.equal(shouldIncludeRuntimeArtifactPath('packages/shared-types/dist/index.d.ts'), false)
  assert.equal(shouldIncludeRuntimeArtifactPath('packages/shared-types/dist/index.js.map'), false)
  assert.equal(shouldIncludeRuntimeArtifactPath(
    'apps/server/dist/agent-runtime/approvals/approvalTestFixtures.js',
  ), false)
  assert.equal(shouldIncludeRuntimeArtifactPath(
    'packages/operations-supervisor/dist/devCli.js',
  ), false)
  assert.equal(shouldIncludeRuntimeArtifactPath(
    'packages/operations-supervisor/dist/devLauncher.js',
  ), false)
  assert.equal(shouldIncludeRuntimeArtifactPath(
    'apps/worker/src/worker_app/__pycache__/sidecar.cpython-314.pyc',
  ), false)
  assert.equal(shouldIncludeRuntimeArtifactPath(
    'apps/worker/src/geo_agent_worker.egg-info/PKG-INFO',
  ), false)
  assert.equal(shouldIncludeRuntimeArtifactPath(
    'packages/gis-meteorology/src/gis_meteorology.egg-info/PKG-INFO',
  ), false)
  assert.equal(shouldIncludeRuntimeArtifactPath(
    'apps/worker/src/worker_app/catalog_cli.py',
  ), false)
  for (const typeOnlyOutput of [
    'apps/operations-console/dist/localConsoleTypes.js',
    'apps/server/dist/agent/runtimeTypes.js',
    'apps/server/dist/agent-runtime/context/ContextWindowStore.js',
    'apps/server/dist/framework/types.js',
    'apps/server/dist/gis/managedLayers/managedLayerTypes.js',
    'apps/server/dist/map/mapTileSource.js',
    'apps/server/dist/runtime/index.js',
    'apps/server/dist/security/types.js',
    'apps/server/dist/store/conversationPayloadStorage.js',
    'apps/server/dist/store/postgres/artifactRepository.js',
    'apps/server/dist/store/postgres/conversationPersistencePorts.js',
    'apps/server/dist/store/runtimePorts.js',
    'apps/server/dist/ws/dependencies.js',
  ]) {
    assert.equal(shouldIncludeRuntimeArtifactPath(typeOnlyOutput), false)
  }
  assert.equal(shouldIncludeRuntimeArtifactPath(
    'python-packages/worker_app/sidecar.py',
  ), false)
  assert.equal(shouldIncludeRuntimeArtifactPath(
    'python-packages/gis_meteorology/service.py',
  ), false)
  assert.equal(shouldIncludeRuntimeArtifactPath(
    'python-packages/geo_agent_worker-0.1.0.dist-info/METADATA',
  ), true)
  assert.equal(shouldIncludeRuntimeArtifactPath(
    'python-packages/gis_meteorology-0.1.0.dist-info/licenses/LICENSE',
  ), true)
  assert.equal(shouldIncludeRuntimeArtifactPath('node_modules/example/package.json'), true)
  assert.equal(shouldIncludeRuntimeArtifactPath('node_modules/example/LICENSE.md'), true)
  assert.equal(shouldIncludeRuntimeArtifactPath('node_modules/example/README.md'), true)
  assert.equal(shouldIncludeRuntimeArtifactPath('node_modules/example/index.d.ts'), true)
  assert.equal(shouldIncludeRuntimeArtifactPath('node_modules/example/index.js.map'), true)
  assert.equal(shouldIncludeRuntimeArtifactPath('python-packages/numpy/testing/tests/test_utils.py'), true)

  const root = await mkdtemp(path.join(tmpdir(), 'geo-runtime-prune-'))
  try {
    const packageRoot = path.join(root, 'node_modules', 'example')
    const sharedDist = path.join(root, 'packages', 'shared-types', 'dist')
    const approvalDist = path.join(
      root,
      'apps',
      'server',
      'dist',
      'agent-runtime',
      'approvals',
    )
    const supervisorDist = path.join(root, 'packages', 'operations-supervisor', 'dist')
    const workerCache = path.join(root, 'apps', 'worker', 'src', 'worker_app', '__pycache__')
    const installedWorker = path.join(root, 'python-packages', 'worker_app')
    const installedGis = path.join(root, 'python-packages', 'gis_meteorology')
    const workerMetadata = path.join(root, 'python-packages', 'geo_agent_worker-0.1.0.dist-info')
    await Promise.all([
      mkdir(packageRoot, { recursive: true }),
      mkdir(sharedDist, { recursive: true }),
      mkdir(approvalDist, { recursive: true }),
      mkdir(supervisorDist, { recursive: true }),
      mkdir(workerCache, { recursive: true }),
      mkdir(installedWorker, { recursive: true }),
      mkdir(installedGis, { recursive: true }),
      mkdir(workerMetadata, { recursive: true }),
    ])
    await Promise.all([
      writeFile(path.join(packageRoot, 'package.json'), '{}\n'),
      writeFile(path.join(packageRoot, 'LICENSE.md'), 'license\n'),
      writeFile(path.join(packageRoot, 'README.md'), 'readme\n'),
      writeFile(path.join(packageRoot, 'index.d.ts'), 'export {}\n'),
      writeFile(path.join(packageRoot, 'index.js.map'), '{}\n'),
      writeFile(path.join(packageRoot, 'index.test.js'), 'throw new Error()\n'),
      writeFile(path.join(sharedDist, 'index.js'), 'export {}\n'),
      writeFile(path.join(sharedDist, 'index.d.ts'), 'export {}\n'),
      writeFile(path.join(sharedDist, 'index.js.map'), '{}\n'),
      writeFile(path.join(approvalDist, 'approvalTestFixtures.js'), 'export {}\n'),
      writeFile(path.join(supervisorDist, 'devCli.js'), 'export {}\n'),
      writeFile(path.join(supervisorDist, 'devLauncher.js'), 'export {}\n'),
      writeFile(path.join(workerCache, 'sidecar.cpython-314.pyc'), 'cache\n'),
      writeFile(path.join(installedWorker, 'sidecar.py'), 'app = None\n'),
      writeFile(path.join(installedGis, 'service.py'), 'class Service: pass\n'),
      writeFile(path.join(workerMetadata, 'METADATA'), 'Name: geo-agent-worker\n'),
    ])
    const result = await pruneExcludedArtifactFiles(root, 'darwin')
    assert.equal(result.removedFiles, 5)
    assert.ok(result.removedDirectories >= 3)
    await access(path.join(packageRoot, 'package.json'))
    await access(path.join(packageRoot, 'LICENSE.md'))
    await access(path.join(packageRoot, 'README.md'))
    await access(path.join(packageRoot, 'index.d.ts'))
    await access(path.join(packageRoot, 'index.js.map'))
    await access(path.join(packageRoot, 'index.test.js'))
    await access(path.join(sharedDist, 'index.js'))
    await assert.rejects(access(path.join(sharedDist, 'index.d.ts')))
    await assert.rejects(access(path.join(sharedDist, 'index.js.map')))
    await assert.rejects(access(path.join(approvalDist, 'approvalTestFixtures.js')))
    await assert.rejects(access(path.join(supervisorDist, 'devCli.js')))
    await assert.rejects(access(path.join(supervisorDist, 'devLauncher.js')))
    await assert.rejects(access(workerCache))
    await assert.rejects(access(installedWorker))
    await assert.rejects(access(installedGis))
    await access(path.join(workerMetadata, 'METADATA'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('制品拒绝构建探针遗留的可变运行状态', () => {
  assert.doesNotThrow(() => assertRuntimeArtifactHasNoMutableState([
    'apps/server/dist/main.js',
    'node_modules/example/LICENSE.md',
  ]))
  assert.throws(() => assertRuntimeArtifactHasNoMutableState([
    'runtime/.worker-concurrency.sqlite3',
    'runtime/.worker-nonces.sqlite3-wal',
  ]), /构建期运行状态/u)
})

test('macOS Worker 探针只在临时运行目录创建状态', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'geo-runtime-probe-boundary-'))
  const artifactRoot = path.join(root, 'artifact')
  const pythonExecutable = path.join(artifactRoot, 'python-runtime', 'bin', 'python3.12')
  const postgresExecutable = path.join(artifactRoot, 'postgresql-portable', 'bin', 'postgres')
  const capturedRuntimeRoot = path.join(root, 'probe-runtime-root.txt')
  try {
    await Promise.all([
      mkdir(path.dirname(pythonExecutable), { recursive: true }),
      mkdir(path.dirname(postgresExecutable), { recursive: true }),
    ])
    await writeFile(pythonExecutable, [
      '#!/bin/sh',
      'test "$1" = "-B" || exit 10',
      'test "$PYTHONDONTWRITEBYTECODE" = "1" || exit 14',
      'test -n "$RUNTIME_ROOT" || exit 11',
      'test "$WORKER_NONCE_STORE_PATH" = "$RUNTIME_ROOT/.worker-nonces.sqlite3" || exit 12',
      'test "$WORKER_CONCURRENCY_STORE_PATH" = "$RUNTIME_ROOT/.worker-concurrency.sqlite3" || exit 13',
      'mkdir -p "$RUNTIME_ROOT"',
      ': > "$WORKER_NONCE_STORE_PATH"',
      ': > "$WORKER_CONCURRENCY_STORE_PATH"',
      'printf "%s" "$RUNTIME_ROOT" > "$(dirname "$0")/../../../probe-runtime-root.txt"',
      '',
    ].join('\n'))
    await writeFile(postgresExecutable, '#!/bin/sh\nexit 0\n')
    await Promise.all([chmod(pythonExecutable, 0o755), chmod(postgresExecutable, 0o755)])

    verifyDarwinRuntime(artifactRoot)

    const probeRuntimeRoot = await readFile(capturedRuntimeRoot, 'utf8')
    await assert.rejects(access(probeRuntimeRoot))
    await assert.rejects(access(path.join(artifactRoot, 'runtime')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime 制品排除不参与运行且会读取旧凭据的第三方来源快照', () => {
  assert.equal(shouldIncludeGisMeteorologyRuntimeSource(
    'gis_meteorology/third_party/short_term_forecast/source/app.py',
  ), false)
  assert.equal(shouldIncludeGisMeteorologyRuntimeSource(
    'gis_meteorology/third_party/rainfall_risk_map/source/app.py',
  ), false)
  assert.equal(shouldIncludeGisMeteorologyRuntimeSource(
    'gis_meteorology/third_party/radar_mosaic_agent/source/original/backend_app.py',
  ), false)
  assert.equal(shouldIncludeGisMeteorologyRuntimeSource(
    'gis_meteorology/third_party/radar_mosaic_agent/source/radar_mosaic.py',
  ), true)
  assert.equal(shouldIncludeGisMeteorologyRuntimeSource(
    'gis_meteorology/third_party/radar_mosaic_agent/source/radar_decoder.py',
  ), true)
  assert.equal(shouldIncludeGisMeteorologyRuntimeSource(
    'gis_meteorology/third_party/short_term_forecast/adapter.py',
  ), true)

  assert.throws(() => assertRuntimeArtifactExcludesNonRuntimeGisSources([
    'apps/server/dist/main.js',
    'python-packages/gis_meteorology/third_party/short_term_forecast/source/app.py',
  ]), /非运行时第三方来源快照/u)
  assert.doesNotThrow(() => assertRuntimeArtifactExcludesNonRuntimeGisSources([
    'packages/gis-meteorology/src/gis_meteorology/third_party/short_term_forecast/adapter.py',
    'python-packages/gis_meteorology/third_party/radar_mosaic_agent/source/radar_mosaic.py',
  ]))
})

test('verifier 拒绝 manifest 未声明的额外文件', () => {
  assert.doesNotThrow(() => assertArtifactFileSet(
    ['package.json', 'runtime-service-manifest.json'],
    ['package.json'],
  ))
  assert.throws(() => assertArtifactFileSet(
    ['package.json', 'runtime-service-manifest.json', 'injected.js'],
    ['package.json'],
  ), /未声明的文件.*injected\.js/u)
})

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runtime Service 平台运行时物化
//
//   文件:       platform-materialization.mjs
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { rebaseCopiedAbsoluteSymlinks } from './artifact-files.mjs'

const DARWIN_POSTGRES = Object.freeze({
  version: '16.15',
  postgisVersion: '3.4.6',
  appVersion: '2.9.6',
  url: 'https://github.com/PostgresApp/PostgresApp/releases/download/v2.9.6/Postgres-2.9.6-16.dmg',
  sha256: '2689dc64d6a02e0a66e4585616919060d8fbf5bb06886fccc05b7f87638bf081',
})
const DARWIN_UV = Object.freeze({
  version: '0.12.7',
  url: 'https://github.com/astral-sh/uv/releases/download/0.12.7/uv-aarch64-apple-darwin.tar.gz',
  sha256: '127ebdda7ad953cdf198e964b570ea5771b85467ea93eb7cb6d6f8e6f55408f3',
})
const DARWIN_PYTHON_VERSION = '3.12.14'

export async function materializeLinuxRuntime(artifactRoot) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('--materialize-linux 当前只支持 Linux x64 构建主机。')
  }

  await materializeNodeRuntime(artifactRoot)
  runRequired('npm', [
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ], { cwd: artifactRoot })

  const workerLock = await readFile(path.join(artifactRoot, 'apps', 'worker', 'uv.lock'), 'utf8')
  const requirementsPath = path.join(artifactRoot, 'python-private-requirements.lock')
  const privateRequirements = ['cfgrib', 'python-docx']
    .map(packageName => lockedPurePythonRequirement(workerLock, packageName))
  await writeFile(requirementsPath, `${privateRequirements.join('\n')}\n`, 'utf8')
  const privatePackagesRoot = path.join(artifactRoot, 'python-packages')
  runRequired('uv', [
    'pip',
    'install',
    '--python', '/usr/bin/python3',
    '--target', privatePackagesRoot,
    '--no-deps',
    '--require-hashes',
    '--requirements', requirementsPath,
  ], { cwd: artifactRoot, quiet: true })

  const pythonPath = [
    path.join(artifactRoot, 'apps', 'worker', 'src'),
    path.join(artifactRoot, 'packages', 'gis-meteorology', 'src'),
    privatePackagesRoot,
  ].join(path.delimiter)
  await runWorkerImportProbe('/usr/bin/python3', [
    '-c',
    [
      'from pathlib import Path',
      'root = Path("python-packages")',
      'files = list(root.rglob("*.py"))',
      'assert files',
      '[compile(file.read_bytes(), str(file), "exec") for file in files]',
      'import docx',
      'assert (root / "cfgrib" / "__init__.py").is_file()',
      'import worker_app.sidecar',
    ].join('; '),
  ], artifactRoot, pythonPath)
  runRequired(path.join(artifactRoot, 'node-runtime', 'bin', 'node'), [
    '--input-type=module',
    '--eval',
    "await import('sharp'); await import('@geo-agent-platform/operations-supervisor')",
  ], { cwd: path.join(artifactRoot, 'apps', 'server') })
  await writeFile(path.join(artifactRoot, 'linux-runtime-bundle.json'), `${JSON.stringify({
    schemaVersion: 1,
    platform: 'linux',
    architecture: 'x64',
    pythonRuntime: 'system',
    minimumPythonVersion: '3.11',
    privatePythonPackages: privateRequirements.map(value => value.split(' ')[0]),
    nodeRuntime: 'bundled',
    nodeVersion: process.version,
  }, null, 2)}\n`, 'utf8')
}

/**
 * macOS 桌面包必须在离线状态下拥有完整本机服务。构建机下载的第三方制品
 * 都固定版本并校验 SHA256；最终应用只携带运行文件，不在用户首次启动时联网。
 */
export async function materializeDarwinRuntime(repositoryRoot, artifactRoot) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('--materialize-darwin 当前只支持 macOS arm64 构建主机。')
  }

  await materializeNodeRuntime(artifactRoot)
  runRequired('npm', [
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ], { cwd: artifactRoot })

  const runtimeCache = path.join(
    repositoryRoot,
    'artifacts',
    'runtime-dependencies',
    'darwin-arm64',
  )
  await mkdir(runtimeCache, { recursive: true })
  const postgresDmg = path.join(runtimeCache, `Postgres-${DARWIN_POSTGRES.appVersion}-16.dmg`)
  await downloadVerified(DARWIN_POSTGRES.url, postgresDmg, DARWIN_POSTGRES.sha256)
  await materializeDarwinPostgres(repositoryRoot, artifactRoot, postgresDmg)

  const uvArchive = path.join(runtimeCache, `uv-${DARWIN_UV.version}.tar.gz`)
  await downloadVerified(DARWIN_UV.url, uvArchive, DARWIN_UV.sha256)
  const uvExecutable = path.join(
    runtimeCache,
    `uv-${DARWIN_UV.version}`,
    'uv-aarch64-apple-darwin',
    'uv',
  )
  if (!await isRegularFile(uvExecutable)) {
    const extractionRoot = path.dirname(path.dirname(uvExecutable))
    await rm(extractionRoot, { recursive: true, force: true })
    await mkdir(extractionRoot, { recursive: true })
    runRequired('tar', ['-xzf', uvArchive, '-C', extractionRoot], { cwd: repositoryRoot })
  }
  runRequired(uvExecutable, ['--version'], { cwd: repositoryRoot })

  const pythonInstallRoot = path.join(runtimeCache, 'python')
  runRequired(uvExecutable, [
    'python', 'install', DARWIN_PYTHON_VERSION,
    '--install-dir', pythonInstallRoot,
    '--no-bin',
    '--compile-bytecode',
  ], { cwd: repositoryRoot })
  const pythonSource = path.join(
    pythonInstallRoot,
    `cpython-${DARWIN_PYTHON_VERSION}-macos-aarch64-none`,
  )
  const pythonRoot = path.join(artifactRoot, 'python-runtime')
  await cp(pythonSource, pythonRoot, { recursive: true, dereference: false })
  await rebaseCopiedAbsoluteSymlinks(pythonSource, pythonRoot)
  const pythonExecutable = path.join(pythonRoot, 'bin', `python${pythonMinorVersion()}`)

  const workerBuildEnvironment = path.join(artifactRoot, '.worker-build-environment')
  await rm(workerBuildEnvironment, { recursive: true, force: true })
  runRequired(uvExecutable, [
    'sync',
    '--project', 'apps/worker',
    '--frozen',
    '--no-dev',
    '--no-editable',
    '--compile-bytecode',
    '--python', pythonExecutable,
  ], {
    cwd: artifactRoot,
    environment: { UV_PROJECT_ENVIRONMENT: workerBuildEnvironment },
  })
  const sitePackages = path.join(
    workerBuildEnvironment,
    'lib',
    `python${pythonMinorVersion()}`,
    'site-packages',
  )
  const pythonPackages = path.join(artifactRoot, 'python-packages')
  await cp(sitePackages, pythonPackages, { recursive: true, dereference: false })
  await rebaseCopiedAbsoluteSymlinks(sitePackages, pythonPackages)
  await rm(workerBuildEnvironment, { recursive: true, force: true })

  const pythonPath = [
    path.join(artifactRoot, 'apps', 'worker', 'src'),
    path.join(artifactRoot, 'packages', 'gis-meteorology', 'src'),
    pythonPackages,
  ].join(path.delimiter)
  await runWorkerImportProbe(pythonExecutable, [
    '-c',
    [
      'import fastapi, pydantic, uvicorn',
      'import numpy, pandas, rasterio, scipy, shapely, xarray',
      'import worker_app.sidecar',
    ].join('; '),
  ], artifactRoot, pythonPath)
  runRequired(path.join(artifactRoot, 'postgresql-portable', 'bin', 'postgres'), [
    '--version',
  ], { cwd: artifactRoot })
  runRequired(path.join(artifactRoot, 'node-runtime', 'bin', 'node'), [
    '--input-type=module',
    '--eval',
    "await import('sharp'); await import('@geo-agent-platform/operations-supervisor')",
  ], { cwd: path.join(artifactRoot, 'apps', 'server') })

  await writeFile(path.join(artifactRoot, 'darwin-runtime-bundle.json'), `${JSON.stringify({
    schemaVersion: 1,
    platform: 'darwin',
    architecture: 'arm64',
    nodeVersion: process.version,
    pythonVersion: DARWIN_PYTHON_VERSION,
    postgresVersion: DARWIN_POSTGRES.version,
    postgisVersion: DARWIN_POSTGRES.postgisVersion,
    sources: {
      postgresApp: DARWIN_POSTGRES.url,
      uv: DARWIN_UV.url,
    },
  }, null, 2)}\n`, 'utf8')
}

async function materializeDarwinPostgres(repositoryRoot, artifactRoot, imagePath) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-postgres-app-'))
  const mountPoint = path.join(temporaryRoot, 'mount')
  await mkdir(mountPoint)
  let mounted = false
  try {
    runRequired('hdiutil', [
      'attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, imagePath,
    ], { cwd: repositoryRoot, quiet: true })
    mounted = true
    const postgresSource = path.join(
      mountPoint,
      'Postgres.app',
      'Contents',
      'Versions',
      '16',
    )
    const postgresRoot = path.join(artifactRoot, 'postgresql-portable')
    await mkdir(postgresRoot, { recursive: true })
    for (const directory of ['bin', 'lib', 'share']) {
      await cp(path.join(postgresSource, directory), path.join(postgresRoot, directory), {
        recursive: true,
        dereference: false,
      })
    }
    await rebaseCopiedAbsoluteSymlinks(postgresSource, postgresRoot)
    await cp(
      path.join(mountPoint, 'Postgres.app', 'Contents', 'Resources', 'Credits.rtf'),
      path.join(postgresRoot, 'PostgresApp-Credits.rtf'),
    )
  } finally {
    if (mounted) {
      runRequired('hdiutil', ['detach', mountPoint], { cwd: repositoryRoot, quiet: true })
    }
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function downloadVerified(url, destination, expectedSha256) {
  if (await isRegularFile(destination)) {
    const currentHash = await sha256File(destination)
    if (currentHash === expectedSha256) return
    await rm(destination, { force: true })
  }
  await mkdir(path.dirname(destination), { recursive: true })
  const temporaryPath = `${destination}.${process.pid}.download`
  await rm(temporaryPath, { force: true })
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`运行时依赖下载失败：${url}（HTTP ${response.status}）`)
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
    )
    const actualSha256 = await sha256File(temporaryPath)
    if (actualSha256 !== expectedSha256) {
      throw new Error(`运行时依赖 SHA256 不匹配：${url}`)
    }
    await rename(temporaryPath, destination)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function materializeNodeRuntime(artifactRoot) {
  const major = Number(process.versions.node.split('.')[0])
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(`本机运行时发布必须由 Node 24+ 构建，当前为 ${process.version}。`)
  }
  const compatibilityProbe = spawnSync(process.execPath, [
    '-e',
    "const s=new Intl.Segmenter(undefined,{granularity:'grapheme'});if([...s.segment('中A')].length!==2)process.exit(2)",
  ], { encoding: 'utf8' })
  if (compatibilityProbe.error || compatibilityProbe.status !== 0) {
    throw new Error(`构建机 Node 的 Intl.Segmenter 不可用（${process.version}），拒绝生成运行时。`)
  }

  const destination = path.join(artifactRoot, 'node-runtime', 'bin', 'node')
  await mkdir(path.dirname(destination), { recursive: true })
  await copyFile(process.execPath, destination)
  await chmod(destination, 0o755)
  const version = spawnSync(destination, ['--version'], { encoding: 'utf8' })
  if (version.error || version.status !== 0 || version.stdout.trim() !== process.version) {
    throw new Error('复制后的 Node 运行时版本校验失败。')
  }
  await writeFile(path.join(artifactRoot, 'node-runtime-version.json'), `${JSON.stringify({
    schemaVersion: 1,
    version: process.version,
    platform: process.platform,
    arch: process.arch,
  }, null, 2)}\n`, 'utf8')
}

async function runWorkerImportProbe(executable, commandArguments, artifactRoot, pythonPath) {
  const probeRuntimeRoot = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-worker-probe-'))
  try {
    runRequired(executable, ['-B', ...commandArguments], {
      cwd: artifactRoot,
      environment: {
        PYTHONPATH: pythonPath,
        PYTHONDONTWRITEBYTECODE: '1',
        RUNTIME_ROOT: probeRuntimeRoot,
        WORKER_NONCE_STORE_PATH: path.join(probeRuntimeRoot, '.worker-nonces.sqlite3'),
        WORKER_CONCURRENCY_STORE_PATH: path.join(
          probeRuntimeRoot,
          '.worker-concurrency.sqlite3',
        ),
      },
    })
  } finally {
    await rm(probeRuntimeRoot, { recursive: true, force: true })
  }
}

function runRequired(file, commandArguments, options = {}) {
  const stdio = options.capture
    ? ['ignore', 'pipe', 'inherit']
    : (options.quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit')
  const result = spawnSync(file, commandArguments, {
    cwd: options.cwd,
    encoding: options.capture ? 'utf8' : undefined,
    env: { ...process.env, ...options.environment },
    stdio,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Runtime Service 依赖物化失败：${file} ${commandArguments.join(' ')}`)
  }
  return options.capture ? String(result.stdout) : ''
}

function lockedPurePythonRequirement(lockSource, packageName) {
  const marker = `[[package]]\nname = "${packageName}"`
  const start = lockSource.indexOf(marker)
  if (start < 0) throw new Error(`Worker uv.lock 缺少 ${packageName}。`)
  const next = lockSource.indexOf('[[package]]', start + marker.length)
  const block = lockSource.slice(start, next < 0 ? undefined : next)
  const version = /^version = "([^"]+)"$/mu.exec(block)?.[1]
  const wheel = /url = "[^"]+-py3-none-any\.whl", hash = "(sha256:[a-f0-9]{64})"/u.exec(block)
  if (!version || !wheel) {
    throw new Error(`Worker uv.lock 中的 ${packageName} 不是可私有携带的锁定纯 Python wheel。`)
  }
  return `${packageName}==${version} --hash=${wheel[1]}`
}

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

async function isRegularFile(filePath) {
  return (await stat(filePath).catch(() => null))?.isFile() === true
}

function pythonMinorVersion() {
  return DARWIN_PYTHON_VERSION.split('.').slice(0, 2).join('.')
}

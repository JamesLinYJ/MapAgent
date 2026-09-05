// +-------------------------------------------------------------------------
//
//   地理智能平台 - Linux RPM 本机运行时首次部署测试
//
//   文件:       packagedLocalRuntime.test.ts
//
//   日期:       2026年08月10日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdir,mkdtemp,readFile,rm,stat,writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'

import {
preparePackagedLocalRuntime,
readPackagedLocalRuntimeUserSettings,
updatePackagedLocalRuntimeUserSettings,
} from './packagedLocalRuntime.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { force: true, recursive: true })
  )))
})

describe('packaged local runtime', () => {
  it('creates private user configuration and starts the packaged service without Docker', async () => {
    const root = await createTemporaryDirectory()
    const resourcesPath = path.join(root, 'resources')
    const homeDirectory = path.join(root, 'home')
    await createBundledRuntime(resourcesPath, 'release-1')
    const commands: string[][] = []

    const resolution = await preparePackagedLocalRuntime({
      platform: 'linux',
      resourcesPath,
      homeDirectory,
      environment: {},
      ownerUid: process.getuid?.(),
      systemRuntimeManifestPath: path.join(root, 'missing-system-manifest.json'),
      isPortAvailable: async () => true,
      runSystemctl: async arguments_ => {
        commands.push([...arguments_])
        return arguments_.includes('is-active') ? 3 : 0
      },
    })

    expect(resolution).not.toBeNull()
    const environmentFile = resolution!.serviceEnvironmentFile
    const source = await readFile(environmentFile, 'utf8')
    expect(source).toContain('NODE_ENV="production"')
    expect(source).toContain('API_PORT="8000"')
    expect(source).toContain('WORKER_PORT="8012"')
    expect(source).toContain('POSTGIS_PORT="54321"')
    expect(source).toContain('WORKER_PYTHON="/usr/bin/python3"')
    expect(source).toContain(`PATH="${[
      path.join(resourcesPath, 'runtime-service', 'node-runtime', 'bin'),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(path.delimiter)}"`)
    expect(source).toContain('/python-packages')
    expect(source).toContain(`SEED_LAYERS_DIR="${path.join(
      resourcesPath,
      'runtime-service',
      'infra',
      'seeds',
      'layers',
    )}"`)
    expect(source).not.toContain('docker')
    expect((await stat(environmentFile)).mode & 0o777).toBe(0o600)
    expect((await stat(resolution!.runtimeManifestPath)).mode & 0o777).toBe(0o600)
    expect(commands).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'enable', 'geo-agent-platform-supervisor.service'],
      ['--user', 'is-active', '--quiet', 'geo-agent-platform-supervisor.service'],
      ['--user', 'start', 'geo-agent-platform-supervisor.service'],
    ])
  })

  it('preserves secrets and restarts an active service only when the packaged release changes', async () => {
    const root = await createTemporaryDirectory()
    const resourcesPath = path.join(root, 'resources')
    const homeDirectory = path.join(root, 'home')
    await createBundledRuntime(resourcesPath, 'release-1')
    const options = {
      platform: 'linux' as const,
      resourcesPath,
      homeDirectory,
      environment: {},
      ownerUid: process.getuid?.(),
      systemRuntimeManifestPath: path.join(root, 'missing-system-manifest.json'),
      isPortAvailable: async () => true,
    }
    const first = await preparePackagedLocalRuntime({
      ...options,
      runSystemctl: async arguments_ => arguments_.includes('is-active') ? 3 : 0,
    })
    const initialEnvironment = await readFile(first!.serviceEnvironmentFile, 'utf8')

    await createBundledRuntime(resourcesPath, 'release-2')
    const commands: string[][] = []
    const second = await preparePackagedLocalRuntime({
      ...options,
      runSystemctl: async arguments_ => {
        commands.push([...arguments_])
        return 0
      },
    })
    const updatedEnvironment = await readFile(second!.serviceEnvironmentFile, 'utf8')

    const secretLines = (source: string) => source.split('\n').filter(line => (
      line.startsWith('BETTER_AUTH_SECRET=') || line.startsWith('WORKER_SHARED_SECRET=')
    ))
    expect(secretLines(updatedEnvironment)).toEqual(secretLines(initialEnvironment))
    expect(updatedEnvironment).toContain('GEO_AGENT_PLATFORM_RELEASE_ID="release-2"')
    expect(commands.at(-1)).toEqual([
      '--user', 'restart', 'geo-agent-platform-supervisor.service',
    ])
  })

  it('removes legacy Provider and unknown system credentials from the protected service environment', async () => {
    const root = await createTemporaryDirectory()
    const resourcesPath = path.join(root, 'resources')
    const homeDirectory = path.join(root, 'home')
    await createBundledRuntime(resourcesPath, 'release-1')
    const options = {
      platform: 'linux' as const,
      resourcesPath,
      homeDirectory,
      environment: {},
      ownerUid: process.getuid?.(),
      systemRuntimeManifestPath: path.join(root, 'missing-system-manifest.json'),
      isPortAvailable: async () => true,
    }
    const first = await preparePackagedLocalRuntime({
      ...options,
      runSystemctl: async arguments_ => arguments_.includes('is-active') ? 3 : 0,
    })
    const original = await readFile(first!.serviceEnvironmentFile, 'utf8')
    await writeFile(first!.serviceEnvironmentFile, `${original}\nDEEPSEEK_API_KEY="legacy-provider-secret"\nUNRELATED_TOKEN="legacy-token"\nUNRELATED_OPTION="legacy-option"\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })

    await createBundledRuntime(resourcesPath, 'release-2')
    await preparePackagedLocalRuntime({
      ...options,
      runSystemctl: async () => 0,
    })

    const updated = await readFile(first!.serviceEnvironmentFile, 'utf8')
    expect(updated).not.toContain('DEEPSEEK_API_KEY=')
    expect(updated).not.toContain('UNRELATED_TOKEN=')
    expect(updated).not.toContain('UNRELATED_OPTION=')
    expect(updated).toContain('BETTER_AUTH_SECRET=')
    expect(updated).toContain('WORKER_SHARED_SECRET=')
  })

  it('keeps an administrator-provided system deployment authoritative', async () => {
    const root = await createTemporaryDirectory()
    const systemManifest = path.join(root, 'runtime-manifest.v1.json')
    await writeFile(systemManifest, '{}', 'utf8')
    const commands: string[][] = []

    await expect(preparePackagedLocalRuntime({
      platform: 'linux',
      resourcesPath: path.join(root, 'resources'),
      homeDirectory: path.join(root, 'home'),
      environment: {},
      systemRuntimeManifestPath: systemManifest,
      runSystemctl: async arguments_ => {
        commands.push([...arguments_])
        return 0
      },
    })).resolves.toBeNull()
    expect(commands).toEqual([])
  })

  it('stores a user-supplied Tianditu server key only in the protected runtime environment', async () => {
    const root = await createTemporaryDirectory()
    const resourcesPath = path.join(root, 'resources')
    const homeDirectory = path.join(root, 'home')
    await createBundledRuntime(resourcesPath, 'release-1')
    const resolution = await preparePackagedLocalRuntime({
      platform: 'linux',
      resourcesPath,
      homeDirectory,
      environment: {},
      ownerUid: process.getuid?.(),
      systemRuntimeManifestPath: path.join(root, 'missing-system-manifest.json'),
      isPortAvailable: async () => true,
      runSystemctl: async arguments_ => arguments_.includes('is-active') ? 3 : 0,
    })
    const commands: string[][] = []

    await expect(readPackagedLocalRuntimeUserSettings({
      serviceEnvironmentFile: resolution!.serviceEnvironmentFile,
      ownerUid: process.getuid?.(),
    })).resolves.toEqual({ tiandituConfigured: false })
    await expect(updatePackagedLocalRuntimeUserSettings({
      serviceEnvironmentFile: resolution!.serviceEnvironmentFile,
      ownerUid: process.getuid?.(),
      tiandituApiKey: 'server-key-fixture-1234',
      runSystemctl: async arguments_ => {
        commands.push([...arguments_])
        return 0
      },
    })).resolves.toEqual({ tiandituConfigured: true })

    const configuredSource = await readFile(resolution!.serviceEnvironmentFile, 'utf8')
    expect(configuredSource).toContain('TIANDITU_API_KEY="server-key-fixture-1234"')
    expect((await stat(resolution!.serviceEnvironmentFile)).mode & 0o777).toBe(0o600)
    expect(commands).toEqual([['--user', 'restart', 'geo-agent-platform-supervisor.service']])

    await expect(updatePackagedLocalRuntimeUserSettings({
      serviceEnvironmentFile: resolution!.serviceEnvironmentFile,
      ownerUid: process.getuid?.(),
      tiandituApiKey: 'server-key-fixture-1234',
      runSystemctl: async arguments_ => {
        commands.push([...arguments_])
        return 0
      },
    })).resolves.toEqual({ tiandituConfigured: true })
    await expect(updatePackagedLocalRuntimeUserSettings({
      serviceEnvironmentFile: resolution!.serviceEnvironmentFile,
      ownerUid: process.getuid?.(),
      runSystemctl: async arguments_ => {
        commands.push([...arguments_])
        return 0
      },
    })).resolves.toEqual({ tiandituConfigured: true })
    expect(commands).toHaveLength(1)

    await expect(updatePackagedLocalRuntimeUserSettings({
      serviceEnvironmentFile: resolution!.serviceEnvironmentFile,
      ownerUid: process.getuid?.(),
      clearTiandituApiKey: true,
      runSystemctl: async arguments_ => {
        commands.push([...arguments_])
        return 0
      },
    })).resolves.toEqual({ tiandituConfigured: false })
    const clearedSource = await readFile(resolution!.serviceEnvironmentFile, 'utf8')
    expect(clearedSource).not.toContain('TIANDITU_API_KEY=')
    expect((await stat(resolution!.serviceEnvironmentFile)).mode & 0o777).toBe(0o600)
    expect(commands).toEqual([
      ['--user', 'restart', 'geo-agent-platform-supervisor.service'],
      ['--user', 'restart', 'geo-agent-platform-supervisor.service'],
    ])
  })

  it('starts the bundled macOS service tree and exposes automatic local identity configuration', async () => {
    const root = await createTemporaryDirectory()
    const resourcesPath = path.join(root, 'resources')
    const homeDirectory = path.join(root, 'home')
    await createBundledRuntime(resourcesPath, 'release-macos', 'darwin')
    const commands: string[][] = []
    const daemonStarts: string[][] = []
    let statusCalls = 0

    const resolution = await preparePackagedLocalRuntime({
      platform: 'darwin',
      resourcesPath,
      homeDirectory,
      environment: { PATH: '/usr/bin:/bin' },
      ownerUid: process.getuid?.(),
      systemRuntimeManifestPath: path.join(root, 'missing-system-manifest.json'),
      isPortAvailable: async () => true,
      runSupervisorCommand: async input => {
        commands.push([...input.command])
        if (input.command[0] === 'status') {
          statusCalls += 1
          return statusCalls === 1 ? 1 : 0
        }
        return 0
      },
      spawnSupervisorDaemon: async input => {
        daemonStarts.push([...input.commonArguments])
      },
      delay: async () => undefined,
    })

    expect(resolution).not.toBeNull()
    const source = await readFile(resolution!.serviceEnvironmentFile, 'utf8')
    expect(source).toContain(`POSTGRES_BIN_DIR="${path.join(
      resourcesPath,
      'runtime-service',
      'postgresql-portable',
      'bin',
    )}"`)
    expect(source).toContain(`WORKER_PYTHON="${path.join(
      resourcesPath,
      'runtime-service',
      'python-runtime',
      'bin',
      'python3.12',
    )}"`)
    expect(source).toContain('PYTHONDONTWRITEBYTECODE="1"')
    expect(source).not.toContain('PYTHONPYCACHEPREFIX=')
    expect(source).toContain('APP_BASE_URL="http://127.0.0.1:8000"')
    expect(commands).toEqual([
      ['status', '--json'],
      ['status', '--json'],
      ['start', 'all', '--json'],
    ])
    expect(daemonStarts).toHaveLength(1)

    await resolution!.restartApiService()
    expect(commands.at(-1)).toEqual(['restart', 'api', '--json'])
    expect(resolution!.manifestProtection).toMatchObject({ platform: 'darwin' })
  })

  it('keeps the macOS service configuration stable across Finder and terminal PATH values', async () => {
    const root = await createTemporaryDirectory()
    const resourcesPath = path.join(root, 'resources')
    const homeDirectory = path.join(root, 'home')
    await createBundledRuntime(resourcesPath, 'release-macos', 'darwin')
    const originalPath = process.env.PATH
    const firstCommands: string[][] = []
    const secondCommands: string[][] = []

    try {
      process.env.PATH = '/finder/inherited/path'
      await preparePackagedLocalRuntime({
        platform: 'darwin',
        resourcesPath,
        homeDirectory,
        environment: { PATH: '/finder/inherited/path' },
        ownerUid: process.getuid?.(),
        systemRuntimeManifestPath: path.join(root, 'missing-system-manifest.json'),
        isPortAvailable: async () => true,
        runSupervisorCommand: async input => {
          firstCommands.push([...input.command])
          return 0
        },
      })

      process.env.PATH = '/terminal/inherited/path'
      await preparePackagedLocalRuntime({
        platform: 'darwin',
        resourcesPath,
        homeDirectory,
        environment: { PATH: '/terminal/inherited/path' },
        ownerUid: process.getuid?.(),
        systemRuntimeManifestPath: path.join(root, 'missing-system-manifest.json'),
        isPortAvailable: async () => true,
        runSupervisorCommand: async input => {
          secondCommands.push([...input.command])
          return 0
        },
      })
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }

    expect(firstCommands).toEqual([
      ['status', '--json'],
      ['start', 'all', '--json'],
    ])
    expect(secondCommands).toEqual([
      ['status', '--json'],
      ['start', 'all', '--json'],
    ])
    const source = await readFile(
      path.join(homeDirectory, 'Library', 'Application Support', 'geo-agent-platform', 'runtime.env'),
      'utf8',
    )
    expect(source).not.toContain('/finder/inherited/path')
    expect(source).not.toContain('/terminal/inherited/path')
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-packaged-runtime-'))
  temporaryDirectories.push(directory)
  return directory
}

async function createBundledRuntime(
  resourcesPath: string,
  releaseId: string,
  platform: 'darwin' | 'linux' = 'linux',
): Promise<void> {
  const projectRoot = path.join(resourcesPath, 'runtime-service')
  const files = [
    'apps/server/dist/main.js',
    'apps/operations-console/dist/installedCliEntry.js',
    'node-runtime/bin/node',
    'packages/operations-supervisor/dist/cli.js',
    'python-packages/cfgrib/__init__.py',
    'python-packages/docx/__init__.py',
    'infra/seeds/layers/catalog.json',
    'infra/seeds/layers/hangzhou_districts.geojson',
    'node_modules/.package-lock.json',
  ]
  if (platform === 'darwin') {
    files.push(
      'darwin-runtime-bundle.json',
      'python-runtime/bin/python3.12',
      'python-packages/fastapi/__init__.py',
      'postgresql-portable/bin/postgres',
      'postgresql-portable/bin/initdb',
      'postgresql-portable/bin/pg_ctl',
      'postgresql-portable/bin/pg_isready',
      'postgresql-portable/bin/psql',
      'postgresql-portable/bin/createdb',
      'postgresql-portable/share/postgresql/extension/postgis.control',
    )
  }
  for (const relativePath of files) {
    const filePath = path.join(projectRoot, relativePath)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, 'fixture\n', 'utf8')
  }
  await writeFile(path.join(projectRoot, 'runtime-service-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'geo-agent-runtime-service',
    releaseId,
    entries: [],
  }), 'utf8')
}

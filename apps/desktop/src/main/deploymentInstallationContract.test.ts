// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 与三服务生产安装契约测试
//
//   文件:       deploymentInstallationContract.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const deploymentManifestSchema = z.object({
  kind: z.literal('geo-agent-platform.desktop-runtime'),
  schemaVersion: z.literal(1),
  projectRoot: z.string().min(1),
  runtimeRoot: z.string().min(1),
  apiBaseUrl: z.string().url(),
  supervisorTokenFile: z.string().min(1),
  allowedEnvironmentOverrides: z.array(z.enum([
    'GEO_AGENT_PLATFORM_ROOT',
    'RUNTIME_ROOT',
    'APP_BASE_URL',
    'GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE',
  ])),
}).strict()

const repositoryRoot = path.resolve(process.cwd(), '..', '..')
const execFileAsync = promisify(execFile)

describe('production installation contract', () => {
  it('ships Windows and Linux examples with the same strict v1 fields', async () => {
    const windowsManifest = deploymentManifestSchema.parse(await readJson(
      'deploy/runtime/runtime-manifest.v1.windows.json.example',
    ))
    const linuxManifest = deploymentManifestSchema.parse(await readJson(
      'deploy/runtime/runtime-manifest.v1.linux.json.example',
    ))

    expect(path.win32.isAbsolute(windowsManifest.projectRoot)).toBe(true)
    expect(path.win32.isAbsolute(windowsManifest.runtimeRoot)).toBe(true)
    expect(isInside(
      path.win32,
      windowsManifest.runtimeRoot,
      windowsManifest.supervisorTokenFile,
    )).toBe(true)
    expect(path.posix.isAbsolute(linuxManifest.projectRoot)).toBe(true)
    expect(path.posix.isAbsolute(linuxManifest.runtimeRoot)).toBe(true)
    expect(isInside(
      path.posix,
      linuxManifest.runtimeRoot,
      linuxManifest.supervisorTokenFile,
    )).toBe(true)
    expect(windowsManifest.allowedEnvironmentOverrides).toEqual([])
    expect(linuxManifest.allowedEnvironmentOverrides).toEqual([])
  })

  it('protects the Windows manifest and token with an explicit non-inherited ACL', async () => {
    const installer = await readRepositoryFile('scripts/install-desktop-runtime-manifest.ps1')

    for (const securityBoundary of [
      "IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
      'SetAccessRuleProtection($true, $false)',
      '[Security.AccessControl.DirectorySecurity]::new()',
      "SecurityIdentifier]::new('S-1-5-18')",
      "SecurityIdentifier]::new('S-1-5-32-544')",
      'FileSystemRights]::FullControl',
      'FileSystemRights]::Modify',
      'FileSystemRights]::ReadAndExecute',
      'RandomNumberGenerator]::Fill',
      '[IO.File]::Move($TemporaryManifestPath, $ManifestPath, $true)',
      '[IO.File]::Move($TemporaryTokenPath, $SupervisorTokenFile, $true)',
      "Join-Path $PlatformConfigRoot 'runtime-manifest.v1.json'",
      '[Environment]::GetFolderPath(',
      "Join-Path $CommonApplicationData 'GeoAgentPlatform'",
      'Assert-PlatformOrdinaryPath',
      '$PreserveExistingSupervisorToken',
      'Set-PlatformProtectedFileAcl -LiteralPath $ServiceEnvironmentFile -AllowService',
      "Join-Path $PSScriptRoot 'validate-production-environment.mjs'",
    ]) {
      expect(installer, securityBoundary).toContain(securityBoundary)
    }
    expect(installer).toContain('SupervisorTokenFile 必须位于 RuntimeRoot 内部')
    expect(installer).toContain('[Text.UTF8Encoding]::new($false)')
  })

  it('installs the same protected manifest contract on Linux', async () => {
    const installer = await readRepositoryFile('scripts/install-desktop-runtime-manifest.sh')

    for (const securityBoundary of [
      'if ((EUID != 0))',
      "config_root='/etc/geo-agent-platform'",
      "manifest_path=\"$config_root/runtime-manifest.v1.json\"",
      'assert_no_links',
      "stat -c '%h'",
      "chmod 0600 \"$service_environment_file\"",
      "chmod 0640 \"$supervisor_token_file\"",
      '--preserve-existing-supervisor-token',
      'validate-production-environment.mjs',
      'allowedEnvironmentOverrides',
      'randomBytes(32).toString("base64url")',
      'mv -fT -- "$temporary_manifest" "$manifest_path"',
    ]) {
      expect(installer, securityBoundary).toContain(securityBoundary)
    }
  })

  it('uses a pinned, hash-verified modern NuGet binary for Squirrel packaging', async () => {
    const vendorPreparation = await readRepositoryFile('scripts/prepare-squirrel-vendor.ps1')

    expect(vendorPreparation).toContain("$NuGetVersion = '6.14.0'")
    expect(vendorPreparation).toContain('https://dist.nuget.org/win-x86-commandline/v$NuGetVersion/nuget.exe')
    expect(vendorPreparation).toContain(
      "$NuGetSha256 = '92DBED160DDEE0F64B901E907439E021211B428E57C089ECC12FC38DCC4BD9A5'",
    )
    expect(vendorPreparation).toContain('Get-FileHash -LiteralPath $NuGetPath -Algorithm SHA256')
    expect(vendorPreparation).toContain("Join-Path $DesktopRoot '.squirrel-vendor'")
    expect(vendorPreparation).toContain('[IO.Path]::GetRelativePath($SourceVendor, $SourceFile.FullName)')
    expect(vendorPreparation).toContain('Get-FileHash -LiteralPath $SourceFile.FullName -Algorithm SHA256')
  })

  it('keeps all server-required production fields and passes the token path to systemd', async () => {
    const environment = parseEnvironmentExample(await readRepositoryFile('deploy/env/supervisor.env.example'))
    for (const requiredName of [
      'GEO_AGENT_PLATFORM_ROOT',
      'RUNTIME_ROOT',
      'GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE',
      'API_HOST',
      'API_PORT',
      'DATABASE_URL',
      'WORKER_URL',
      'APP_BASE_URL',
      'BETTER_AUTH_URL',
      'BETTER_AUTH_SECRET',
      'WORKER_SHARED_SECRET',
      'ENABLED_TOOL_PROVIDERS',
    ]) {
      expect(environment.get(requiredName), requiredName).toBeTruthy()
    }

    const systemd = await readRepositoryFile('deploy/systemd/geo-agent-platform-supervisor.service')
    expect(systemd).toContain('--profile production --token-file "${GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE}"')
    expect(systemd).toContain('SupplementaryGroups=geo-agent-platform-ops')
  })

  it('validates a complete production environment against installation values', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-production-env-'))
    try {
      const projectRoot = path.join(directory, 'release')
      const runtimeRoot = path.join(directory, 'runtime')
      const supervisorTokenFile = path.join(runtimeRoot, 'secrets', 'supervisor.token')
      const environmentFile = path.join(directory, 'geo-agent-platform.env')
      const environment = [
        'NODE_ENV=production',
        `GEO_AGENT_PLATFORM_ROOT=${projectRoot}`,
        `RUNTIME_ROOT=${runtimeRoot}`,
        `GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE=${supervisorTokenFile}`,
        `GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE=${path.join(directory, 'local-root.secret')}`,
        'POSTGIS_PORT=5432',
        'WORKER_PORT=8012',
        'API_HOST=127.0.0.1',
        'API_PORT=8000',
        `WORKER_PYTHON=${path.join(directory, 'venv', process.platform === 'win32' ? 'python.exe' : 'bin/python')}`,
        'DATABASE_URL=postgresql://geo-agent-platform:secret@127.0.0.1:5432/geo-agent-platform',
        'WORKER_URL=http://127.0.0.1:8012',
        'APP_BASE_URL=http://127.0.0.1:8000',
        'BETTER_AUTH_URL=http://127.0.0.1:8000',
        `BETTER_AUTH_SECRET=${'a'.repeat(32)}`,
        `WORKER_SHARED_SECRET=${'b'.repeat(32)}`,
        'ENABLED_TOOL_PROVIDERS=geo-platform-spatial,geo-platform-meteorology',
        '',
      ].join('\n')
      await writeFile(environmentFile, environment, 'utf8')

      const result = await execFileAsync(process.execPath, [
        path.join(repositoryRoot, 'scripts', 'validate-production-environment.mjs'),
        '--file', environmentFile,
        '--project-root', projectRoot,
        '--runtime-root', runtimeRoot,
        '--supervisor-token-file', supervisorTokenFile,
        '--api-base-url', 'http://127.0.0.1:8000',
      ])
      expect(result.stdout).toContain('生产环境校验通过')
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readRepositoryFile(relativePath)) as unknown
}

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8')
}

function isInside(
  pathApi: Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'>,
  root: string,
  candidate: string,
): boolean {
  const relative = pathApi.relative(root, candidate)
  return relative.length > 0
    && !pathApi.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${pathApi.sep}`)
}

function parseEnvironmentExample(source: string): Map<string, string> {
  const entries = source.split(/\r?\n/u).flatMap(line => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return []
    const separator = trimmed.indexOf('=')
    if (separator <= 0) return []
    return [[trimmed.slice(0, separator), trimmed.slice(separator + 1)] as const]
  })
  return new Map(entries)
}

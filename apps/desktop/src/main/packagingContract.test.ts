// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 发布与安装契约测试
//
// --------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PLATFORM_DESKTOP_APPLICATION_ID,
  PLATFORM_DESKTOP_PROTOCOL_SCHEME,
  PLATFORM_MACHINE_ID,
  PRODUCT_CODENAME,
  PRODUCT_EXECUTABLE_BASENAME,
} from '@geo-agent-platform/shared-types/product-identity'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const packageSchema = z.object({
  version: z.string(),
  productName: z.string().optional(),
  engines: z.object({ node: z.string() }),
  scripts: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()).optional(),
})

describe('desktop packaging contract', () => {
  it('keeps versions aligned and exposes native build commands for every desktop OS', async () => {
    const desktopPackage = packageSchema.parse(JSON.parse(
      await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as unknown)
    const rootPackage = packageSchema.parse(JSON.parse(
      await readFile(path.resolve(process.cwd(), '..', '..', 'package.json'), 'utf8'),
    ) as unknown)

    expect(desktopPackage.version).toBe('0.1.5')
    expect(desktopPackage.version).toBe(rootPackage.version)
    expect(desktopPackage.productName).toBeUndefined()
    expect(desktopPackage.engines.node).toBe('^22.13.0 || >=24.0.0')
    expect(rootPackage.engines.node).toBe('^22.13.0 || >=24.0.0')
    expect(desktopPackage.scripts.package).toBe('npm run package:windows')
    expect(desktopPackage.scripts.make).toBe('npm run make:windows')
    expect(desktopPackage.scripts['make:windows']).toContain('prepare-squirrel-vendor.ps1')
    expect(desktopPackage.scripts['make:windows']).toContain('--platform win32 --arch x64')
    expect(desktopPackage.scripts['make:macos:x64']).toContain('--platform darwin --arch x64')
    expect(desktopPackage.scripts['make:macos:arm64']).toContain('--platform darwin --arch arm64')
    expect(desktopPackage.scripts['make:macos:arm64']).toContain('release:runtime:macos:arm64')
    expect(desktopPackage.scripts['package:macos:arm64']).toContain('verify:runtime')
    expect(desktopPackage.scripts['make:linux']).toContain('run release:runtime:linux')
    expect(desktopPackage.scripts['make:linux']).toContain('make:linux:from-runtime')
    expect(desktopPackage.scripts['make:linux:from-runtime']).toContain('run verify:runtime')
    expect(desktopPackage.scripts['make:linux:from-runtime']).toContain('--platform linux --arch x64')
    expect(desktopPackage.scripts['make:linux:rpm']).toContain('run release:runtime:linux')
    expect(desktopPackage.scripts['make:linux:rpm']).toContain('make:linux:rpm:from-runtime')
    expect(desktopPackage.scripts['make:linux:rpm:from-runtime']).toContain('--targets desktop-rpm')
    expect(rootPackage.scripts['test:release-pipeline']).toBe(
      'node --test scripts/release-pipeline.test.mjs',
    )
    expect(rootPackage.scripts['release:runtime:macos:arm64']).toContain('--materialize-darwin')
    expect(rootPackage.scripts['apply:repository-governance']).toBe(
      'node scripts/apply-repository-governance.mjs',
    )
    expect(desktopPackage.devDependencies?.['@electron-forge/maker-base']).toBe('7.11.2')
    expect(desktopPackage.devDependencies?.['electron-installer-redhat']).toBe('3.4.0')
    expect(desktopPackage.devDependencies?.['@electron-forge/maker-rpm']).toBeUndefined()
    expect(desktopPackage.devDependencies?.['@electron-forge/maker-zip']).toBeUndefined()

    const rootBuild = rootPackage.scripts['build:desktop']
    const workspaceOrder = [
      '@geo-agent-platform/shared-types',
      '@geo-agent-platform/conversation-presentation',
      '@geo-agent-platform/operations-supervisor',
      '@geo-agent-platform/desktop',
    ]
    let previousIndex = -1
    for (const workspace of workspaceOrder) {
      const currentIndex = rootBuild?.indexOf(workspace) ?? -1
      expect(currentIndex, workspace).toBeGreaterThan(previousIndex)
      previousIndex = currentIndex
    }
    expect((await readFile(path.resolve(process.cwd(), '..', '..', '.node-version'), 'utf8')).trim())
      .toBe('24.14.0')
  })

  it('uses one strict Forge boundary for Windows, macOS, and Linux outputs', async () => {
    const forgeSource = await readFile(path.resolve(process.cwd(), 'forge.config.mjs'), 'utf8')
    const makerSources = await Promise.all([
      'desktopAppImageMaker.mjs',
      'desktopDebMaker.mjs',
      'desktopDmgMaker.mjs',
      'desktopPackageOutput.mjs',
      'desktopPortablePayload.mjs',
      'desktopRpmMaker.mjs',
      'desktopSigningPolicy.mjs',
      'desktopTestBuildPolicy.mjs',
      'desktopZipMaker.mjs',
    ].map(file => readFile(path.resolve(process.cwd(), 'packaging', file), 'utf8')))
    const [
      appImageSource,
      debSource,
      dmgSource,
      outputSource,
      portableSource,
      rpmSource,
      signingSource,
      testBuildSource,
      zipSource,
    ] = makerSources

    for (const requiredMetadata of [
      'appBundleId: PLATFORM_DESKTOP_APPLICATION_ID',
      'executableName: PRODUCT_EXECUTABLE_BASENAME',
      'icon: packageIconPath',
      'OriginalFilename: executableFilename',
      'ProductName: PRODUCT_CODENAME',
      'name: `${PLATFORM_MACHINE_ID}_desktop`',
      'GEO_AGENT_PLATFORM_RELEASE_BUILD',
      'windowsSign: windowsSigningOptions',
      'osxSign: macosPackagingOptions.sign',
      'osxNotarize: macosPackagingOptions.notarize',
      'verifySignedPackageOutputs',
      'markTestPackageOutput',
      'markTestMakeArtifacts',
      "new DesktopZipMaker({}, ['win32', 'darwin', 'linux'])",
      'new DesktopDmgMaker({',
      'new DesktopAppImageMaker({',
      'new DesktopDebMaker({',
      'new DesktopRpmMaker({',
      'name: `${PLATFORM_TECHNICAL_ID}-desktop`',
      'bin: PRODUCT_EXECUTABLE_BASENAME',
      "categories: ['Science', 'Utility']",
      "'postgresql-server'",
      "'postgis'",
      "'python3 >= 3.11'",
      'extraResource:',
      'darwin-runtime-bundle.json',
      'remoteClientMarkerPath',
      'createDesktopPayloadContract(platform, architecture)',
      'payloadContract.mode === REMOTE_CLIENT_PAYLOAD_MODE',
      "schemes: [PLATFORM_DESKTOP_PROTOCOL_SCHEME]",
    ]) {
      expect(forgeSource, requiredMetadata).toContain(requiredMetadata)
    }
    expect(forgeSource).not.toContain('@electron-forge/maker-zip')
    expect(forgeSource).not.toContain('function resolveWindowsSigningOptions')
    expect(forgeSource).not.toContain('function writeTestBuildMarker')
    expect(forgeSource).not.toContain('function resolveMacApplication')
    expect(forgeSource).not.toContain("'postgresql-private-devel'")
    expect(forgeSource).not.toContain("'nodejs >=")

    expect(appImageSource).toContain('APPIMAGETOOL_PATH')
    expect(appImageSource).toContain('APPIMAGE_RUNTIME_PATH')
    expect(appImageSource).toContain("'--runtime-file'")
    expect(appImageSource).not.toContain('fetch(')
    expect(appImageSource).not.toContain('https://')
    expect(appImageSource).toContain('stageDesktopPayloadDirectory')
    expect(appImageSource).toContain("createDesktopPayloadContract('linux', 'x64')")
    expect(debSource).toContain("requiredExternalBinaries = ['dpkg-deb']")
    expect(debSource).toContain("'--root-owner-group'")
    expect(debSource).toContain("path.join(root, 'usr', 'lib', 'systemd', 'user')")
    expect(dmgSource).toContain("requiredExternalBinaries = ['hdiutil']")
    expect(dmgSource).toContain("'hdiutil', ['verify'")
    expect(dmgSource).toContain("runRequired('ditto', [appPath, stagedApp])")
    expect(dmgSource).toContain("createDesktopPayloadContract('darwin', arch)")
    expect(outputSource).toContain('resolveMacApplication')
    expect(outputSource).toContain('assertNonemptyPackageArtifact')
    expect(portableSource).toContain("REMOTE_CLIENT_MARKER_FILENAME = 'REMOTE-SERVICE-CLIENT.txt'")
    expect(portableSource).toContain("REMOTE_CLIENT_PAYLOAD_MODE = 'remote-client'")
    expect(portableSource).toContain("MANAGED_LOCAL_PAYLOAD_MODE = 'managed-local'")
    expect(portableSource).toContain("path.join(root, 'resources', 'runtime-service')")
    expect(portableSource).toContain('远程客户端载荷仍包含本机托管 Runtime Service')
    expect(rpmSource).toContain('class Rpm6CompatibleInstaller extends RedhatInstaller')
    expect(rpmSource).toContain('await installer.createPackage()')
    expect(signingSource).toContain('resolveWindowsSigningOptions')
    expect(signingSource).toContain('resolveMacosPackagingOptions')
    expect(signingSource).toContain('verifySignedPackageOutputs')
    expect(testBuildSource).toContain('markTestPackageOutput')
    expect(testBuildSource).toContain("'-UNSIGNED-TEST.$1'")
    expect(zipSource).toContain("defaultPlatforms = ['win32', 'darwin', 'linux']")
    expect(zipSource).toContain('new ZipArchive(')
    expect(zipSource).toContain('stageDesktopPayloadDirectory')
    expect(zipSource).toContain('createDesktopPayloadContract(targetPlatform, targetArch)')
    expect(zipSource).toContain("targetPlatform === 'linux' ? '-remote-client' : ''")
    expect(zipSource).not.toContain('fs.rmdir')

    expect(PLATFORM_DESKTOP_APPLICATION_ID).not.toContain(PRODUCT_CODENAME)
    expect(PLATFORM_DESKTOP_PROTOCOL_SCHEME).not.toContain(PRODUCT_CODENAME.toLowerCase())
    expect(PLATFORM_MACHINE_ID).not.toContain(PRODUCT_CODENAME.toLowerCase())
  })

  it('keeps unsigned verification artifacts separate from production signing inputs', async () => {
    const forgeSource = await readFile(path.resolve(process.cwd(), 'forge.config.mjs'), 'utf8')
    const signingSource = await readFile(
      path.resolve(process.cwd(), 'packaging', 'desktopSigningPolicy.mjs'),
      'utf8',
    )
    const testBuildSource = await readFile(
      path.resolve(process.cwd(), 'packaging', 'desktopTestBuildPolicy.mjs'),
      'utf8',
    )
    const windowsReleaseScript = await readFile(
      path.resolve(process.cwd(), '..', '..', 'scripts', 'make-desktop-release.ps1'),
      'utf8',
    )
    for (const boundary of [
      'WINDOWS_CERTIFICATE_FILE',
      'WINDOWS_CERTIFICATE_PASSWORD',
      'MACOS_SIGNING_IDENTITY',
      'APPLE_API_KEY',
      'APPLE_API_ISSUER',
      'verifySignedMacApplication',
      "'--verify'",
      "spctl', ['--assess'",
    ]) {
      expect(signingSource, boundary).toContain(boundary)
    }
    expect(signingSource).toContain("hostPlatform !== 'win32'")
    expect(signingSource).toContain("hostPlatform !== 'darwin'")
    expect(signingSource).toContain('Windows 生产发布必须配置签名证书。')
    expect(signingSource).toContain('macOS 生产发布必须配置签名与公证凭据。')
    expect(signingSource).toContain("codesign', ['--force', '--deep', '--sign', '-'")
    expect(testBuildSource).toContain('UNSIGNED-TEST-BUILD.txt')
    expect(forgeSource).not.toContain('WINDOWS_CERTIFICATE_PASSWORD')
    expect(forgeSource).not.toContain('APPLE_API_KEY')
    for (const boundary of [
      'WINDOWS_CERTIFICATE_FILE',
      'WINDOWS_CERTIFICATE_PASSWORD',
      "SetEnvironmentVariable('GEO_AGENT_PLATFORM_RELEASE_BUILD', '1', 'Process')",
      'Get-AuthenticodeSignature -LiteralPath $File',
      'SignatureStatus]::Valid',
      'UNSIGNED-TEST-BUILD.txt',
    ]) {
      expect(windowsReleaseScript, boundary).toContain(boundary)
    }
  })

  it('does not inspect signing credentials outside a matching production build', async () => {
    const signingModule = await import(pathToFileURL(
      path.resolve(process.cwd(), 'packaging', 'desktopSigningPolicy.mjs'),
    ).href) as {
      resolveMacosPackagingOptions: (
        environment: NodeJS.ProcessEnv,
        releaseBuild: boolean,
        hostPlatform: NodeJS.Platform,
      ) => { sign?: { identity: string }; notarize?: { appleApiKey: string } }
      resolveWindowsSigningOptions: (
        environment: NodeJS.ProcessEnv,
        releaseBuild: boolean,
        hostPlatform: NodeJS.Platform,
      ) => unknown
    }
    const guardedEnvironment = new Proxy<NodeJS.ProcessEnv>({}, {
      get(_target, property) {
        throw new Error(`测试构建不得读取签名字段：${String(property)}`)
      },
    })

    expect(signingModule.resolveWindowsSigningOptions(
      guardedEnvironment,
      false,
      'win32',
    )).toBeUndefined()
    expect(signingModule.resolveMacosPackagingOptions(
      guardedEnvironment,
      false,
      'darwin',
    )).toEqual({ sign: undefined, notarize: undefined })
    expect(signingModule.resolveWindowsSigningOptions(
      guardedEnvironment,
      true,
      'darwin',
    )).toBeUndefined()
    expect(signingModule.resolveMacosPackagingOptions(
      guardedEnvironment,
      true,
      'win32',
    )).toEqual({ sign: undefined, notarize: undefined })
    expect(() => signingModule.resolveMacosPackagingOptions({}, true, 'darwin'))
      .toThrow('macOS 生产发布必须配置签名与公证凭据。')

    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'geo-agent-platform-signing-'))
    try {
      const apiKeyFile = path.join(temporaryRoot, 'AuthKey.p8')
      await writeFile(apiKeyFile, 'test-only-key-file')
      const resolved = signingModule.resolveMacosPackagingOptions({
        APPLE_API_ISSUER: 'test-issuer',
        APPLE_API_KEY: apiKeyFile,
        MACOS_SIGNING_IDENTITY: 'Developer ID Application: Test',
      }, true, 'darwin')
      expect(resolved.sign?.identity).toBe('Developer ID Application: Test')
      expect(resolved.notarize?.appleApiKey).toBe(apiKeyFile)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('marks only distributable local-test artifacts', async () => {
    const testBuildModule = await import(pathToFileURL(
      path.resolve(process.cwd(), 'packaging', 'desktopTestBuildPolicy.mjs'),
    ).href) as {
      markTestMakeArtifacts: (results: Array<{
        artifacts: string[]
        platform: string
      }>) => Promise<Array<{ artifacts: string[]; platform: string }>>
      markTestPackageOutput: (outputPath: string, platform: string) => Promise<void>
    }
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'geo-agent-platform-test-build-'))
    try {
      const zipArtifact = path.join(temporaryRoot, 'desktop.zip')
      const metadataArtifact = path.join(temporaryRoot, 'metadata.json')
      await Promise.all([
        writeFile(zipArtifact, 'zip-fixture'),
        writeFile(metadataArtifact, '{}'),
      ])

      const [result] = await testBuildModule.markTestMakeArtifacts([{
        artifacts: [zipArtifact, metadataArtifact],
        platform: 'linux',
      }])
      expect(result?.artifacts).toEqual([
        path.join(temporaryRoot, 'desktop-UNSIGNED-TEST.zip'),
        metadataArtifact,
      ])
      expect(await lstat(zipArtifact).catch(() => null)).toBeNull()
      expect(await readFile(result?.artifacts[0] ?? '', 'utf8')).toBe('zip-fixture')

      await testBuildModule.markTestPackageOutput(temporaryRoot, 'linux')
      expect(await readFile(
        path.join(temporaryRoot, 'UNSIGNED-TEST-BUILD.txt'),
        'utf8',
      )).toContain(`${PRODUCT_CODENAME} UNSIGNED TEST BUILD`)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('packages a portable and ownership-bound macOS terminal launcher', async () => {
    const forgeSource = await readFile(path.resolve(process.cwd(), 'forge.config.mjs'), 'utf8')
    const resourceDirectory = path.resolve(
      process.cwd(),
      'packaging',
      'io.geoagentplatform.desktop-cli',
    )
    const launcherPath = path.join(resourceDirectory, 'geo-agent-platform')
    const [launcherSource, launcherStat] = await Promise.all([
      readFile(launcherPath, 'utf8'),
      lstat(launcherPath),
    ])

    expect(forgeSource).toContain("'./packaging/io.geoagentplatform.desktop-cli'")
    expect(forgeSource).toContain('return [runtimeServicePath, macosInstalledCliResourcePath]')
    expect(launcherStat.mode & 0o111).not.toBe(0)
    expect(launcherSource).toContain('runtime-service/node-runtime/bin/node')
    expect(launcherSource).toContain('apps/operations-console/dist/installedCliEntry.js')
    expect(launcherSource).toContain('exec /usr/bin/env -i')
    expect(launcherSource).not.toMatch(/OPENAI|DEEPSEEK|ANTHROPIC|GEMINI|API_KEY/u)
  })

  it('resolves the packaged runtime from a relocated symlink and drops provider credentials', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'geo-agent-platform-macos-cli-'))
    try {
      const resourcesDirectory = path.join(
        temporaryRoot,
        'Relocated App.app',
        'Contents',
        'Resources',
      )
      const cliDirectory = path.join(resourcesDirectory, 'io.geoagentplatform.desktop-cli')
      const nodeDirectory = path.join(resourcesDirectory, 'runtime-service', 'node-runtime', 'bin')
      const entryDirectory = path.join(
        resourcesDirectory,
        'runtime-service',
        'apps',
        'operations-console',
        'dist',
      )
      const commandDirectory = path.join(temporaryRoot, 'bin')
      await Promise.all([
        mkdir(cliDirectory, { recursive: true }),
        mkdir(nodeDirectory, { recursive: true }),
        mkdir(entryDirectory, { recursive: true }),
        mkdir(commandDirectory, { recursive: true }),
      ])
      const launcher = path.join(cliDirectory, 'geo-agent-platform')
      const fakeNode = path.join(nodeDirectory, 'node')
      const capture = path.join(nodeDirectory, 'capture.txt')
      await copyFile(
        path.resolve(process.cwd(), 'packaging', 'io.geoagentplatform.desktop-cli', 'geo-agent-platform'),
        launcher,
      )
      await writeFile(fakeNode, [
        '#!/bin/sh',
        `{ printf 'ARG:%s\\n' "$@"; /usr/bin/env; } > '${capture}'`,
        '',
      ].join('\n'))
      await writeFile(path.join(entryDirectory, 'installedCliEntry.js'), '// fixture\n')
      await Promise.all([chmod(launcher, 0o755), chmod(fakeNode, 0o755)])
      const command = path.join(commandDirectory, 'geo-agent-platform')
      await symlink(launcher, command)

      await runExecutable(command, ['agent', '--prompt', '空间 分析'], {
        COLORTERM: 'truecolor',
        DEEPSEEK_API_KEY: 'must-not-cross-launcher',
        HOME: temporaryRoot,
        LANG: 'zh_CN.UTF-8',
        PATH: '/attacker/path',
        TERM: 'xterm-256color',
      })

      const captured = await readFile(capture, 'utf8')
      expect(captured).toContain(
        '/Relocated App.app/Contents/Resources/runtime-service/apps/operations-console/dist/installedCliEntry.js',
      )
      expect(captured).toContain('ARG:agent')
      expect(captured).toContain('ARG:--prompt')
      expect(captured).toContain('ARG:空间 分析')
      expect(captured).toContain('PATH=/usr/bin:/bin:/usr/sbin:/sbin')
      expect(captured).toContain('COLORTERM=truecolor')
      expect(captured).not.toContain('NO_COLOR=')
      expect(captured).not.toContain('DEEPSEEK_API_KEY')
      expect(captured).not.toContain('must-not-cross-launcher')
      expect(captured).not.toContain('/attacker/path')

      await runExecutable(command, ['--help'], {
        FORCE_COLOR: '3',
        HOME: temporaryRoot,
        NO_COLOR: '',
        TERM: 'xterm-256color',
      })
      const noColorCaptured = await readFile(capture, 'utf8')
      expect(noColorCaptured).toContain('NO_COLOR=')
      expect(noColorCaptured).toContain('FORCE_COLOR=0')
      expect(noColorCaptured).not.toContain('FORCE_COLOR=3')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('creates a ZIP without the cross-zip compatibility path on every supported host', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'geo-agent-platform-zip-maker-'))
    try {
      const sourceDirectory = path.join(temporaryRoot, `${PRODUCT_EXECUTABLE_BASENAME}-linux-x64`)
      await mkdir(path.join(sourceDirectory, 'resources'), { recursive: true })
      await writeFile(path.join(sourceDirectory, PRODUCT_EXECUTABLE_BASENAME), 'desktop-fixture')
      await writeFile(path.join(sourceDirectory, 'resources', 'app.asar'), 'asar-fixture')
      const makerModule = await import(pathToFileURL(
        path.resolve(process.cwd(), 'packaging', 'desktopZipMaker.mjs'),
      ).href) as {
        DesktopZipMaker: new () => {
          platforms: string[]
          make: (options: {
            dir: string
            makeDir: string
            packageJSON: { version: string }
            targetArch: string
            targetPlatform: string
          }) => Promise<string[]>
        }
      }
      const maker = new makerModule.DesktopZipMaker()
      const artifacts = await maker.make({
        dir: sourceDirectory,
        makeDir: path.join(temporaryRoot, 'make'),
        packageJSON: { version: '0.1.0' },
        targetArch: 'x64',
        targetPlatform: 'linux',
      })

      expect(maker.platforms).toEqual(['win32', 'darwin', 'linux'])
      expect(artifacts).toHaveLength(1)
      const artifact = artifacts[0]
      if (!artifact) throw new Error('ZIP Maker 未返回构建产物。')
      expect(artifact).toBe(path.join(
        temporaryRoot,
        'make',
        'zip',
        'linux',
        'x64',
        `${PRODUCT_EXECUTABLE_BASENAME}-linux-x64-0.1.0-linux-x64-remote-client.zip`,
      ))
      const archive = await readFile(artifact)
      expect(archive.subarray(0, 4).toString('hex')).toBe('504b0304')
      expect(archive.length).toBeGreaterThan(100)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
  it('strips the systemd-only managed runtime from Linux portable payloads', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'geo-agent-platform-portable-'))
    try {
      const sourceDirectory = path.join(temporaryRoot, 'source')
      const destinationDirectory = path.join(temporaryRoot, 'portable')
      const runtimeDirectory = path.join(sourceDirectory, 'resources', 'runtime-service')
      await mkdir(runtimeDirectory, { recursive: true })
      await writeFile(path.join(sourceDirectory, PRODUCT_EXECUTABLE_BASENAME), 'desktop-fixture')
      await writeFile(
        path.join(runtimeDirectory, 'runtime-service-manifest.json'),
        '{"kind":"geo-agent-runtime-service"}\n',
      )

      const portableModule = await import(pathToFileURL(
        path.resolve(process.cwd(), 'packaging', 'desktopPortablePayload.mjs'),
      ).href) as {
        REMOTE_CLIENT_MARKER_FILENAME: string
        createDesktopPayloadContract: (
          platform: string,
          architecture: string,
        ) => { architecture: string; mode: string; platform: string }
        stageDesktopPayloadDirectory: (
          source: string,
          destination: string,
          contract: { architecture: string; mode: string; platform: string },
        ) => Promise<string>
      }
      await portableModule.stageDesktopPayloadDirectory(
        sourceDirectory,
        destinationDirectory,
        portableModule.createDesktopPayloadContract('linux', 'x64'),
      )

      expect(await lstat(path.join(
        destinationDirectory,
        'resources',
        'runtime-service',
      )).catch(() => null)).toBeNull()
      expect(await readFile(path.join(
        destinationDirectory,
        portableModule.REMOTE_CLIENT_MARKER_FILENAME,
      ), 'utf8')).toContain('does not install or start the local managed runtime')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('distinguishes managed-local macOS arm64 payloads from remote clients', async () => {
    const portableModule = await import(pathToFileURL(
      path.resolve(process.cwd(), 'packaging', 'desktopPortablePayload.mjs'),
    ).href) as {
      REMOTE_CLIENT_MARKER_FILENAME: string
      assertDesktopPayload: (
        directory: string,
        contract: { architecture: string; mode: string; platform: string },
      ) => Promise<void>
      createDesktopPayloadContract: (
        platform: string,
        architecture: string,
      ) => { architecture: string; mode: string; platform: string }
    }
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'geo-agent-platform-payload-mode-'))
    try {
      const managedApplication = path.join(temporaryRoot, 'Managed.app')
      const managedResources = path.join(managedApplication, 'Contents', 'Resources')
      const managedRuntime = path.join(managedResources, 'runtime-service')
      await mkdir(managedRuntime, { recursive: true })
      await writeFile(
        path.join(managedRuntime, 'runtime-service-manifest.json'),
        '{"kind":"geo-agent-runtime-service"}\n',
      )
      const managedContract = portableModule.createDesktopPayloadContract('darwin', 'arm64')
      expect(managedContract).toEqual({
        architecture: 'arm64',
        mode: 'managed-local',
        platform: 'darwin',
      })
      await expect(portableModule.assertDesktopPayload(
        managedApplication,
        managedContract,
      )).resolves.toBeUndefined()

      const remoteApplication = path.join(temporaryRoot, 'Remote.app')
      const remoteResources = path.join(remoteApplication, 'Contents', 'Resources')
      await mkdir(remoteResources, { recursive: true })
      await copyFile(
        path.resolve(process.cwd(), 'packaging', 'REMOTE-SERVICE-CLIENT.txt'),
        path.join(remoteResources, portableModule.REMOTE_CLIENT_MARKER_FILENAME),
      )
      const remoteContract = portableModule.createDesktopPayloadContract('darwin', 'x64')
      expect(remoteContract.mode).toBe('remote-client')
      await expect(portableModule.assertDesktopPayload(
        remoteApplication,
        remoteContract,
      )).resolves.toBeUndefined()

      await mkdir(path.join(remoteResources, 'runtime-service'))
      await expect(portableModule.assertDesktopPayload(
        remoteApplication,
        remoteContract,
      )).rejects.toThrow('远程客户端载荷仍包含本机托管 Runtime Service')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('ships native icon assets for Windows and Linux package metadata', async () => {
    const windowsIcon = await readFile(path.resolve(process.cwd(), 'assets', 'desktop.ico'))
    expect(windowsIcon.readUInt16LE(0)).toBe(0)
    expect(windowsIcon.readUInt16LE(2)).toBe(1)
    const entryCount = windowsIcon.readUInt16LE(4)
    expect(entryCount).toBe(7)
    const dimensions = Array.from({ length: entryCount }, (_, index) => {
      const offset = 6 + index * 16
      const width = windowsIcon.readUInt8(offset) || 256
      const height = windowsIcon.readUInt8(offset + 1) || 256
      return `${width}x${height}`
    })
    expect(dimensions).toEqual([
      '16x16', '24x24', '32x32', '48x48', '64x64', '128x128', '256x256',
    ])

    const linuxIcon = await readFile(path.resolve(process.cwd(), 'assets', 'desktop.png'))
    expect(linuxIcon.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(linuxIcon.readUInt32BE(16)).toBe(256)
    expect(linuxIcon.readUInt32BE(20)).toBe(256)
  })
})

function runExecutable(
  file: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, arguments_, { env: environment }, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

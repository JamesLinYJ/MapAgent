// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron Forge 桌面打包配置
//
//   文件:       forge.config.mjs
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-08-18):
//     说明: Windows、macOS、Linux 共用一个严格发布边界；生产标签构建必须
//           完成平台签名/公证，测试构建则显式写入 UNSIGNED-TEST 标记。
//
//   维护记录 (2026-08-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: macOS 测试标记写入后重新封装并校验外层 ad-hoc 签名。
// --------------------------------------------------------------------------

import { FuseV1Options, FuseVersion } from '@electron/fuses'
import {
  PLATFORM_DESKTOP_APPLICATION_ID,
  PLATFORM_DESKTOP_PROTOCOL_SCHEME,
  PLATFORM_MACHINE_ID,
  PLATFORM_TECHNICAL_ID,
  PRODUCT_CODENAME,
  PRODUCT_DESKTOP_NAME,
  PRODUCT_EXECUTABLE_BASENAME,
} from '@geo-agent-platform/shared-types/product-identity'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DesktopAppImageMaker } from './packaging/desktopAppImageMaker.mjs'
import { DesktopDebMaker } from './packaging/desktopDebMaker.mjs'
import { DesktopDmgMaker } from './packaging/desktopDmgMaker.mjs'
import {
  createDesktopPayloadContract,
  REMOTE_CLIENT_PAYLOAD_MODE,
} from './packaging/desktopPortablePayload.mjs'
import { DesktopRpmMaker } from './packaging/desktopRpmMaker.mjs'
import {
  resolveMacosPackagingOptions,
  resolveWindowsSigningOptions,
  verifySignedPackageOutputs,
} from './packaging/desktopSigningPolicy.mjs'
import {
  markTestMakeArtifacts,
  markTestPackageOutput,
} from './packaging/desktopTestBuildPolicy.mjs'
import { DesktopZipMaker } from './packaging/desktopZipMaker.mjs'

const squirrelVendorDirectory = fileURLToPath(new URL('./.squirrel-vendor', import.meta.url))
const windowsIconPath = fileURLToPath(new URL('./assets/desktop.ico', import.meta.url))
const linuxIconPath = fileURLToPath(new URL('./assets/desktop.png', import.meta.url))
const remoteClientMarkerPath = fileURLToPath(new URL(
  './packaging/REMOTE-SERVICE-CLIENT.txt',
  import.meta.url,
))
const macosInstalledCliResourcePath = fileURLToPath(new URL(
  './packaging/io.geoagentplatform.desktop-cli',
  import.meta.url,
))
const releaseBuild = process.env.GEO_AGENT_PLATFORM_RELEASE_BUILD?.trim() === '1'
const windowsSigningOptions = resolveWindowsSigningOptions(process.env, releaseBuild)
const macosPackagingOptions = resolveMacosPackagingOptions(process.env, releaseBuild)
const packageIconPath = resolvePackageIconPath(process.platform, process.env, releaseBuild)
const testBuild = !releaseBuild
const desktopVersion = JSON.parse(readFileSync(
  new URL('./package.json', import.meta.url),
  'utf8',
)).version
const executableFilename = `${PRODUCT_EXECUTABLE_BASENAME}.exe`
const setupFilename = `${PRODUCT_EXECUTABLE_BASENAME}-${desktopVersion}-Setup.exe`
const runtimeServicePath = fileURLToPath(new URL('../../artifacts/runtime-service', import.meta.url))
const targetArchitecture = resolveTargetArchitecture(process.argv, process.env)
const linuxSystemDependencies = [
  'bash',
  'postgresql',
  'postgresql-contrib',
  'postgis',
  'systemd',
  'python3 (>= 3.11)',
  'python3-attrs',
  'python3-click',
  'python3-fastapi',
  'python3-pydantic',
  'python3-uvicorn',
  'python3-contourpy',
  'python3-eccodes',
  'python3-geopandas',
  'python3-h5netcdf',
  'python3-h5py',
  'python3-matplotlib',
  'python3-netcdf4',
  'python3-numpy',
  'python3-openpyxl',
  'python3-pandas',
  'python3-pil',
  'python3-pyproj',
  'python3-rasterio',
  'python3-scipy',
  'python3-shapely',
  'python3-lxml',
  'python3-typing-extensions',
  'python3-xarray',
]

export default {
  outDir: 'release',
  packagerConfig: {
    appBundleId: PLATFORM_DESKTOP_APPLICATION_ID,
    appCategoryType: 'public.app-category.productivity',
    asar: true,
    executableName: PRODUCT_EXECUTABLE_BASENAME,
    icon: packageIconPath,
    extraResource: resolveExtraResources(process.platform, targetArchitecture),
    osxSign: macosPackagingOptions.sign,
    osxNotarize: macosPackagingOptions.notarize,
    usageDescription: {
      Microphone: `${PRODUCT_DESKTOP_NAME} 仅在用户主动启用语音输入时访问麦克风。`,
    },
    windowsSign: windowsSigningOptions,
    win32metadata: {
      CompanyName: 'Geo Agent Platform Contributors',
      FileDescription: PRODUCT_DESKTOP_NAME,
      InternalName: PRODUCT_EXECUTABLE_BASENAME,
      OriginalFilename: executableFilename,
      ProductName: PRODUCT_CODENAME,
    },
    // electron-vite bundles Main, Preload and Renderer into /out. Packaging an
    // allowlisted build tree avoids npm-workspace symlink traversal and keeps
    // source, tests and development dependencies out of the installed app.
    ignore: filePath => !isPackagedApplicationFile(filePath),
    protocols: [
      {
        name: `${PRODUCT_CODENAME} Desktop Protocol`,
        schemes: [PLATFORM_DESKTOP_PROTOCOL_SCHEME],
      },
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: `${PLATFORM_MACHINE_ID}_desktop`,
        authors: 'Geo Agent Platform Contributors',
        copyright: 'Copyright © Geo Agent Platform Contributors',
        description: PRODUCT_DESKTOP_NAME,
        exe: executableFilename,
        additionalFiles: testBuild
          ? [{ src: 'UNSIGNED-TEST-BUILD.txt', target: 'lib\\net45' }]
          : [],
        noMsi: true,
        setupIcon: windowsIconPath,
        setupExe: testBuild
          ? `${PRODUCT_EXECUTABLE_BASENAME}-${desktopVersion}-UNSIGNED-TEST-Setup.exe`
          : setupFilename,
        title: PRODUCT_CODENAME,
        vendorDirectory: squirrelVendorDirectory,
        windowsSign: windowsSigningOptions,
      },
    },
    new DesktopZipMaker({}, ['win32', 'darwin', 'linux']),
    new DesktopDmgMaker({
      options: {
        artifactBaseName: PRODUCT_EXECUTABLE_BASENAME,
        volumeName: PRODUCT_DESKTOP_NAME,
      },
    }, ['darwin']),
    new DesktopAppImageMaker({
      options: {
        artifactBaseName: PRODUCT_EXECUTABLE_BASENAME,
        packageName: `${PLATFORM_TECHNICAL_ID}-desktop`,
        bin: PRODUCT_EXECUTABLE_BASENAME,
        productName: PRODUCT_DESKTOP_NAME,
        genericName: '地理智能工作台',
        description: PRODUCT_DESKTOP_NAME,
        protocolScheme: PLATFORM_DESKTOP_PROTOCOL_SCHEME,
        categories: ['Science', 'Utility'],
        icon: linuxIconPath,
      },
    }, ['linux']),
    new DesktopDebMaker({
      options: {
        name: `${PLATFORM_TECHNICAL_ID}-desktop`,
        bin: PRODUCT_EXECUTABLE_BASENAME,
        productName: PRODUCT_DESKTOP_NAME,
        genericName: '地理智能工作台',
        description: PRODUCT_DESKTOP_NAME,
        longDescription: '本机地理空间分析、气象数据处理与智能体工作台',
        maintainer: 'Geo Agent Platform Contributors',
        protocolScheme: PLATFORM_DESKTOP_PROTOCOL_SCHEME,
        categories: ['Science', 'Utility'],
        icon: linuxIconPath,
        depends: linuxSystemDependencies,
      },
    }, ['linux']),
    new DesktopRpmMaker({
      options: {
        name: `${PLATFORM_TECHNICAL_ID}-desktop`,
        bin: PRODUCT_EXECUTABLE_BASENAME,
        productName: PRODUCT_DESKTOP_NAME,
        genericName: '地理智能工作台',
        description: PRODUCT_DESKTOP_NAME,
        productDescription: '本机地理空间分析、气象数据处理与智能体工作台',
        categories: ['Science', 'Utility'],
        icon: linuxIconPath,
        license: 'UNLICENSED',
        requires: [
          'bash',
          'postgresql-server',
          'postgresql-contrib',
          'postgis',
          'systemd',
          'python3 >= 3.11',
          'python3dist(attrs) >= 19.2',
          'python3dist(click)',
          'python3dist(fastapi) >= 0.115',
          'python3dist(pydantic) >= 2.10',
          'python3dist(uvicorn) >= 0.32',
          'python3dist(contourpy) >= 1.3',
          'python3dist(eccodes) >= 2.43',
          'python3dist(geopandas) >= 1.0',
          'python3dist(h5netcdf) >= 1.6',
          'python3dist(h5py) >= 3.12',
          'python3dist(matplotlib) >= 3.9',
          'python3dist(netcdf4) >= 1.7',
          'python3dist(numpy) >= 2.0',
          'python3dist(openpyxl) >= 3.1',
          'python3dist(pandas) >= 2.2',
          'python3dist(pillow) >= 11',
          'python3dist(pyproj) >= 3.7',
          'python3dist(rasterio) >= 1.4',
          'python3dist(scipy) >= 1.14',
          'python3dist(shapely) >= 2.0',
          'python3dist(lxml) >= 3.1',
          'python3dist(typing-extensions) >= 4.9',
          'python3dist(xarray) >= 2025.1',
        ],
      },
    }, ['linux']),
  ],
  hooks: {
    postPackage: async (_forgeConfig, packageResult) => {
      if (testBuild) {
        await Promise.all(packageResult.outputPaths.map(outputPath => markTestPackageOutput(
          outputPath,
          packageResult.platform,
        )))
        return
      }
      await verifySignedPackageOutputs({
        environment: process.env,
        executableFilename,
        outputPaths: packageResult.outputPaths,
        platform: packageResult.platform,
      })
    },
    postMake: async (_forgeConfig, makeResults) => {
      if (!testBuild) return makeResults
      return markTestMakeArtifacts(makeResults)
    },
  },
  plugins: [
    {
      name: '@electron-forge/plugin-fuses',
      config: {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        // 桌面认证 Cookie 仅存在 Main 内存中，Renderer/Electron Session 不持有
        // 认证 Cookie。关闭该 Fuse，避免 Chromium 为未使用的 Cookie 仓库访问
        // macOS Keychain、Windows DPAPI 或 Linux 密码存储。
        [FuseV1Options.EnableCookieEncryption]: false,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      },
    },
  ],
}

function isPackagedApplicationFile(filePath) {
  const normalized = filePath.replaceAll('\\', '/')
  return normalized === ''
    || normalized === '/'
    || normalized === '/package.json'
    || normalized === '/out'
    || normalized.startsWith('/out/')
}

function resolveExtraResources(platform, architecture) {
  if (platform === 'linux') return existsSync(runtimeServicePath) ? [runtimeServicePath] : []
  const payloadContract = createDesktopPayloadContract(platform, architecture)
  if (payloadContract.mode === REMOTE_CLIENT_PAYLOAD_MODE) return [remoteClientMarkerPath]
  const bundlePath = path.join(runtimeServicePath, 'darwin-runtime-bundle.json')
  if (!existsSync(bundlePath)) {
    throw new Error(
      'macOS arm64 打包前必须先运行 release:runtime:macos:arm64，禁止生成无法启动本机服务的空壳客户端。',
    )
  }
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'))
  if (bundle.platform !== 'darwin' || bundle.architecture !== 'arm64') {
    throw new Error('macOS Runtime Service 的平台或架构与 Electron 目标不一致。')
  }
  return [runtimeServicePath, macosInstalledCliResourcePath]
}

function resolveTargetArchitecture(arguments_, environment) {
  const inline = arguments_.find(value => value.startsWith('--arch='))?.slice('--arch='.length)
  if (inline) return inline
  const index = arguments_.indexOf('--arch')
  if (index >= 0 && arguments_[index + 1]) return arguments_[index + 1]
  return environment.npm_config_arch?.trim() || process.arch
}

function resolvePackageIconPath(platform, environment, isReleaseBuild) {
  if (platform === 'win32') return windowsIconPath
  if (platform === 'linux') return linuxIconPath
  if (platform === 'darwin') {
    const iconPath = environment.MACOS_ICON_PATH?.trim()
    if (!iconPath) {
      if (isReleaseBuild) {
        throw new Error('macOS 生产发布必须设置 MACOS_ICON_PATH，并指向存在的绝对 ICNS 文件。')
      }
      return undefined
    }
    if (!path.isAbsolute(iconPath) || !existsSync(iconPath)) {
      throw new Error('MACOS_ICON_PATH 必须指向存在的绝对 ICNS 文件。')
    }
    return iconPath
  }
  throw new Error(`不支持的桌面打包主机：${platform}`)
}

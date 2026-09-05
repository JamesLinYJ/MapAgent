// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runtime Service 制品契约
//
//   文件:       artifact-contract.mjs
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

export const RUNTIME_SERVICE_KIND = 'geo-agent-runtime-service'
export const RUNTIME_OUTPUT_MARKER = '.geo-agent-runtime-service-output.json'
export const RUNTIME_WORKSPACE_PATHS = Object.freeze([
  'apps/server',
  'apps/operations-console',
  'packages/db',
  'packages/shared-types',
  'packages/conversation-presentation',
  'packages/operations-supervisor',
])
const RUNTIME_ARTIFACT_TARGETS = Object.freeze(['generic', 'darwin', 'linux'])

/**
 * 生成器复制输入、校验器判断必需文件时共用同一份契约。
 * 目录输入显式列出能够证明运行链路完整的代表文件，避免两端维护平行清单。
 */
export const RUNTIME_ARTIFACT_INPUTS = Object.freeze([
  input('package.json', 'package.json', 'file'),
  input('package-lock.json', 'package-lock.json', 'file'),
  input('apps/server/dist', 'apps/server/dist', 'directory', ['apps/server/dist/main.js']),
  input('apps/server/package.json', 'apps/server/package.json', 'file'),
  input(
    'apps/operations-console/dist',
    'apps/operations-console/dist',
    'directory',
    ['apps/operations-console/dist/installedCliEntry.js'],
  ),
  input('apps/operations-console/package.json', 'apps/operations-console/package.json', 'file'),
  input('packages/db/dist', 'packages/db/dist', 'directory', ['packages/db/dist/index.js']),
  input('packages/db/package.json', 'packages/db/package.json', 'file'),
  input(
    'packages/conversation-presentation/dist',
    'packages/conversation-presentation/dist',
    'directory',
    ['packages/conversation-presentation/dist/index.js'],
  ),
  input(
    'packages/conversation-presentation/package.json',
    'packages/conversation-presentation/package.json',
    'file',
  ),
  input(
    'packages/operations-supervisor/dist',
    'packages/operations-supervisor/dist',
    'directory',
    ['packages/operations-supervisor/dist/cli.js'],
  ),
  input(
    'packages/operations-supervisor/package.json',
    'packages/operations-supervisor/package.json',
    'file',
  ),
  input(
    'packages/shared-types/dist',
    'packages/shared-types/dist',
    'directory',
    ['packages/shared-types/dist/index.js'],
  ),
  input('packages/shared-types/package.json', 'packages/shared-types/package.json', 'file'),
  input(
    'apps/worker/src',
    'apps/worker/src',
    'directory',
    ['apps/worker/src/worker_app/sidecar.py'],
  ),
  input('apps/worker/pyproject.toml', 'apps/worker/pyproject.toml', 'file'),
  input('apps/worker/uv.lock', 'apps/worker/uv.lock', 'file'),
  input('packages/gis-meteorology/pyproject.toml', 'packages/gis-meteorology/pyproject.toml', 'file'),
  input('packages/gis-meteorology/src', 'packages/gis-meteorology/src', 'directory'),
  input('infra/database/schema.sql', 'infra/database/schema.sql', 'file'),
  input('infra/seeds/layers', 'infra/seeds/layers', 'directory', [
    'infra/seeds/layers/catalog.json',
    'infra/seeds/layers/hangzhou_districts.geojson',
  ]),
  input('deploy', 'deploy', 'directory', [
    'deploy/systemd/geo-agent-platform-supervisor.service',
    'deploy/systemd/geo-agent-platform-supervisor.user.service',
    'deploy/bin/geo-agent-platform',
    'deploy/windows/GeoAgentPlatformSupervisor.xml.template',
  ]),
  input('scripts/run-worker.ps1', 'scripts/run-worker.ps1', 'file'),
  input('scripts/run-worker.sh', 'scripts/run-worker.sh', 'file'),
  input('scripts/run-windows-service.ps1', 'scripts/run-windows-service.ps1', 'file'),
])

const GENERATED_REQUIRED_PATHS = Object.freeze([
  RUNTIME_OUTPUT_MARKER,
  'runtime-service-sbom.spdx.json',
])

const WORKSPACE_DIST_PREFIXES = Object.freeze(
  RUNTIME_ARTIFACT_INPUTS
    .filter(specification => specification.source.endsWith('/dist'))
    .map(specification => `${specification.destination}/`),
)

const NON_RUNTIME_EXACT_PATHS = Object.freeze([
  '.node-version',
  'apps/server/dist/agent-runtime/approvals/approvalTestFixtures.js',
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
  'apps/worker/src/worker_app/catalog_cli.py',
  'packages/operations-supervisor/dist/devCli.js',
  'packages/operations-supervisor/dist/devLauncher.js',
])

const NON_RUNTIME_PATH_PREFIXES = Object.freeze([
  'python-packages/gis_meteorology',
  'python-packages/worker_app',
])

const LINUX_DEPLOY_PATHS = Object.freeze([
  'deploy/bin/geo-agent-platform',
  'deploy/systemd/geo-agent-platform-supervisor.user.service',
])

const NODE_RUNTIME_REQUIRED_PATHS = Object.freeze([
  'node-runtime/bin/node',
  'node-runtime-version.json',
  'node_modules/.package-lock.json',
  'node_modules/supports-color/package.json',
])

const LINUX_RUNTIME_REQUIRED_PATHS = Object.freeze([
  'python-private-requirements.lock',
  'python-packages/cfgrib/__init__.py',
  'python-packages/docx/__init__.py',
])

const DARWIN_RUNTIME_REQUIRED_PATHS = Object.freeze([
  'python-runtime/bin/python3.12',
  'python-packages/fastapi/__init__.py',
  'python-packages/pydantic/__init__.py',
  'python-packages/rasterio/__init__.py',
  'postgresql-portable/bin/postgres',
  'postgresql-portable/bin/initdb',
  'postgresql-portable/bin/pg_ctl',
  'postgresql-portable/bin/pg_isready',
  'postgresql-portable/bin/psql',
  'postgresql-portable/bin/createdb',
  'postgresql-portable/share/postgresql/extension/postgis.control',
  'postgresql-portable/PostgresApp-Credits.rtf',
])

const NON_RUNTIME_GIS_SOURCE_PREFIXES = Object.freeze([
  'gis_meteorology/third_party/radar_mosaic_agent/source/original',
  'gis_meteorology/third_party/rainfall_risk_map/source',
  'gis_meteorology/third_party/short_term_forecast/source',
])

export function runtimeArtifactTargetFor(options) {
  if (options.materializeDarwin) return 'darwin'
  if (options.materializeLinux) return 'linux'
  return 'generic'
}

export function runtimeArtifactInputsFor(target) {
  assertRuntimeArtifactTarget(target)
  return Object.freeze(RUNTIME_ARTIFACT_INPUTS
    .filter(specification => shouldIncludeRuntimeArtifactPath(specification.destination, target))
    .map(specification => Object.freeze({
      ...specification,
      requiredPaths: Object.freeze(specification.requiredPaths.filter(
        requiredPath => shouldIncludeRuntimeArtifactPath(requiredPath, target),
      )),
    })))
}

export function requiredRuntimeArtifactPaths(entryPaths) {
  const target = inferRuntimeArtifactTarget(entryPaths)
  const required = [
    ...GENERATED_REQUIRED_PATHS,
    ...runtimeArtifactInputsFor(target).flatMap(specification => specification.requiredPaths),
  ]
  const hasLinuxRuntime = entryPaths.has('linux-runtime-bundle.json')
  const hasDarwinRuntime = entryPaths.has('darwin-runtime-bundle.json')
  if (hasLinuxRuntime || hasDarwinRuntime) required.push(...NODE_RUNTIME_REQUIRED_PATHS)
  if (hasLinuxRuntime) required.push(...LINUX_RUNTIME_REQUIRED_PATHS)
  if (hasDarwinRuntime) required.push(...DARWIN_RUNTIME_REQUIRED_PATHS)
  return [...new Set(required)]
}

/** 运行制品只保留可执行代码、运行资源、包元数据和许可证。 */
export function shouldIncludeRuntimeArtifactPath(relativePath, target = 'generic') {
  assertRuntimeArtifactTarget(target)
  const normalized = normalizeArtifactPath(relativePath).replace(/\/$/u, '')
  if (!normalized) return true
  if (isMutableRuntimeStatePath(normalized)) return false

  if (target === 'darwin') {
    if (normalized === 'deploy' || normalized.startsWith('deploy/')) return false
    if (normalized === 'scripts/run-worker.ps1'
      || normalized === 'scripts/run-windows-service.ps1') return false
  }
  if (target === 'linux') {
    if (normalized === 'scripts/run-worker.ps1'
      || normalized === 'scripts/run-windows-service.ps1') return false
    if (normalized === 'deploy' || normalized.startsWith('deploy/')) {
      return LINUX_DEPLOY_PATHS.some(candidate => (
        candidate === normalized || candidate.startsWith(`${normalized}/`)
      ))
    }
  }

  if (NON_RUNTIME_EXACT_PATHS.includes(normalized)) return false
  if (NON_RUNTIME_PATH_PREFIXES.some(prefix => (
    normalized === prefix || normalized.startsWith(`${prefix}/`)
  ))) return false
  if (isFirstPartyPythonCachePath(normalized)) return false
  if (isFirstPartyPythonBuildMetadataPath(normalized)) return false
  if (WORKSPACE_DIST_PREFIXES.some(prefix => normalized.startsWith(prefix))
    && isBuildOnlyJavaScriptOutput(normalized)) return false
  return true
}

/** 构建探针不得把数据库、日志或缓存写进不可变发布制品。 */
export function assertRuntimeArtifactHasNoMutableState(paths) {
  const unexpected = [...paths]
    .map(normalizeArtifactPath)
    .filter(isMutableRuntimeStatePath)
    .sort()
  if (unexpected.length > 0) {
    throw new Error(`运行服务制品包含构建期运行状态：${unexpected.join('、')}`)
  }
}

/** 校验器据平台标记拒绝一方构建残留和其它平台的启动文件。 */
export function assertRuntimeArtifactMatchesTarget(paths) {
  const pathSet = new Set([...paths].map(normalizeArtifactPath))
  const target = inferRuntimeArtifactTarget(pathSet)
  const unexpected = [...pathSet]
    .filter(relativePath => !shouldIncludeRuntimeArtifactPath(relativePath, target))
    .sort()
  if (unexpected.length > 0) {
    throw new Error(`运行服务制品包含目标平台不需要的内容：${unexpected.join('、')}`)
  }
}

export function assertRuntimeWorkspaces(value, source) {
  if (!Array.isArray(value)
    || value.length !== RUNTIME_WORKSPACE_PATHS.length
    || value.some((entry, index) => entry !== RUNTIME_WORKSPACE_PATHS[index])) {
    throw new Error(`${source} 没有锁定 Runtime Service 的窄 workspace 集合。`)
  }
}

/**
 * 第三方来源快照只用于仓库内溯源。运行制品保留适配器实际调用的雷达算法，
 * 但不得携带旧 Flask 应用、原始界面或其中的环境凭据读取路径。
 */
export function shouldIncludeGisMeteorologyRuntimeSource(relativePath) {
  const normalized = normalizeArtifactPath(relativePath).replace(/\/$/u, '')
  if (!normalized) return true
  if (normalized === 'gis_meteorology.egg-info'
    || normalized.startsWith('gis_meteorology.egg-info/')) return false
  if (normalized.split('/').includes('__pycache__') || normalized.endsWith('.pyc')) return false
  return !isNonRuntimeGisSourcePath(normalized)
}

export function assertRuntimeArtifactExcludesNonRuntimeGisSources(paths) {
  for (const artifactPath of paths) {
    const relativePath = runtimeGisMeteorologyRelativePath(artifactPath)
    if (relativePath === null || !isNonRuntimeGisSourcePath(relativePath)) continue
    throw new Error(`运行服务制品包含非运行时第三方来源快照：${artifactPath}`)
  }
}

function input(source, destination, kind, requiredPaths = kind === 'file' ? [destination] : []) {
  return Object.freeze({
    source,
    destination,
    kind,
    requiredPaths: Object.freeze([...requiredPaths]),
  })
}

function inferRuntimeArtifactTarget(entryPaths) {
  if (entryPaths.has('darwin-runtime-bundle.json')
    && entryPaths.has('linux-runtime-bundle.json')) {
    throw new Error('Runtime Service 制品不能同时声明 macOS 与 Linux 运行时。')
  }
  if (entryPaths.has('darwin-runtime-bundle.json')) return 'darwin'
  if (entryPaths.has('linux-runtime-bundle.json')) return 'linux'
  return 'generic'
}

function assertRuntimeArtifactTarget(target) {
  if (!RUNTIME_ARTIFACT_TARGETS.includes(target)) {
    throw new Error(`未知 Runtime Service 制品目标：${String(target)}`)
  }
}

function isBuildOnlyJavaScriptOutput(relativePath) {
  return relativePath.endsWith('.d.ts')
    || relativePath.endsWith('.d.ts.map')
    || relativePath.endsWith('.js.map')
    || relativePath.endsWith('.cjs.map')
    || relativePath.endsWith('.mjs.map')
}

function isFirstPartyPythonCachePath(relativePath) {
  const isFirstPartyPython = relativePath.startsWith('apps/worker/src/')
    || relativePath.startsWith('packages/gis-meteorology/src/')
  return isFirstPartyPython && (
    relativePath.split('/').includes('__pycache__') || relativePath.endsWith('.pyc')
  )
}

function isFirstPartyPythonBuildMetadataPath(relativePath) {
  const isFirstPartyPython = relativePath.startsWith('apps/worker/src/')
    || relativePath.startsWith('packages/gis-meteorology/src/')
  return isFirstPartyPython && relativePath.split('/').some(segment => segment.endsWith('.egg-info'))
}

function isMutableRuntimeStatePath(relativePath) {
  if (relativePath === 'runtime' || relativePath.startsWith('runtime/')) return true
  if (relativePath === '.cache' || relativePath.startsWith('.cache/')) return true
  if (relativePath === 'cache' || relativePath.startsWith('cache/')) return true
  if (relativePath === 'logs' || relativePath.startsWith('logs/')) return true
  const basename = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  return /\.sqlite(?:3)?(?:-(?:shm|wal))?$/u.test(basename) || basename.endsWith('.log')
}

function isNonRuntimeGisSourcePath(relativePath) {
  const normalized = normalizeArtifactPath(relativePath).replace(/\/$/u, '')
  return NON_RUNTIME_GIS_SOURCE_PREFIXES.some(prefix => (
    normalized === prefix || normalized.startsWith(`${prefix}/`)
  ))
}

function runtimeGisMeteorologyRelativePath(artifactPath) {
  const normalized = normalizeArtifactPath(artifactPath)
  const roots = [
    'packages/gis-meteorology/src/',
    'packages/gis-meteorology/build/lib/',
    'python-packages/',
  ]
  for (const root of roots) {
    if (!normalized.startsWith(root)) continue
    const relativePath = normalized.slice(root.length)
    return relativePath.startsWith('gis_meteorology/') ? relativePath : null
  }
  return null
}

function normalizeArtifactPath(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/').replace(/^\.\//u, '') : ''
}

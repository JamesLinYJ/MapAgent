// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runtime Service npm 包契约
//
//   文件:       npm-packages.mjs
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { RUNTIME_WORKSPACE_PATHS } from './artifact-contract.mjs'

const RUNTIME_NPM_ROOTS = Object.freeze([
  '',
  ...RUNTIME_WORKSPACE_PATHS,
])

export function createRuntimeRootPackageManifest(source) {
  return omitUndefined({
    name: source.name,
    private: true,
    version: source.version,
    type: source.type,
    engines: source.engines,
    workspaces: [...RUNTIME_WORKSPACE_PATHS],
    scripts: {
      'start:api': 'node apps/server/dist/main.js',
    },
    dependencies: source.dependencies,
    overrides: source.overrides,
  })
}

export function createRuntimeWorkspacePackageManifest(source) {
  const manifest = structuredClone(source)
  delete manifest.devDependencies
  delete manifest.files
  delete manifest.scripts
  delete manifest.types
  delete manifest.typings
  if (manifest.bin && typeof manifest.bin === 'object') {
    manifest.bin = Object.fromEntries(
      Object.entries(manifest.bin).filter(([, target]) => (
        normalizeLockPath(target) !== 'dist/devCli.js'
      )),
    )
    if (Object.keys(manifest.bin).length === 0) delete manifest.bin
  }
  if (manifest.exports && typeof manifest.exports === 'object') {
    manifest.exports = stripTypeOnlyExportConditions(manifest.exports)
  }
  return manifest
}

/**
 * 保留根锁文件的已解析版本，只收窄 workspace 集合及根包元数据。
 * 多余的不可达 node_modules entry 不会进入安装或 SBOM 闭包。
 */
export function createRuntimePackageLock(sourceLock, runtimePackageManifest) {
  const lock = structuredClone(sourceLock)
  lock.name = runtimePackageManifest.name
  lock.version = runtimePackageManifest.version
  if (!lock.packages || typeof lock.packages !== 'object' || !lock.packages['']) {
    throw new Error('package-lock.json 缺少根 packages 记录。')
  }
  lock.packages[''] = omitUndefined({
    name: runtimePackageManifest.name,
    version: runtimePackageManifest.version,
    workspaces: [...RUNTIME_WORKSPACE_PATHS],
    dependencies: runtimePackageManifest.dependencies,
    engines: runtimePackageManifest.engines,
  })

  const runtimeWorkspaces = new Set(RUNTIME_WORKSPACE_PATHS)
  for (const workspacePath of sourceLock.packages[''].workspaces ?? []) {
    if (runtimeWorkspaces.has(workspacePath)) continue
    delete lock.packages[workspacePath]
    for (const [location, value] of Object.entries(lock.packages)) {
      if (value?.link === true && normalizeLockPath(value.resolved) === workspacePath) {
        delete lock.packages[location]
      }
    }
  }
  for (const workspacePath of RUNTIME_WORKSPACE_PATHS) {
    const workspace = lock.packages[workspacePath]
    if (!workspace || typeof workspace !== 'object') {
      throw new Error(`package-lock.json 缺少 Runtime Service workspace：${workspacePath}`)
    }
    lock.packages[workspacePath] = createRuntimeWorkspacePackageManifest(workspace)
  }
  const { locations } = collectNpmProductionGraph(lock)
  for (const [location, value] of Object.entries(lock.packages)) {
    if (value?.link === true && runtimeWorkspaces.has(normalizeLockPath(value.resolved))) {
      locations.add(normalizeLockPath(location))
    }
  }
  lock.packages = Object.fromEntries(
    Object.entries(lock.packages).filter(([location]) => locations.has(normalizeLockPath(location))),
  )
  return lock
}

/**
 * 从 npm lockfile v3 的实际解析树遍历 Server/Supervisor 生产依赖，
 * 不依赖大多数 node_modules entry 不存在的 `name` 字段。
 */
export function collectNpmProductionPackages(lock, roots = RUNTIME_NPM_ROOTS) {
  return collectNpmProductionGraph(lock, roots).components
}

function collectNpmProductionGraph(lock, roots = RUNTIME_NPM_ROOTS) {
  const packages = lock.packages
  if (!packages || typeof packages !== 'object') {
    throw new Error('package-lock.json 缺少 packages 映射。')
  }

  const queue = [...roots]
  const visited = new Set()
  const components = new Map()
  while (queue.length > 0) {
    const requestedLocation = normalizeLockPath(queue.shift())
    if (visited.has(requestedLocation)) continue
    visited.add(requestedLocation)
    const entry = packages[requestedLocation]
    if (!entry || typeof entry !== 'object') {
      throw new Error(`package-lock.json 缺少生产依赖节点：${requestedLocation || '<root>'}`)
    }
    if (entry.link === true) {
      const target = normalizeLockPath(entry.resolved)
      if (!target) throw new Error(`package-lock.json 链接节点缺少 resolved：${requestedLocation}`)
      queue.push(target)
      continue
    }

    if (typeof entry.version === 'string') {
      const name = typeof entry.name === 'string'
        ? entry.name
        : packageNameFromLockLocation(requestedLocation)
      if (!name) throw new Error(`无法从 package-lock 路径推导包名：${requestedLocation}`)
      const key = `${name}\u0000${entry.version}`
      const previous = components.get(key)
      components.set(key, {
        name,
        version: entry.version,
        resolved: previous?.resolved
          ?? (typeof entry.resolved === 'string' ? entry.resolved : null),
      })
    }

    enqueueDependencies(queue, packages, requestedLocation, entry.dependencies, false)
    enqueueDependencies(queue, packages, requestedLocation, entry.optionalDependencies, true)
    enqueuePeerDependencies(
      queue,
      packages,
      requestedLocation,
      entry.peerDependencies,
      entry.peerDependenciesMeta,
    )
  }

  return {
    components: [...components.values()].sort((left, right) => (
      `${left.name}\u0000${left.version}`.localeCompare(`${right.name}\u0000${right.version}`)
    )),
    locations: visited,
  }
}

function enqueueDependencies(queue, packages, location, dependencies, missingAllowed) {
  if (!dependencies || typeof dependencies !== 'object') return
  for (const dependencyName of Object.keys(dependencies)) {
    const resolved = resolveDependencyLocation(packages, location, dependencyName)
    if (resolved) queue.push(resolved)
    else if (!missingAllowed) {
      throw new Error(`package-lock.json 无法解析 ${location || '<root>'} -> ${dependencyName}`)
    }
  }
}

function enqueuePeerDependencies(queue, packages, location, dependencies, metadata) {
  if (!dependencies || typeof dependencies !== 'object') return
  for (const dependencyName of Object.keys(dependencies)) {
    if (metadata?.[dependencyName]?.optional === true) continue
    const resolved = resolveDependencyLocation(packages, location, dependencyName)
    if (!resolved) throw new Error(`package-lock.json 无法解析 ${location || '<root>'} -> ${dependencyName}`)
    queue.push(resolved)
  }
}

function resolveDependencyLocation(packages, location, dependencyName) {
  const segments = normalizeLockPath(location).split('/').filter(Boolean)
  const dependencySegments = dependencyName.split('/')
  for (let index = segments.length; index >= 0; index -= 1) {
    const candidate = [...segments.slice(0, index), 'node_modules', ...dependencySegments].join('/')
    if (packages[candidate]) return candidate
  }
  return null
}

function packageNameFromLockLocation(location) {
  const normalized = normalizeLockPath(location)
  if (!normalized) return null
  const marker = 'node_modules/'
  const markerIndex = normalized.lastIndexOf(marker)
  if (markerIndex < 0) return null
  const remainder = normalized.slice(markerIndex + marker.length)
  const segments = remainder.split('/')
  return segments[0]?.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : segments[0] ?? null
}

function normalizeLockPath(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/').replace(/^\.\//u, '') : ''
}

function stripTypeOnlyExportConditions(value) {
  if (Array.isArray(value)) return value.map(stripTypeOnlyExportConditions)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'types')
    .map(([key, entry]) => [key, stripTypeOnlyExportConditions(entry)]))
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

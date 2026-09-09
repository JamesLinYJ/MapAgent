import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), 'utf8'))
}

test('Better Auth packages share one exact version and one physical lockfile instance', async () => {
  const [rootPackage, desktopPackage, serverPackage, lock] = await Promise.all([
    readJson('package.json'),
    readJson('apps/desktop/package.json'),
    readJson('apps/server/package.json'),
    readJson('package-lock.json'),
  ])

  const version = rootPackage.dependencies?.['better-auth']
  assert.match(version, /^\d+\.\d+\.\d+$/u, 'better-auth must use an exact root version')
  assert.equal(rootPackage.dependencies?.['@better-auth/core'], version)
  assert.equal(rootPackage.dependencies?.['@better-auth/electron'], version)

  assert.equal(
    desktopPackage.devDependencies?.['better-auth'],
    undefined,
    'Desktop uses its Main-owned in-memory HTTP client and must not bundle Better Auth client storage',
  )
  assert.equal(
    desktopPackage.devDependencies?.['@better-auth/electron'],
    undefined,
    'Desktop must not bundle the Electron safeStorage adapter',
  )
  assert.equal(serverPackage.dependencies?.['better-auth'], version)
  assert.equal(serverPackage.dependencies?.['@better-auth/electron'], version)

  const packages = lock.packages
  assert.ok(packages && typeof packages === 'object', 'package-lock.json packages map is required')
  assert.equal(packages['']?.dependencies?.['better-auth'], version)
  assert.equal(packages['']?.dependencies?.['@better-auth/core'], version)
  assert.equal(packages['']?.dependencies?.['@better-auth/electron'], version)

  for (const packageName of ['better-auth', '@better-auth/core', '@better-auth/electron']) {
    const rootPath = `node_modules/${packageName}`
    assert.equal(packages[rootPath]?.version, version, `${packageName} must resolve at the root`)
    const physicalInstances = Object.keys(packages)
      .filter(lockPath => lockPath === rootPath || lockPath.endsWith(`/node_modules/${packageName}`))
      .sort()
    assert.deepEqual(
      physicalInstances,
      [rootPath],
      `${packageName} must not be duplicated under a workspace or transitive package`,
    )
  }
})

test('the scripts index names every maintained script', async () => {
  const scriptsRoot = path.join(projectRoot, 'scripts')
  const [entries, index] = await Promise.all([
    readdir(scriptsRoot, { withFileTypes: true }),
    readFile(path.join(scriptsRoot, 'README.md'), 'utf8'),
  ])

  const scriptNames = entries
    .filter(entry => entry.isFile() && isMaintainedScript(entry.name))
    .map(entry => entry.name)
    .sort()
  const indexedNames = [...index.matchAll(/^\| `([^`]+)` \|/gmu)]
    .map(match => match[1])
    .filter(name => name !== undefined)
    .sort()

  assert.deepEqual(
    indexedNames,
    scriptNames,
    'scripts/README.md first-column entries must exactly match maintained script files',
  )
})

function isMaintainedScript(name) {
  return ['.bat', '.cmd', '.cjs', '.js', '.mjs', '.ps1', '.py', '.sh', '.ts']
    .includes(path.extname(name))
}

// 2026-09-08 / OpenAI ChatGPT: platform-only makers must not prevent a clean
// Windows workspace install. RPM execution already has a lazy platform guard.
test('platform-specific RPM installer stays optional in the manifest and lockfile', async () => {
  const [desktop, lock] = await Promise.all([
    readJson('apps/desktop/package.json'),
    readJson('package-lock.json'),
  ])
  const installer = 'electron-installer-redhat'
  const version = desktop.optionalDependencies?.[installer]
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/u)
  assert.equal(desktop.dependencies?.[installer], undefined)
  assert.equal(desktop.devDependencies?.[installer], undefined)
  assert.equal(lock.packages['apps/desktop'].optionalDependencies?.[installer], version)
  assert.equal(lock.packages[`node_modules/${installer}`].version, version)
  assert.equal(lock.packages[`node_modules/${installer}`].optional, true)

  // Do not repair one direct declaration while leaving another required,
  // platform-restricted package to make `npm ci` fail on Windows.
  for (const [name, entry] of Object.entries(lock.packages)) {
    const platforms = entry.os
    if (!Array.isArray(platforms)) continue
    const allowed = platforms.filter(platform => !platform.startsWith('!'))
    const excludesWindows = platforms.includes('!win32')
      || (allowed.length > 0 && !allowed.includes('win32'))
    if (excludesWindows) assert.equal(entry.optional, true, `${name} must be optional on Windows`)
  }
})

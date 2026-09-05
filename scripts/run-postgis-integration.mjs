#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverRoot = path.join(root, 'apps', 'server')
const vitestRunner = path.join(serverRoot, 'scripts', 'run-vitest-with-env.mjs')
const testFile = 'src/db/postgis.integration.test.ts'
const childEnv = { ...process.env, RUN_POSTGIS_INTEGRATION: '1' }

// Fedora/RHEL 的 SELinux Enforcing 会拒绝普通 Ryuk 容器访问 bind-mounted
// 容器引擎 socket。Ryuk 本身已经持有该 socket；privileged 仅解除这层 LSM
// 阻断，使 Testcontainers 能清理由本次显式集成测试创建的临时资源。
if (childEnv.TESTCONTAINERS_RYUK_PRIVILEGED === undefined && isSelinuxEnforcing()) {
  childEnv.TESTCONTAINERS_RYUK_PRIVILEGED = 'true'
}

const child = spawn(process.execPath, [vitestRunner, 'run', testFile], {
  cwd: serverRoot,
  stdio: 'inherit',
  env: childEnv,
})

child.on('error', error => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
child.on('exit', code => process.exit(code ?? 1))

function isSelinuxEnforcing() {
  if (process.platform !== 'linux') return false
  try {
    return readFileSync('/sys/fs/selinux/enforce', 'utf8').trim() === '1'
  } catch {
    return false
  }
}

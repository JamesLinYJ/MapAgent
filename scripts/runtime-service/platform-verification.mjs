// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runtime Service 平台运行时验证
//
//   文件:       platform-verification.mjs
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function verifyBundledNode(artifactRoot) {
  const executable = path.join(artifactRoot, 'node-runtime', 'bin', 'node')
  const probe = spawnSync(executable, [
    '-e',
    "const major=+process.versions.node.split('.')[0];const s=new Intl.Segmenter(undefined,{granularity:'grapheme'});if(major<24||[...s.segment('中A')].length!==2)process.exit(2)",
  ], { encoding: 'utf8', timeout: 10_000 })
  if (probe.error || probe.status !== 0 || probe.signal) {
    throw new Error('运行服务内置 Node 24+ 兼容性探针失败。')
  }
}

export function verifyDarwinRuntime(artifactRoot) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('macOS arm64 Runtime Service 只能在同平台执行兼容性探针。')
  }
  const pythonExecutable = path.join(artifactRoot, 'python-runtime', 'bin', 'python3.12')
  const pythonPath = [
    path.join(artifactRoot, 'apps', 'worker', 'src'),
    path.join(artifactRoot, 'packages', 'gis-meteorology', 'src'),
    path.join(artifactRoot, 'python-packages'),
  ].join(path.delimiter)
  const probeRuntimeRoot = mkdtempSync(path.join(os.tmpdir(), 'geo-agent-worker-verify-'))
  let pythonProbe
  try {
    pythonProbe = spawnSync(pythonExecutable, [
      '-B',
      '-c',
      'import fastapi, pydantic, rasterio, worker_app.sidecar',
    ], {
      cwd: artifactRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
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
    rmSync(probeRuntimeRoot, { recursive: true, force: true })
  }
  if (pythonProbe.error || pythonProbe.status !== 0 || pythonProbe.signal) {
    throw new Error('运行服务内置 Python Worker 兼容性探针失败。')
  }
  const postgresProbe = spawnSync(
    path.join(artifactRoot, 'postgresql-portable', 'bin', 'postgres'),
    ['--version'],
    { encoding: 'utf8', timeout: 10_000 },
  )
  if (postgresProbe.error || postgresProbe.status !== 0 || postgresProbe.signal) {
    throw new Error('运行服务内置 PostgreSQL/PostGIS 兼容性探针失败。')
  }
}

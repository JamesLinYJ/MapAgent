#!/usr/bin/env node
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 统一开发启动器入口
//
//   文件:       devCli.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotEnv } from 'dotenv'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

import { parseDevLauncherCommand, runDevLauncher } from './devLauncher.js'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
loadDotEnv({ path: path.join(projectRoot, '.env'), quiet: true })

runDevLauncher(parseDevLauncherCommand(process.argv.slice(2)), {
  projectRoot,
  nodeExecutable: process.execPath,
}).then(code => {
  process.exitCode = code
}).catch(error => {
  process.stderr.write(
    `${PRODUCT_CODENAME} 开发启动失败：${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})

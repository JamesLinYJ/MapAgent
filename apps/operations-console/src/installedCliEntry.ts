#!/usr/bin/env node
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 安装版命令行入口
//
//   文件:       installedCliEntry.ts
//
//   日期:       2026年08月12日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

import { runInstalledCli } from './installedCli.js'

runInstalledCli(process.argv.slice(2)).then(
  exitCode => { process.exitCode = exitCode },
  error => {
    const message = error instanceof Error && error.message ? error.message : '未知错误。'
    process.stderr.write(`${PRODUCT_CODENAME} CLI 启动失败：${message.replace(/[\r\n]+/gu, ' ')}\n`)
    process.exitCode = 1
  },
)

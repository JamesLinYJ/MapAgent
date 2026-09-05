// +-------------------------------------------------------------------------
//
//   地理智能平台 - 跨语言工具契约校验
//
//   文件:       contractValidator.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// Node 启动时拉取 Python Worker 由 Pydantic 生成的 /tools/catalog。
// Worker schema 是内部 API 的事实源；TS 端验证 catalog 自洽、必需工具存在、
// 且每个 Worker 工具都有对应平台 ToolDef。任何不一致都硬失败。

import type { ToolRegistry } from '../framework/registry.js'
import { createHash } from 'node:crypto'
import { logger } from '../observability/logger.js'
import {
  fetchMeteorologyWorkerCatalog,
  REQUIRED_METEOROLOGY_WORKER_TOOLS,
  workerContractHash,
} from './meteorology/meteorologyWorkerClient.js'
import { stableJson } from '../framework/schema.js'

export interface ContractValidationReport {
  passed: boolean
  workerTools: string[]
  registryTools: string[]
  missingInRegistry: string[]
  missingInWorker: string[]
  errors: string[]
  workerContractDigest: string | null
}

export async function validateToolContracts(
  registry: ToolRegistry,
  workerUrl: string,
  workerSharedSecret: string,
): Promise<ContractValidationReport> {
  const registryTools = new Set(registry.list().map(t => t.name))
  const registryByName = new Map(registry.list().map(tool => [tool.name, tool]))
  const requiredWorkerTools = new Set<string>(REQUIRED_METEOROLOGY_WORKER_TOOLS)
  const report: ContractValidationReport = {
    passed: true,
    workerTools: [],
    registryTools: [...registryTools],
    missingInRegistry: [],
    missingInWorker: [],
    errors: [],
    workerContractDigest: null,
  }

  let catalog
  try {
    catalog = await fetchMeteorologyWorkerCatalog(workerUrl, workerSharedSecret)
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error))
    report.passed = false
    return report
  }
  report.workerTools = catalog.tools.map(tool => tool.toolName)
  report.workerContractDigest = `sha256:${createHash('sha256').update(stableJson(catalog)).digest('hex')}`
  const workerByName = new Map(catalog.tools.map(tool => [tool.toolName, tool]))

  for (const requiredName of REQUIRED_METEOROLOGY_WORKER_TOOLS) {
    if (!workerByName.has(requiredName)) {
      report.missingInWorker.push(requiredName)
      report.passed = false
    }
    if (!registryTools.has(requiredName)) {
      report.missingInRegistry.push(requiredName)
      report.passed = false
    }
  }

  for (const tool of catalog.tools) {
    if (!registryTools.has(tool.toolName)) {
      report.missingInRegistry.push(tool.toolName)
      report.passed = false
    }
    if (!requiredWorkerTools.has(tool.toolName)) {
      report.errors.push(`Worker catalog 暴露了未声明的工具 "${tool.toolName}"`)
      report.passed = false
    }
    if (tool.contract.toolName !== tool.toolName) {
      report.errors.push(`Worker 工具 "${tool.toolName}" 的 contract.toolName 不一致`)
      report.passed = false
    }
    if (tool.route !== `/tools/${tool.toolName}`) {
      report.errors.push(`Worker 工具 "${tool.toolName}" 的 route 不符合固定工具入口`)
      report.passed = false
    }
    if (tool.contract.providerId !== 'geo-platform-meteorology-worker') {
      report.errors.push(`Worker 工具 "${tool.toolName}" 的 providerId 不符合气象 Worker 契约`)
      report.passed = false
    }
    const registryTool = registryByName.get(tool.toolName)
    if (registryTool) {
      if (registryTool.isReadOnly !== tool.contract.readOnly) {
        report.errors.push(
          `工具 "${tool.toolName}" 的只读语义不一致（Node=${String(registryTool.isReadOnly)}，Worker=${String(tool.contract.readOnly)}）`,
        )
        report.passed = false
      }
      if (registryTool.isDestructive !== tool.contract.destructive) {
        report.errors.push(
          `工具 "${tool.toolName}" 的破坏性语义不一致（Node=${String(registryTool.isDestructive)}，Worker=${String(tool.contract.destructive)}）`,
        )
        report.passed = false
      }
    }
    if (tool.schemaHash !== workerContractHash(tool.contract)) {
      report.errors.push(`Worker 工具 "${tool.toolName}" schemaHash 与 Pydantic catalog 内容不一致`)
      report.passed = false
    }
  }

  if (!report.passed) {
    logger.error({ report }, '工具契约校验失败')
  } else {
    logger.info({ workerCount: catalog.tools.length, registryCount: registryTools.size }, '工具契约校验通过')
  }

  return report
}

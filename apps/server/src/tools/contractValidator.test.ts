// +-------------------------------------------------------------------------
//
//   地理智能平台 - Worker 契约校验测试
//
//   文件:       contractValidator.test.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolContractManifest, WorkerToolCatalog } from '@geo-agent-platform/shared-types'
import { parseEnv } from '../framework/env.js'
import { ToolRegistry } from '../framework/registry.js'
import { createMeteorologyProvider } from './meteorology/index.js'
import {
  REQUIRED_METEOROLOGY_WORKER_TOOLS,
  workerContractHash,
} from './meteorology/meteorologyWorkerClient.js'
import { validateToolContracts } from './contractValidator.js'

describe('validateToolContracts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('accepts a complete Pydantic-generated worker catalog', async () => {
    const registry = registryWithMeteorology()
    stubCatalog(fullCatalog())

    const report = await validateToolContracts(registry, 'http://worker-ok', 'secret')

    expect(report.passed).toBe(true)
    expect(report.errors).toEqual([])
  })

  it('rejects the old name-list catalog shape', async () => {
    const registry = registryWithMeteorology()
    stubRawCatalog({ tools: ['meteorological_inspect'], count: 1 })

    const report = await validateToolContracts(registry, 'http://worker-old', 'secret')

    expect(report.passed).toBe(false)
    expect(report.errors.join('\n')).toContain('Worker /tools/catalog 返回结构不符合共享协议')
  })

  it('rejects a catalog missing a required worker tool', async () => {
    const registry = registryWithMeteorology()
    const catalog = fullCatalog()
    catalog.tools = catalog.tools.filter(tool => tool.toolName !== 'meteorological_stats')
    catalog.count = catalog.tools.length
    stubCatalog(catalog)

    const report = await validateToolContracts(registry, 'http://worker-missing', 'secret')

    expect(report.passed).toBe(false)
    expect(report.missingInWorker).toContain('meteorological_stats')
  })

  it('rejects schema hash drift', async () => {
    const registry = registryWithMeteorology()
    const catalog = fullCatalog()
    catalog.tools[0].schemaHash = `sha256:${'0'.repeat(64)}`
    stubCatalog(catalog)

    const report = await validateToolContracts(registry, 'http://worker-drift', 'secret')

    expect(report.passed).toBe(false)
    expect(report.errors.join('\n')).toContain('catalog hash 不一致')
  })

  it('rejects Node and Worker read/write semantic drift', async () => {
    const registry = registryWithMeteorology()
    const catalog = fullCatalog()
    const reportTool = catalog.tools.find(tool => tool.toolName === 'meteorological_report')
    if (!reportTool) throw new Error('测试目录缺少 meteorological_report')
    reportTool.contract.readOnly = true
    reportTool.schemaHash = workerContractHash(reportTool.contract)
    stubCatalog(catalog)

    const report = await validateToolContracts(registry, 'http://worker-semantic-drift', 'secret')

    expect(report.passed).toBe(false)
    expect(report.errors.join('\n')).toContain('只读语义不一致')
  })
})

function registryWithMeteorology(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(createMeteorologyProvider(parseEnv({
    API_PORT: '8000',
    API_HOST: '127.0.0.1',
    DATABASE_URL: 'postgres://test:test@127.0.0.1/test',
    RUNTIME_ROOT: 'runtime',
    APP_BASE_URL: 'http://127.0.0.1:8000',
    BETTER_AUTH_URL: 'http://127.0.0.1:8000',
    BETTER_AUTH_SECRET: 'test_better_auth_secret_32_bytes__',
    WORKER_URL: 'http://worker.test',
    WORKER_SHARED_SECRET: 'test_worker_shared_secret_32_bytes',
    ENABLED_TOOL_PROVIDERS: 'geo-platform-meteorology',
  })))
  return registry
}

function fullCatalog(): WorkerToolCatalog {
  const tools = REQUIRED_METEOROLOGY_WORKER_TOOLS.map(toolName => {
    const contract: ToolContractManifest = {
      providerId: 'geo-platform-meteorology-worker',
      toolName,
      version: '0.1.0',
      parametersSchema: { type: 'object', additionalProperties: true },
      resultSchema: { type: 'object', additionalProperties: true },
      valueRefInputs: [],
      valueRefOutputs: [],
      readOnly: !['meteorological_report', 'meteorological_nowcast_report'].includes(toolName),
      destructive: false,
      timeoutSeconds: 300,
      displaySurfaces: [],
    }
    return {
      toolName,
      route: `/tools/${toolName}`,
      contract,
      schemaHash: workerContractHash(contract),
    }
  })
  return { tools, count: tools.length }
}

function stubCatalog(catalog: WorkerToolCatalog): void {
  stubRawCatalog(catalog)
}

function stubRawCatalog(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })))
}

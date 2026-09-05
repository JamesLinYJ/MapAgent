// +-------------------------------------------------------------------------
//
//   地理智能平台 - MCP runtime manager 测试
//
//   文件:       McpRuntimeManager.test.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { defaultRuntimeConfig } from '../../agent/defaultRuntimeConfig.js'
import { McpRuntimeManager } from './McpRuntimeManager.js'

describe('McpRuntimeManager', () => {
  it('refreshes a dirty scope only at the next capture and keeps the old binding immutable', () => {
    const manager = new McpRuntimeManager()
    const config = mcpConfig()
    const first = manager.capture('workspace_1', bindingInput(config))
    const unchanged = manager.capture('workspace_1', bindingInput(config))

    expect(unchanged).toBe(first)
    expect(first.refreshReasons).toEqual(['initial'])

    manager.markDirty('workspace_1', 'auth')
    const rotated = manager.capture('workspace_1', bindingInput(config))

    expect(rotated.bindingId).not.toBe(first.bindingId)
    expect(rotated.catalogRevision).toBe(2)
    expect(rotated.refreshReasons).toEqual(['auth'])
    expect(first.catalogRevision).toBe(1)
    expect(Object.isFrozen(first.servers)).toBe(true)
  })

  it('marks config, capability roots and catalog changes independently', () => {
    const manager = new McpRuntimeManager()
    const config = mcpConfig()
    const first = manager.capture('workspace_1', bindingInput(config))
    const changedConfig = structuredClone(config)
    changedConfig.servers[0]!.timeoutMs = 2_000
    const second = manager.capture('workspace_1', {
      ...bindingInput(changedConfig),
      capabilityRoots: ['workspace:read'],
      toolServers: new Map([['docs_lookup', 'docs']]),
    })

    expect(second.catalogRevision).toBe(first.catalogRevision + 1)
    expect(second.refreshReasons).toEqual(['config', 'capability_roots', 'catalog'])
  })

  it('closes only connection leases owned by the exact binding', async () => {
    const manager = new McpRuntimeManager()
    const config = mcpConfig()
    const first = manager.capture('workspace_1', bindingInput(config))
    manager.markDirty('workspace_1')
    const second = manager.capture('workspace_1', bindingInput(config))
    const closed: string[] = []
    const closeFirst = manager.bindClose(first.bindingId, async () => { closed.push('first') })
    const closeSecond = manager.bindClose(second.bindingId, async () => { closed.push('second') })

    await closeFirst()
    await closeFirst()
    expect(closed).toEqual(['first'])
    await closeSecond()
    expect(closed).toEqual(['first', 'second'])
  })
})

function mcpConfig() {
  const config = defaultRuntimeConfig().sdk.mcp
  config.enabled = true
  config.servers = [{
    enabled: true,
    name: 'docs',
    description: 'docs',
    transport: 'streamable_http',
    executionMode: 'function_tools',
    url: 'https://example.test/mcp',
    command: null,
    args: [],
    cwd: null,
    env: {},
    headers: {},
    allowedTools: [],
    blockedTools: [],
    includeServerInToolNames: true,
    convertSchemasToStrict: true,
    cacheToolsList: true,
    useStructuredContent: true,
    approval: 'always',
    timeoutMs: 1_000,
  }]
  return config
}

function bindingInput(config: ReturnType<typeof mcpConfig>) {
  return {
    config,
    activeServerNames: ['docs'],
    toolServers: new Map([['docs_search', 'docs']]),
    resourceUris: new Map([['docs', ['mcp://docs/index']]]),
    capabilityRoots: [],
  }
}

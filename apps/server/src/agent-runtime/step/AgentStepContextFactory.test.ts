// +-------------------------------------------------------------------------
//
//   地理智能平台 - 不可变 StepContext 工厂测试
//
//   文件:       AgentStepContextFactory.test.ts
//
//   日期:       2026年08月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  AgentStepContext,
  AgentToolPlanEntry,
  AgentToolPlanSnapshot,
} from '@geo-agent-platform/shared-types/agent-step-context'
import {
  createGeoWorldDiff,
  geoWorldStateSchema,
  type GeoWorldState,
} from '@geo-agent-platform/shared-types/geo-world'
import type { AgentRuntimeConfig } from '@geo-agent-platform/shared-types/runtime'
import {
  CONTEXT_WINDOW_SCHEMA_VERSION,
  type ContextWindow,
} from '@geo-agent-platform/shared-types/context-window'
import { describe, expect, it } from 'vitest'

import { defaultRuntimeConfig } from '../../agent/defaultRuntimeConfig.js'
import { runtimeConfigDigest } from '../../agent/agentsRuntimeMetadata.js'
import { agentContextDigest } from './agentContextDigest.js'
import {
  AgentStepContextFactory,
  type CaptureAgentStepContextInput,
} from './AgentStepContextFactory.js'
import type { ContextWindowStore } from '../context/ContextWindowStore.js'

describe('AgentStepContextFactory', () => {
  it('keeps one request immutable and advances GeoWorld only for the next capability plan', async () => {
    const contexts: AgentStepContext[] = []
    let requestIndex = 0
    let world: { state: GeoWorldState; stateDigest: string } | null = null
    const factory = new AgentStepContextFactory(
      {
        appendNext: async (_runId, build) => {
          const context = build(++requestIndex)
          contexts.push(context)
          return context
        },
        get: async stepId => contexts.find(context => context.identity.stepId === stepId) ?? null,
      },
      {
        get: async () => world,
        ensureBaseline: async (_runId, baseline) => {
          world = snapshot(baseline)
          return world
        },
        applyPatches: async ({ runId, patches }) => {
          if (!world) throw new Error('测试 GeoWorld 尚未建立')
          const changed = createGeoWorldDiff({
            diffId: `world_diff_${world.state.revision}`,
            runId,
            current: world.state,
            patches,
            createdAt: '2026-08-21T01:00:00.000Z',
          })
          world = snapshot(changed.state)
          return { snapshot: world }
        },
      },
      {
        build: async (_runId, capabilities) => worldState(capabilities),
      },
      inMemoryContextWindows(),
    )
    const config = runtimeConfigWithMcp()
    const initialPlan = toolPlan([
      toolEntry('list_layers', 'platform'),
      toolEntry('north_search', 'mcp'),
      toolEntry('south_search', 'mcp'),
    ])
    const base: CaptureAgentStepContextInput = {
      ...captureInput(config, initialPlan),
      activeSkills: ['crs-audit'],
      mcpBinding: {
        bindingId: 'mcp_binding_exact_1',
        catalogRevision: 7,
        configDigest: 'sha256:mcp-config',
        authDigest: 'sha256:mcp-auth',
        capabilityRootDigest: 'sha256:mcp-roots',
        toolCatalogDigest: 'sha256:mcp-tools',
        resourceCatalogDigest: 'sha256:mcp-resources',
        refreshReasons: ['auth'],
        servers: [
          {
            name: 'north', transport: 'streamable_http', approval: 'always',
            configDigest: 'sha256:north-config', authDigest: 'sha256:north-auth',
            toolNames: ['north_search'], resourceUris: ['mcp://north/index'],
          },
          {
            name: 'south', transport: 'streamable_http', approval: 'always',
            configDigest: 'sha256:south-config', authDigest: 'sha256:south-auth',
            toolNames: ['south_search'], resourceUris: [],
          },
        ],
      },
      skillInvocations: [{
        invocationId: 'skill_invocation_crs',
        skillId: 'crs-audit',
        name: 'CRS 审计',
        version: '1.0.0',
        source: { kind: 'builtin', label: '平台内置 / crs-audit' },
        contentDigest: 'sha256:crs',
        trustStatus: 'builtin',
        requiredCapabilities: ['layer-metadata'],
        mode: 'explicit',
        reason: '用户显式指定。',
      }],
      pluginSnapshot: {
        pluginIds: ['quality-pack'],
        catalogDigest: 'sha256:plugins',
        bindings: [{
          pluginId: 'quality-pack',
          version: '1.0.0',
          source: 'platform:quality-pack',
          contentDigest: 'sha256:plugin',
          toolNames: ['list_layers'],
          mcpServerNames: ['north'],
          skillIds: ['crs-audit'],
          hookIds: [],
          writableRoots: [],
        }],
      },
    }

    const first = await factory.capture(base)
    const second = await factory.capture(base)
    const expandedPlan = toolPlan([
      ...initialPlan.entries,
      toolEntry('query_layer', 'platform'),
    ])
    const third = await factory.capture({ ...base, toolPlan: expandedPlan })

    expect(first.identity.modelRequestIndex).toBe(1)
    expect(second.identity.modelRequestIndex).toBe(2)
    expect(first.worldRevision).toBe(1)
    expect(second.worldRevision).toBe(1)
    expect(third.worldRevision).toBe(2)
    expect(second.contextWindowId).toBe(first.contextWindowId)
    expect(third.contextWindowId).toBe(first.contextWindowId)
    expect(first.tools.entries.map(entry => entry.name)).toEqual([
      'list_layers',
      'north_search',
      'south_search',
    ])
    expect(first.world.capabilities.toolNames).toEqual([
      'list_layers',
      'north_search',
      'south_search',
    ])
    expect(third.world.capabilities.toolNames).toContain('query_layer')
    expect(first.mcp.servers).toEqual([
      expect.objectContaining({ name: 'north', toolNames: ['north_search'] }),
      expect.objectContaining({ name: 'south', toolNames: ['south_search'] }),
    ])
    expect(first.mcp.bindingId).toBe('mcp_binding_exact_1')
    expect(first.skills.invocations[0]).toMatchObject({ skillId: 'crs-audit', mode: 'explicit' })
    expect(first.plugins.pluginIds).toEqual(['quality-pack'])
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.tools.entries)).toBe(true)
    expect(contexts).toHaveLength(3)
  })

  it('rejects an MCP tool that is not bound to an active server', async () => {
    const factory = new AgentStepContextFactory(
      { appendNext: async (_runId, build) => build(1), get: async () => null },
      {
        get: async () => snapshot(worldState({
          toolNames: [],
          mcpServerNames: [],
          sandboxBackend: 'disabled',
          writableRoots: [],
          networkPolicy: 'provider_and_registered_tools',
        })),
        ensureBaseline: async () => { throw new Error('不应建立 baseline') },
        applyPatches: async () => { throw new Error('不应更新 world') },
      },
      { build: async () => { throw new Error('不应构建 baseline') } },
      inMemoryContextWindows(),
    )
    const config = runtimeConfigWithMcp()
    const plan = toolPlan([toolEntry('north_search', 'mcp')])

    await expect(factory.capture({
      ...captureInput(config, plan),
      activeMcpServers: ['north'],
      mcpToolServers: new Map(),
    })).rejects.toThrow(/north_search.*server/u)
  })

  it('rejects a runtime digest that does not describe the captured configuration', async () => {
    const factory = new AgentStepContextFactory(
      { appendNext: async (_runId, build) => build(1), get: async () => null },
      {
        get: async () => { throw new Error('配置摘要失败前不应读取 world') },
        ensureBaseline: async () => { throw new Error('配置摘要失败前不应建立 baseline') },
        applyPatches: async () => { throw new Error('配置摘要失败前不应更新 world') },
      },
      { build: async () => { throw new Error('配置摘要失败前不应构建 baseline') } },
      inMemoryContextWindows(),
    )
    const config = runtimeConfigWithMcp()
    const plan = toolPlan([toolEntry('north_search', 'mcp')])

    await expect(factory.capture({
      ...captureInput(config, plan),
      mcpToolServers: new Map([['north_search', 'north']]),
      runtimeConfigDigest: 'sha256:not-the-runtime-config',
    })).rejects.toThrow(/runtimeConfigDigest/u)
  })
})

function inMemoryContextWindows(): ContextWindowStore {
  const windows = new Map<string, ContextWindow>()
  return {
    ensureActive: async input => {
      const existing = windows.get(input.runId)
      if (existing) return existing
      const created: ContextWindow = {
        schemaVersion: CONTEXT_WINDOW_SCHEMA_VERSION,
        contextWindowId: `context_window_${input.runId}`,
        runId: input.runId,
        generation: 1,
        promptProtocolVersion: input.promptProtocolVersion,
        sourceDigest: input.sourceDigest,
        sourceSummary: input.sourceSummary,
        compaction: null,
        startedAt: '2026-08-31T00:00:00.000Z',
        closedAt: null,
      }
      windows.set(input.runId, created)
      return created
    },
    getActive: async runId => windows.get(runId) ?? null,
    rollover: async () => { throw new Error('本测试不执行上下文窗口换代') },
  }
}

function captureInput(
  runtimeConfig: AgentRuntimeConfig,
  plan: AgentToolPlanSnapshot,
): CaptureAgentStepContextInput {
  const mcpToolServers = new Map([
    ['north_search', 'north'],
    ['south_search', 'south'],
  ])
  const mcpServers = runtimeConfig.sdk.mcp.servers.map(server => ({
    name: server.name,
    transport: server.transport,
    approval: server.approval,
    configDigest: `sha256:${server.name}-config`,
    authDigest: `sha256:${server.name}-auth`,
    toolNames: plan.entries
      .filter(entry => entry.kind === 'mcp' && mcpToolServers.get(entry.name) === server.name)
      .map(entry => entry.name),
    resourceUris: [],
  }))
  return {
    runId: 'run_1',
    turnId: 'turn_1',
    segmentId: 'segment_1',
    objectiveRevision: 1,
    inputCursor: 0,
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    transport: 'deepseek_responses',
    modelCapabilities: {
      modelId: 'deepseek-v4-flash',
      contextWindowTokens: 1_000_000,
      capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
      modalities: ['text'],
    },
    reasoningEffort: 'none',
    serviceTier: null,
    timeoutMs: 45_000,
    runtimeConfig,
    runtimeConfigDigest: runtimeConfigDigest(runtimeConfig),
    toolPlan: plan,
    activeMcpServers: ['north', 'south'],
    mcpToolServers,
    mcpBinding: {
      bindingId: 'mcp_binding_test',
      catalogRevision: 1,
      configDigest: 'sha256:mcp-config',
      authDigest: 'sha256:mcp-auth',
      capabilityRootDigest: 'sha256:mcp-roots',
      toolCatalogDigest: 'sha256:mcp-tools',
      resourceCatalogDigest: 'sha256:mcp-resources',
      refreshReasons: ['initial'],
      servers: mcpServers,
    },
    activeSkills: [],
    skillInvocations: [],
    pluginSnapshot: {
      pluginIds: [],
      bindings: [],
      catalogDigest: agentContextDigest([]),
    },
    auth: null,
  }
}

function runtimeConfigWithMcp(): AgentRuntimeConfig {
  const config = defaultRuntimeConfig()
  config.sdk.mcp = {
    enabled: true,
    connectTimeoutMs: 1_000,
    closeTimeoutMs: 1_000,
    servers: [mcpServer('north'), mcpServer('south')],
  }
  return config
}

function mcpServer(name: string): AgentRuntimeConfig['sdk']['mcp']['servers'][number] {
  return {
    enabled: true,
    name,
    description: `${name} MCP`,
    transport: 'streamable_http',
    executionMode: 'function_tools',
    url: `https://${name}.example.test/mcp`,
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
  }
}

function toolPlan(entries: AgentToolPlanEntry[]): AgentToolPlanSnapshot {
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name))
  const plan = {
    entries: sorted,
    namespaces: [],
    deferredCatalogObjectHash: null,
    unavailableReasons: {},
  }
  return { ...plan, catalogDigest: agentContextDigest(plan) }
}

function toolEntry(
  name: string,
  kind: AgentToolPlanEntry['kind'],
): AgentToolPlanEntry {
  return {
    name,
    kind,
    namespace: kind === 'mcp' ? 'mcp' : 'layers',
    providerId: kind === 'mcp' ? name.split('_')[0] ?? null : 'layers',
    schemaDigest: `sha256:schema:${name}`,
    definitionDigest: `sha256:definition:${name}`,
    exposure: 'immediate',
    effect: 'read',
    parallelism: kind === 'mcp' ? 'exclusive' : 'shared',
    approvalAction: kind === 'mcp' ? `tool:${name}` : null,
    replayPolicy: 'safe',
    requiredCapabilities: [],
    requiredValueRefKinds: [],
    executionSurfaces: ['agent'],
    deferLoading: false,
  }
}

function worldState(capabilities: GeoWorldState['capabilities']): GeoWorldState {
  return geoWorldStateSchema.parse({
    schemaVersion: 1,
    revision: 1,
    workspaceId: 'workspace_1',
    map: {
      displayCrs: 'EPSG:3857',
      viewport: null,
      selectedLayerIds: [],
      selectedFeatureRefs: [],
      timeRange: null,
    },
    layers: [],
    datasets: [],
    files: [],
    artifacts: [],
    values: [],
    provenance: [],
    capabilities,
  })
}

function snapshot(state: GeoWorldState): { state: GeoWorldState; stateDigest: string } {
  return { state, stateDigest: agentContextDigest(state) }
}

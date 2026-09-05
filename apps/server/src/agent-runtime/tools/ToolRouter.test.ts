// +-------------------------------------------------------------------------
//
//   地理智能平台 - StepContext 工具路由测试
//
//   文件:       ToolRouter.test.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { agentStepContextSchema, type AgentStepContext } from '@geo-agent-platform/shared-types/agent-step-context'
import type { ModelRequest } from '@openai/agents'
import { describe, expect, it } from 'vitest'

import { ToolRegistry } from '../../framework/registry.js'
import type { ToolDef, ToolProvider } from '../../framework/types.js'
import { agentContextDigest } from '../step/agentContextDigest.js'
import { ToolCatalog, platformToolDescriptorSource } from './ToolCatalog.js'
import { compileToolPlan } from './ToolPlanCompiler.js'
import { ToolRouter } from './ToolRouter.js'

describe('ToolRouter', () => {
  it('keeps an existing call bound to the StepContext that produced it', () => {
    const { catalog, plan } = fixture()
    const router = new ToolRouter(catalog)
    router.bindStepContext(stepContext(plan, 1, 0, 'step_1'))

    const first = router.preparePlatformCall('call_1', 'query_layer')
    router.bindStepContext(stepContext(plan, 2, 1, 'step_2'))
    const retained = router.requirePlatformCall('call_1', 'query_layer')
    const second = router.preparePlatformCall('call_2', 'query_layer')

    expect(retained).toBe(first)
    expect(retained.stepId).toBe('step_1')
    expect(retained.objectiveRevision).toBe(1)
    expect(second.stepId).toBe('step_2')
    expect(second.objectiveRevision).toBe(2)
    expect(Object.isFrozen(first)).toBe(true)
  })

  it('rejects calls outside the plan, callId renames, and catalog drift', () => {
    const { catalog, definition, plan } = fixture()
    const router = new ToolRouter(catalog)
    router.bindStepContext(stepContext(plan, 1, 0, 'step_1'))

    expect(() => router.preparePlatformCall('call_unknown', 'unplanned_tool'))
      .toThrow(/不在 StepContext/u)
    router.preparePlatformCall('call_1', 'query_layer')
    expect(() => router.preparePlatformCall('call_1', 'unplanned_tool'))
      .toThrow(/不能改为/u)

    definition.runtimePolicy = {
      ...definition.runtimePolicy,
      effect: 'world_write',
      parallelism: 'exclusive',
      replayPolicy: 'manual_recovery',
    }
    expect(() => router.preparePlatformCall('call_2', 'query_layer'))
      .toThrow(/目录策略已变化/u)
  })

  it('binds an allowed nested platform call to the parent sampling snapshot', () => {
    const { catalog, nestedDefinition, plan } = fixture()
    const router = new ToolRouter(catalog)
    router.bindStepContext(stepContext(plan, 1, 0, 'step_parent'))

    expect(plan.entries.map(entry => entry.name)).not.toContain(nestedDefinition.name)
    const nested = router.prepareNestedPlatformCall('call_nested', nestedDefinition.name)

    expect(nested).toMatchObject({
      callId: 'call_nested',
      toolName: nestedDefinition.name,
      stepId: 'step_parent',
      objectiveRevision: 1,
      descriptor: { kind: 'platform', effect: 'world_write' },
    })
    expect(router.requirePlatformCall('call_nested', nestedDefinition.name)).toBe(nested)
  })
})

function fixture(): {
  catalog: ToolCatalog
  definition: ToolDef
  nestedDefinition: ToolDef
  plan: AgentStepContext['tools']
} {
  const registry = new ToolRegistry()
  const definition = toolDefinition()
  const nestedDefinition: ToolDef = {
    ...toolDefinition(),
    name: 'update_layer',
    label: '更新图层',
    isReadOnly: false,
    runtimePolicy: {
      namespace: 'layers',
      exposure: 'immediate',
      effect: 'world_write',
      parallelism: 'exclusive',
      approvalAction: 'world_write',
      replayPolicy: 'idempotency_key',
      requiredCapabilities: ['world.layers.write'],
    },
  }
  registry.register(providerFromTools([definition, nestedDefinition]))
  const catalog = new ToolCatalog(registry)
  const request: Pick<ModelRequest, 'tools' | 'handoffs'> = {
    tools: [{
      type: 'function',
      name: definition.name,
      description: definition.description,
      parameters: definition.jsonSchema ?? {},
      strict: true,
    }],
    handoffs: [],
  }
  const plan = compileToolPlan({
    request,
    sources: [platformToolDescriptorSource(definition)],
    providerCapabilities: { nativeDeferredTools: false, nativeToolNamespaces: false },
  })
  return { catalog, definition, nestedDefinition, plan }
}

function stepContext(
  tools: AgentStepContext['tools'],
  objectiveRevision: number,
  inputCursor: number,
  stepId: string,
): AgentStepContext {
  return agentStepContextSchema.parse({
    schemaVersion: 3,
    identity: {
      stepId,
      turnId: 'turn_1',
      segmentId: 'segment_1',
      modelRequestIndex: objectiveRevision,
    },
    runId: 'run_1',
    turnId: 'turn_1',
    objectiveRevision,
    inputCursor,
    model: {
      provider: 'openai',
      modelId: 'gpt-5',
      transport: 'responses',
      capabilities: {
        modelId: 'gpt-5',
        contextWindowTokens: 128_000,
        capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
        modalities: ['text'],
      },
      reasoningEffort: 'high',
      serviceTier: null,
      timeoutMs: 30_000,
    },
    runtimeConfigDigest: 'sha256:runtime',
    toolPlanDigest: tools.catalogDigest,
    worldRevision: 1,
    contextWindowId: 'context_window_1',
    permissions: {
      principalId: 'user_1',
      workspaceId: 'workspace_1',
      roles: ['member'],
      toolRules: [],
    },
    approvalPolicy: {
      interruptToolNames: [],
      destructiveToolsRequireApproval: true,
    },
    sandbox: {
      backend: 'disabled',
      writableRoots: [],
      networkPolicy: 'provider_and_registered_tools',
    },
    mcp: emptyMcpSnapshot(),
    skills: { skillIds: [], invocations: [], catalogDigest: 'sha256:skills' },
    plugins: { pluginIds: [], bindings: [], catalogDigest: 'sha256:plugins' },
    tools,
    world: {
      revision: 1,
      stateDigest: 'sha256:world',
      layerIds: [],
      datasetIds: [],
      fileIds: [],
      artifactIds: [],
      valueRefIds: [],
      capabilities: {
        toolNames: tools.entries.map(entry => entry.name),
        mcpServerNames: [],
        sandboxBackend: 'disabled',
        writableRoots: [],
        networkPolicy: 'provider_and_registered_tools',
      },
    },
    capturedAt: '2026-08-23T00:00:00.000Z',
    contextDigest: agentContextDigest({ stepId, objectiveRevision, tools }),
  })
}

function emptyMcpSnapshot() {
  return {
    bindingId: 'mcp_binding_none',
    catalogRevision: 0,
    configDigest: 'sha256:mcp-config',
    authDigest: 'sha256:mcp-auth',
    capabilityRootDigest: 'sha256:mcp-capabilities',
    toolCatalogDigest: 'sha256:mcp-tools',
    resourceCatalogDigest: 'sha256:mcp-resources',
    refreshReasons: ['initial'],
    servers: [],
  }
}

function toolDefinition(): ToolDef {
  return {
    name: 'query_layer',
    label: '查询图层',
    description: '查询当前工作区图层',
    prompt: '只读取图层，不修改世界状态。',
    group: 'layers',
    tags: ['layers'],
    isReadOnly: true,
    isDestructive: false,
    parallelSafe: true,
    executionSurfaces: ['agent'],
    runtimePolicy: {
      namespace: 'layers',
      exposure: 'immediate',
      effect: 'read',
      parallelism: 'shared',
      approvalAction: null,
      replayPolicy: 'safe',
      requiredCapabilities: ['world.layers.read'],
    },
    jsonSchema: {
      type: 'object',
      properties: { layerId: { type: 'string' } },
      required: ['layerId'],
      additionalProperties: false,
    },
    handler: async () => ({
      message: '完成', payload: {}, warnings: [], resultId: 'result_1', source: 'test',
    }),
  }
}

function providerFromTools(tools: ToolDef[]): ToolProvider {
  return {
    manifest: {
      id: 'tool-router-test',
      name: 'Tool Router Test',
      version: '1.0.0',
      author: 'test',
      language: 'typescript',
      description: 'Tool Router Test',
      tools: tools.map(({ handler: _handler, providerId: _providerId, language: _language, ...definition }) => definition),
    },
    tools: () => tools,
  }
}

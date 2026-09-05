// +-------------------------------------------------------------------------
//
//   地理智能平台 - 不可变 StepContext 契约测试
//
//   文件:       agentStepContext.test.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { agentStepContextSchema } from './agentStepContext.js'

describe('AgentStepContext schema', () => {
  it('binds the model, tool plan and world revision in one request record', () => {
    expect(agentStepContextSchema.parse(context()).identity.modelRequestIndex).toBe(1)
  })

  it('rejects a tool digest that does not describe the attached plan', () => {
    expect(() => agentStepContextSchema.parse({
      ...context(),
      toolPlanDigest: 'sha256:different',
    })).toThrow(/toolPlanDigest/u)
  })

  it('rejects a world revision that differs from the attached snapshot', () => {
    expect(() => agentStepContextSchema.parse({
      ...context(),
      worldRevision: 2,
    })).toThrow(/worldRevision/u)
  })
})

function context(): Record<string, unknown> {
  const capabilities = {
    toolNames: ['list_layers'],
    mcpServerNames: [],
    sandboxBackend: 'disabled',
    writableRoots: [],
    networkPolicy: 'provider_only',
  }
  return {
    schemaVersion: 3,
    identity: { stepId: 'step_1', turnId: 'turn_1', segmentId: 'segment_1', modelRequestIndex: 1 },
    runId: 'run_1',
    turnId: 'turn_1',
    objectiveRevision: 1,
    inputCursor: 0,
    model: {
      provider: 'deepseek',
      modelId: 'deepseek-v4-flash',
      transport: 'responses',
      capabilities: {
        modelId: 'deepseek-v4-flash',
        contextWindowTokens: 1_000_000,
        capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
        modalities: ['text'],
      },
      reasoningEffort: 'none',
      serviceTier: null,
      timeoutMs: 0,
    },
    runtimeConfigDigest: 'sha256:runtime',
    toolPlanDigest: 'sha256:tools',
    worldRevision: 1,
    contextWindowId: 'context_window_1',
    permissions: {
      principalId: 'user_1',
      workspaceId: 'workspace_1',
      roles: ['owner'],
      toolRules: [],
    },
    approvalPolicy: { interruptToolNames: [], destructiveToolsRequireApproval: true },
    sandbox: { backend: 'disabled', writableRoots: [], networkPolicy: 'provider_only' },
    mcp: emptyMcpSnapshot(),
    skills: { skillIds: [], invocations: [], catalogDigest: 'sha256:empty' },
    plugins: { pluginIds: [], bindings: [], catalogDigest: 'sha256:empty' },
    tools: {
      entries: [{
        name: 'list_layers',
        namespace: 'layers',
        kind: 'platform',
        providerId: 'layers',
        schemaDigest: 'sha256:schema',
        exposure: 'immediate',
        effect: 'read',
        parallelism: 'shared',
        approvalAction: null,
        replayPolicy: 'safe',
        requiredCapabilities: [],
        requiredValueRefKinds: [],
        executionSurfaces: ['agent'],
        definitionDigest: 'sha256:definition',
        deferLoading: false,
      }],
      namespaces: [],
      deferredCatalogObjectHash: null,
      unavailableReasons: {},
      catalogDigest: 'sha256:tools',
    },
    world: {
      revision: 1,
      stateDigest: 'sha256:world',
      layerIds: [],
      datasetIds: [],
      fileIds: [],
      artifactIds: [],
      valueRefIds: [],
      capabilities,
    },
    capturedAt: '2026-08-20T01:00:00.000Z',
    contextDigest: 'sha256:context',
  }
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

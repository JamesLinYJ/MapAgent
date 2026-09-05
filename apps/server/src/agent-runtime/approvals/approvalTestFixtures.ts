// +-------------------------------------------------------------------------
//
//   地理智能平台 - 审批测试夹具
//
//   文件:       approvalTestFixtures.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { agentStepContextSchema, type AgentStepContext } from '@geo-agent-platform/shared-types/agent-step-context'
import { agentToolDescriptorSourceSchema, type AgentToolDescriptorSource } from '@geo-agent-platform/shared-types/tool-runtime'

export function toolDescriptor(
  overrides: Partial<AgentToolDescriptorSource> = {},
): AgentToolDescriptorSource {
  return agentToolDescriptorSourceSchema.parse({
    name: 'create_layer',
    namespace: 'layers',
    providerId: 'layers',
    kind: 'platform',
    exposure: 'immediate',
    effect: 'world_write',
    parallelism: 'exclusive',
    approvalAction: 'world_write',
    replayPolicy: 'idempotency_key',
    requiredCapabilities: [],
    requiredValueRefKinds: [],
    executionSurfaces: ['agent'],
    ...overrides,
  })
}

export function stepContext(overrides: {
  toolRules?: AgentStepContext['permissions']['toolRules']
  interruptToolNames?: string[]
  stepId?: string
  contextDigest?: string
} = {}): AgentStepContext {
  const stepId = overrides.stepId ?? 'step_1'
  return agentStepContextSchema.parse({
    schemaVersion: 3,
    identity: { stepId, turnId: 'turn_1', segmentId: 'segment_1', modelRequestIndex: 1 },
    runId: 'run_1',
    turnId: 'turn_1',
    objectiveRevision: 1,
    inputCursor: 0,
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
      reasoningEffort: 'high', serviceTier: null, timeoutMs: 30_000,
    },
    runtimeConfigDigest: 'sha256:runtime',
    toolPlanDigest: 'sha256:tools',
    worldRevision: 1,
    contextWindowId: 'context_window_1',
    permissions: {
      principalId: 'user_1', workspaceId: 'workspace_1', roles: ['analyst'],
      toolRules: overrides.toolRules ?? [],
    },
    approvalPolicy: {
      interruptToolNames: overrides.interruptToolNames ?? [],
      destructiveToolsRequireApproval: true,
    },
    sandbox: { backend: 'disabled', writableRoots: [], networkPolicy: 'provider_and_registered_tools' },
    mcp: emptyMcpSnapshot(),
    skills: { skillIds: [], invocations: [], catalogDigest: 'sha256:skills' },
    plugins: { pluginIds: [], bindings: [], catalogDigest: 'sha256:plugins' },
    tools: { entries: [], namespaces: [], deferredCatalogObjectHash: null, unavailableReasons: {}, catalogDigest: 'sha256:tools' },
    world: {
      revision: 1, stateDigest: 'sha256:world', layerIds: [], datasetIds: [], fileIds: [], artifactIds: [], valueRefIds: [],
      capabilities: { toolNames: [], mcpServerNames: [], sandboxBackend: 'disabled', writableRoots: [], networkPolicy: 'provider_and_registered_tools' },
    },
    capturedAt: '2026-08-24T00:00:00.000Z',
    contextDigest: overrides.contextDigest ?? 'sha256:context',
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

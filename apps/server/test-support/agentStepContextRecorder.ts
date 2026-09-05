// +-------------------------------------------------------------------------
//
//   地理智能平台 - StepContext 测试记录器
//
//   文件:       agentStepContextRecorder.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  AGENT_STEP_CONTEXT_SCHEMA_VERSION,
  agentStepContextSchema,
  type AgentStepContext,
} from '@geo-agent-platform/shared-types/agent-step-context'
import {
  CONTEXT_WINDOW_SCHEMA_VERSION,
  type ContextWindow,
} from '@geo-agent-platform/shared-types/context-window'

import { agentContextDigest } from '../src/agent-runtime/step/agentContextDigest.js'
import type {
  AgentStepContextRecorder,
  CaptureAgentStepContextInput,
} from '../src/agent-runtime/step/AgentStepContextFactory.js'

interface TestStepContextRecorderOptions {
  onRecord?: (input: CaptureAgentStepContextInput) => void
}

export function createTestAgentStepContextRecorder(
  options: TestStepContextRecorderOptions = {},
): AgentStepContextRecorder {
  const contexts = new Map<string, AgentStepContext>()
  const contextWindows = new Map<string, ContextWindow>()
  let modelRequestIndex = 0
  const ensureContextWindow = (input: {
    runId: string
    promptProtocolVersion: string
    sourceDigest: string
    sourceSummary: ContextWindow['sourceSummary']
  }): ContextWindow => {
    const active = contextWindows.get(input.runId)
    if (active) return active
    const created: ContextWindow = {
      schemaVersion: CONTEXT_WINDOW_SCHEMA_VERSION,
      contextWindowId: `context_window_test_${input.runId}_1`,
      runId: input.runId,
      generation: 1,
      promptProtocolVersion: input.promptProtocolVersion,
      sourceDigest: input.sourceDigest,
      sourceSummary: input.sourceSummary,
      compaction: null,
      startedAt: '2026-08-31T00:00:00.000Z',
      closedAt: null,
    }
    contextWindows.set(input.runId, created)
    return created
  }
  return {
    record: async input => {
      options.onRecord?.(input)
      const sourceSummary = {
        turnId: input.turnId,
        objectiveRevision: input.objectiveRevision,
        inputCursor: input.inputCursor,
        summaryObjectHashes: [],
      }
      const contextWindow = ensureContextWindow({
        runId: input.runId,
        promptProtocolVersion: '1',
        sourceDigest: agentContextDigest(sourceSummary),
        sourceSummary,
      })
      const context = createTestAgentStepContext(
        input,
        ++modelRequestIndex,
        contextWindow.contextWindowId,
      )
      contexts.set(context.identity.stepId, context)
      return context
    },
    get: async stepId => contexts.get(stepId) ?? null,
    getActiveContextWindow: async runId => contextWindows.get(runId) ?? null,
    ensureContextWindow: async input => ensureContextWindow(input),
    rolloverContextWindow: async input => {
      const active = contextWindows.get(input.runId)
      if (!active || active.contextWindowId !== input.expectedContextWindowId) {
        throw new Error(`测试运行 '${input.runId}' 的活动上下文窗口不一致`)
      }
      const created: ContextWindow = {
        schemaVersion: CONTEXT_WINDOW_SCHEMA_VERSION,
        contextWindowId: `context_window_test_${input.runId}_${active.generation + 1}`,
        runId: input.runId,
        generation: active.generation + 1,
        promptProtocolVersion: input.promptProtocolVersion,
        sourceDigest: input.sourceDigest,
        sourceSummary: input.sourceSummary,
        compaction: null,
        startedAt: '2026-08-31T00:00:01.000Z',
        closedAt: null,
      }
      contextWindows.set(input.runId, created)
      return created
    },
  }
}

function createTestAgentStepContext(
  input: CaptureAgentStepContextInput,
  modelRequestIndex: number,
  contextWindowId: string,
): AgentStepContext {
  const capturedAt = '2026-08-23T00:00:00.000Z'
  const identity = {
    stepId: `step_test_${modelRequestIndex}`,
    turnId: input.turnId,
    segmentId: input.segmentId,
    modelRequestIndex,
  }
  const capabilities = {
    toolNames: input.toolPlan.entries.map(entry => entry.name).sort(),
    mcpServerNames: [...new Set(input.activeMcpServers)].sort(),
    sandboxBackend: input.runtimeConfig.sandbox.backend,
    writableRoots: input.runtimeConfig.developer.enabled
      ? [...new Set(input.runtimeConfig.developer.allowedRoots)].sort()
      : [],
    networkPolicy: input.runtimeConfig.sandbox.backend === 'disabled'
      ? 'provider_and_registered_tools'
      : 'sandbox_manifest',
  }
  const contextWithoutDigest = {
    schemaVersion: AGENT_STEP_CONTEXT_SCHEMA_VERSION,
    identity,
    runId: input.runId,
    turnId: input.turnId,
    objectiveRevision: input.objectiveRevision,
    inputCursor: input.inputCursor,
    model: {
      provider: input.provider,
      modelId: input.modelId,
      transport: typeof input.transport === 'string' && input.transport.includes('chat')
        ? 'chat_completions' as const
        : 'responses' as const,
      capabilities: input.modelCapabilities,
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier,
      timeoutMs: input.timeoutMs,
    },
    runtimeConfigDigest: input.runtimeConfigDigest,
    toolPlanDigest: input.toolPlan.catalogDigest,
    worldRevision: 1,
    contextWindowId,
    permissions: {
      principalId: input.auth?.userId ?? null,
      workspaceId: input.auth?.defaultWorkspaceId ?? 'workspace_test',
      roles: [],
      toolRules: [],
    },
    approvalPolicy: {
      interruptToolNames: [...input.runtimeConfig.supervisor.approvalInterruptTools].sort(),
      destructiveToolsRequireApproval: true as const,
    },
    sandbox: {
      backend: input.runtimeConfig.sandbox.backend,
      writableRoots: capabilities.writableRoots,
      networkPolicy: capabilities.networkPolicy,
    },
    mcp: input.mcpBinding,
    skills: {
      skillIds: [...new Set(input.activeSkills)].sort(),
      invocations: [...input.skillInvocations],
      catalogDigest: agentContextDigest(
        input.skillInvocations.length
          ? input.skillInvocations
          : [...new Set(input.activeSkills)].sort(),
      ),
    },
    plugins: input.pluginSnapshot,
    tools: input.toolPlan,
    world: {
      revision: 1,
      stateDigest: agentContextDigest({ runId: input.runId, revision: 1, capabilities }),
      layerIds: [],
      datasetIds: [],
      fileIds: [],
      artifactIds: [],
      valueRefIds: [],
      capabilities,
    },
    capturedAt,
  }
  return deepFreeze(agentStepContextSchema.parse({
    ...contextWithoutDigest,
    contextDigest: agentContextDigest(contextWithoutDigest),
  }))
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

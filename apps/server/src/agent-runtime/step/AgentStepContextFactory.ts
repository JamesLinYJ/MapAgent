// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型请求级不可变 StepContext 工厂
//
//   文件:       AgentStepContextFactory.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  AGENT_STEP_CONTEXT_SCHEMA_VERSION,
  agentStepContextSchema,
  type AgentMcpSnapshot,
  type AgentPluginSnapshot,
  type AgentSkillInvocation,
  type AgentStepContext,
  type AgentToolPlanSnapshot,
} from '@geo-agent-platform/shared-types/agent-step-context'
import type {
  GeoWorldCapabilities,
  GeoWorldPatch,
  GeoWorldState,
} from '@geo-agent-platform/shared-types/geo-world'
import type { ModelCapabilitySnapshot } from '@geo-agent-platform/shared-types/resources'
import type { AgentRuntimeConfig } from '@geo-agent-platform/shared-types/runtime'
import {
  CONTEXT_PROMPT_PROTOCOL_VERSION,
  type ContextWindow,
} from '@geo-agent-platform/shared-types/context-window'

import type { AuthContext } from '../../security/types.js'
import { makeId, nowUtc } from '../../utils/ids.js'
import type { GeoWorldSnapshotRecord } from '../world/GeoWorldRepository.js'
import type {
  ContextWindowStore,
  EnsureContextWindowInput,
  RolloverContextWindowInput,
} from '../context/ContextWindowStore.js'
import { agentContextDigest } from './agentContextDigest.js'

export interface CaptureAgentStepContextInput {
  runId: string
  turnId: string
  segmentId: string
  objectiveRevision: number
  inputCursor: number
  provider: string
  modelId: string
  transport: string
  modelCapabilities: ModelCapabilitySnapshot
  reasoningEffort: string | null
  serviceTier: string | null
  timeoutMs: number
  runtimeConfig: AgentRuntimeConfig
  runtimeConfigDigest: string
  toolPlan: AgentToolPlanSnapshot
  activeMcpServers: readonly string[]
  mcpToolServers: ReadonlyMap<string, string>
  mcpBinding: AgentMcpSnapshot
  activeSkills: readonly string[]
  skillInvocations: readonly AgentSkillInvocation[]
  pluginSnapshot: AgentPluginSnapshot
  auth: AuthContext | null
}

export type RecordedAgentStepContext = AgentStepContext

export interface AgentStepContextRecorder {
  record(input: CaptureAgentStepContextInput): Promise<RecordedAgentStepContext>
  get(stepId: string): Promise<RecordedAgentStepContext | null>
  getActiveContextWindow(runId: string): Promise<ContextWindow | null>
  ensureContextWindow(input: EnsureContextWindowInput): Promise<ContextWindow>
  rolloverContextWindow(input: RolloverContextWindowInput): Promise<ContextWindow>
}

interface AgentStepContextWriter {
  appendNext(
    runId: string,
    build: (modelRequestIndex: number) => AgentStepContext,
  ): Promise<AgentStepContext>
  get(stepId: string): Promise<AgentStepContext | null>
}

interface GeoWorldStore {
  get(runId: string): Promise<GeoWorldSnapshotRecord | null>
  ensureBaseline(runId: string, baseline: GeoWorldState): Promise<GeoWorldSnapshotRecord>
  applyPatches(input: {
    runId: string
    expectedRevision: number
    patches: readonly GeoWorldPatch[]
  }): Promise<{ snapshot: GeoWorldSnapshotRecord }>
}

interface GeoWorldBaselineSource {
  build(runId: string, capabilities: GeoWorldCapabilities): Promise<GeoWorldState>
}

export class AgentStepContextFactory implements AgentStepContextRecorder {
  constructor(
    private readonly contexts: AgentStepContextWriter,
    private readonly worlds: GeoWorldStore,
    private readonly baselineBuilder: GeoWorldBaselineSource,
    private readonly contextWindows: ContextWindowStore,
  ) {}

  async record(input: CaptureAgentStepContextInput): Promise<AgentStepContext> {
    return this.capture(input)
  }

  get(stepId: string): Promise<AgentStepContext | null> {
    return this.contexts.get(stepId)
  }

  getActiveContextWindow(runId: string): Promise<ContextWindow | null> {
    return this.contextWindows.getActive(runId)
  }

  ensureContextWindow(input: EnsureContextWindowInput): Promise<ContextWindow> {
    return this.contextWindows.ensureActive(input)
  }

  rolloverContextWindow(input: RolloverContextWindowInput): Promise<ContextWindow> {
    return this.contextWindows.rollover(input)
  }

  async capture(input: CaptureAgentStepContextInput): Promise<AgentStepContext> {
    assertMcpSourcesBound(input)
    if (agentContextDigest(input.runtimeConfig) !== input.runtimeConfigDigest) {
      throw new Error('Agent StepContext runtimeConfigDigest 与实际配置不一致')
    }
    const capabilities = capabilitySnapshot(input)
    let world = await this.worlds.get(input.runId)
    if (!world) {
      world = await this.worlds.ensureBaseline(
        input.runId,
        await this.baselineBuilder.build(input.runId, capabilities),
      )
    } else if (agentContextDigest(world.state.capabilities) !== agentContextDigest(capabilities)) {
      world = (await this.worlds.applyPatches({
        runId: input.runId,
        expectedRevision: world.state.revision,
        patches: [{
          type: 'capabilities.changed',
          expected: world.state.capabilities,
          next: capabilities,
        }],
      })).snapshot
    }
    const contextWindowSource = {
      turnId: input.turnId,
      objectiveRevision: input.objectiveRevision,
      inputCursor: input.inputCursor,
      summaryObjectHashes: [],
    }
    const contextWindow = await this.contextWindows.ensureActive({
      runId: input.runId,
      promptProtocolVersion: CONTEXT_PROMPT_PROTOCOL_VERSION,
      sourceSummary: contextWindowSource,
      sourceDigest: agentContextDigest(contextWindowSource),
    })
    return this.contexts.appendNext(input.runId, modelRequestIndex => {
      const capturedAt = nowUtc()
      const identity = {
        stepId: makeId('step'),
        turnId: input.turnId,
        segmentId: input.segmentId,
        modelRequestIndex,
      }
      const mcp = structuredClone(input.mcpBinding)
      const roles = [...new Set(input.auth?.roles
        .filter(binding => binding.workspaceId === world.state.workspaceId)
        .map(binding => binding.role) ?? [])].sort()
      const skillIds = [...new Set(input.activeSkills)].sort()
      const skillInvocations = [...input.skillInvocations]
        .map(invocation => structuredClone(invocation))
        .sort((left, right) => left.skillId.localeCompare(right.skillId))
      const plugins = structuredClone(input.pluginSnapshot)
      const toolRules = input.runtimeConfig.supervisor.permissionRules
        .map(rule => ({
          toolPattern: rule.toolPattern,
          decision: rule.decision,
          priority: rule.priority,
        }))
        .sort((left, right) => (
          right.priority - left.priority || left.toolPattern.localeCompare(right.toolPattern)
        ))
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
          transport: normalizeTransport(input.transport),
          capabilities: input.modelCapabilities,
          reasoningEffort: input.reasoningEffort,
          serviceTier: input.serviceTier,
          timeoutMs: input.timeoutMs,
        },
        runtimeConfigDigest: input.runtimeConfigDigest,
        toolPlanDigest: input.toolPlan.catalogDigest,
        worldRevision: world.state.revision,
        contextWindowId: contextWindow.contextWindowId,
        permissions: {
          principalId: input.auth?.userId ?? null,
          workspaceId: world.state.workspaceId,
          roles,
          toolRules,
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
        mcp,
        skills: {
          skillIds,
          invocations: skillInvocations,
          catalogDigest: agentContextDigest(skillInvocations.length ? skillInvocations : skillIds),
        },
        plugins,
        tools: input.toolPlan,
        world: {
          revision: world.state.revision,
          stateDigest: world.stateDigest,
          layerIds: world.state.layers.map(layer => layer.layerId).sort(),
          datasetIds: world.state.datasets.map(dataset => dataset.datasetId).sort(),
          fileIds: world.state.files.map(file => file.fileId).sort(),
          artifactIds: world.state.artifacts.map(artifact => artifact.artifactId).sort(),
          valueRefIds: world.state.values.map(value => value.refId).sort(),
          capabilities: world.state.capabilities,
        },
        capturedAt,
      }
      return deepFreeze(agentStepContextSchema.parse({
        ...contextWithoutDigest,
        contextDigest: agentContextDigest(contextWithoutDigest),
      }))
    })
  }
}

function capabilitySnapshot(input: CaptureAgentStepContextInput): GeoWorldCapabilities {
  return {
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
}

function assertMcpSourcesBound(input: CaptureAgentStepContextInput): void {
  const activeServers = new Set(input.activeMcpServers)
  for (const entry of input.toolPlan.entries) {
    if (entry.kind !== 'mcp') continue
    const server = input.mcpToolServers.get(entry.name)
    if (!server) throw new Error(`MCP 工具 '${entry.name}' 缺少 server 来源绑定`)
    if (!activeServers.has(server)) {
      throw new Error(`MCP 工具 '${entry.name}' 引用了非活动 server '${server}'`)
    }
  }
  const bindingServers = new Set(input.mcpBinding.servers.map(server => server.name))
  if (bindingServers.size !== activeServers.size
    || [...activeServers].some(server => !bindingServers.has(server))) {
    throw new Error(`MCP binding '${input.mcpBinding.bindingId}' 与活动 server 列表不一致`)
  }
  const bindingTools = new Map(input.mcpBinding.servers.flatMap(server => (
    server.toolNames.map(toolName => [toolName, server.name] as const)
  )))
  for (const [toolName, serverName] of input.mcpToolServers) {
    if (bindingTools.get(toolName) !== serverName) {
      throw new Error(`MCP binding '${input.mcpBinding.bindingId}' 未精确绑定工具 '${toolName}'`)
    }
  }
}

function normalizeTransport(value: string): 'responses' | 'chat_completions' {
  if (value === 'deepseek_responses' || value === 'openai_responses') return 'responses'
  if (value === 'openai_chat_completions') return 'chat_completions'
  throw new Error(`Agent StepContext 不支持模型 transport '${value}'`)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

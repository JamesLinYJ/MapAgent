// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent Automation 调用服务
//
//   文件:       automationInvocationService.ts
//
//   日期:       2026年07月17日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AuthContext } from '../security/types.js'
import type { ArtifactRef } from '@geo-agent-platform/shared-types/core'
import type { CreateAutomationRunInput } from '../store/postgres/automationRunRepository.js'
import { makeId } from '../utils/ids.js'
import type { CompiledAutomation } from './automationCompiler.js'
import type { AutomationListResult } from './automationDefinitionService.js'
import {
  createAutomationExecutionState,
  withExecutionState,
} from './automationExecutionState.js'
import type { AutomationDefinition, AutomationRunRecord } from './schemas.js'

export interface AutomationInvocationStore {
  getRun(runId: string): {
    id: string
    sessionId: string
    threadId: string | null
    workspaceId: string | null
    state: { artifacts: ArtifactRef[] }
  }
  createAutomationRunRecord(input: CreateAutomationRunInput): Promise<AutomationRunRecord>
  getAutomationRunRecord(automationRunId: string): Promise<AutomationRunRecord | null>
  listAutomationRuns(workspaceId: string): Promise<AutomationRunRecord[]>
  countMeteorologicalDatasets(input: {
    workspaceId: string
    sessionId: string
    threadId: string | null
    status: string | null
  }): Promise<number>
}

export interface AutomationInvocationDefinitions {
  list(auth: AuthContext): Promise<AutomationListResult>
  requirePublished(workspaceId: string, automationId: string): Promise<AutomationDefinition>
  authorizeRead(auth: AuthContext, automationId?: string): Promise<void>
  authorizeExecution(auth: AuthContext, automationId: string): Promise<void>
}

export interface AutomationInvocationCompiler {
  compile(definition: AutomationDefinition): CompiledAutomation
}

export interface AutomationInvocationRunner {
  executeAttached(automationRunId: string, auth: AuthContext, signal: AbortSignal): Promise<AutomationRunRecord>
}

export interface AgentAutomationDescriptor {
  automationId: string
  name: string
  description: string
  invocationDescription: string
  examples: string[]
  requirements: AutomationDefinition['agentInvocation']['requirements']
  parametersSchema: Record<string, unknown>
  defaultParameters: Record<string, unknown>
}

export interface AttachedAutomationInput {
  automationId: string
  prompt: string
  parameters?: Record<string, unknown> | undefined
  sessionId: string
  threadId: string
  runId: string
  signal: AbortSignal
}

export interface AttachedAutomationResult {
  automationRunId: string
  automationId: string
  answer: string
  outputs: Record<string, unknown>
  artifacts: ArtifactRef[]
}

export interface AttachedAutomationContext {
  sessionId: string
  threadId: string
  runId: string
}

export type AttachedAutomationRunScope = 'thread' | 'session'

export interface AttachedAutomationRunSummary {
  automationRunId: string
  automationId: string
  automationRevision: number
  runId: string
  threadId: string
  status: AutomationRunRecord['status']
  triggerKind: AutomationRunRecord['triggerKind']
  startedAt: string
  completedAt: string | null
}

export interface AttachedAutomationRunResult {
  run: AutomationRunRecord
  artifacts: ArtifactRef[]
}

// Agent 只能同步调用显式声明 agentInvocation 的确定性会话 Automation。
// 图结构约束由 AutomationCompiler 负责，本服务只拥有调用权限、附着目标和运行记录。
export class AutomationInvocationService {
  constructor(private readonly deps: {
    store: AutomationInvocationStore
    definitions: AutomationInvocationDefinitions
    compiler: AutomationInvocationCompiler
    runner: AutomationInvocationRunner
  }) {}

  async listAvailable(auth: AuthContext): Promise<AgentAutomationDescriptor[]> {
    const result = await this.deps.definitions.list(auth)
    const published = await Promise.all(result.definitions
      .filter(definition => definition.enabled && (
        definition.publishedRevision !== null || definition.lifecycle === 'published'
      ))
      .map(definition => this.deps.definitions.requirePublished(
        auth.defaultWorkspaceId,
        definition.automationId,
      )))
    return published
      .filter(definition => definition.agentInvocation.enabled)
      .map(definition => ({
        automationId: definition.automationId,
        name: definition.name,
        description: definition.description,
        invocationDescription: definition.agentInvocation.description,
        examples: [...definition.agentInvocation.examples],
        requirements: structuredClone(definition.agentInvocation.requirements),
        parametersSchema: structuredClone(definition.parametersSchema),
        defaultParameters: structuredClone(definition.defaultParameters),
      }))
  }

  async listAttachedRuns(
    auth: AuthContext,
    context: AttachedAutomationContext & { scope: AttachedAutomationRunScope },
  ): Promise<AttachedAutomationRunSummary[]> {
    const currentRun = this.requireCurrentRun(auth, context)
    await this.deps.definitions.authorizeRead(auth)
    const records = await this.deps.store.listAutomationRuns(currentRun.workspaceId)
    return records.flatMap((record) => {
      if (!record.runId || record.triggerKind !== 'agent') return []
      const ownerRun = this.deps.store.getRun(record.runId)
      if (ownerRun.sessionId !== context.sessionId || !ownerRun.threadId) return []
      if (context.scope === 'thread' && ownerRun.threadId !== context.threadId) return []
      return [{
        automationRunId: record.automationRunId,
        automationId: record.automationId,
        automationRevision: record.automationRevision,
        runId: record.runId,
        threadId: ownerRun.threadId,
        status: record.status,
        triggerKind: record.triggerKind,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
      }]
    })
  }

  async readAttachedRun(
    auth: AuthContext,
    context: AttachedAutomationContext & { automationRunId: string },
  ): Promise<AttachedAutomationRunResult> {
    const currentRun = this.requireCurrentRun(auth, context)
    const record = await this.deps.store.getAutomationRunRecord(context.automationRunId)
    if (!record) throw new Error(`自动化运行 '${context.automationRunId}' 不存在。`)
    if (record.workspaceId !== currentRun.workspaceId) throw new Error('无权读取该自动化运行。')
    await this.deps.definitions.authorizeRead(auth, record.automationId)
    if (!record.runId) throw new Error('该自动化运行没有关联会话运行，不能在对话中读取。')
    const ownerRun = this.deps.store.getRun(record.runId)
    if (ownerRun.sessionId !== context.sessionId) {
      throw new Error('该自动化运行不属于当前会话。')
    }
    const artifactIds = automationArtifactIds(record)
    return {
      run: structuredClone(record),
      artifacts: structuredClone(ownerRun.state.artifacts.filter(artifact => artifactIds.has(artifact.artifactId))),
    }
  }

  async executeAttached(auth: AuthContext, input: AttachedAutomationInput): Promise<AttachedAutomationResult> {
    const run = this.requireCurrentRun(auth, input)
    const definition = await this.deps.definitions.requirePublished(run.workspaceId, input.automationId)
    if (!definition.agentInvocation.enabled) {
      throw new Error(`Automation“${definition.name}”未开放 Agent 调用。`)
    }
    await this.deps.definitions.authorizeExecution(auth, definition.automationId)
    const compiled = this.deps.compiler.compile(definition)
    const parameters = { ...definition.defaultParameters, ...(input.parameters ?? {}) }
    compiled.validateParameters(parameters)
    await this.assertInvocationRequirements(definition, {
      workspaceId: run.workspaceId,
      sessionId: input.sessionId,
      threadId: input.threadId,
    })
    const state = createAutomationExecutionState({
      definition: compiled.definition,
      prompt: input.prompt.trim(),
      parameters,
      executionTarget: {
        sessionId: input.sessionId,
        threadId: input.threadId,
        runId: input.runId,
      },
    })
    const automationRunId = makeId('automation_run')
    await this.deps.store.createAutomationRunRecord({
      automationRunId,
      automationId: definition.automationId,
      automationRevision: definition.revision,
      scheduledTaskId: null,
      workspaceId: run.workspaceId,
      createdByUserId: auth.userId,
      runId: input.runId,
      status: 'queued',
      currentStep: definition.graph.entryNodeId,
      triggerKind: 'agent',
      metadata: withExecutionState({}, state),
      nodeRuns: state.nodeRuns,
    })
    const signal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(definition.timeoutSeconds * 1_000),
    ])
    const completed = await this.deps.runner.executeAttached(automationRunId, auth, signal)
    if (completed.status !== 'completed') {
      throw new Error(`Automation“${definition.name}”未完成，当前状态为 ${completed.status}。`)
    }
    const answer = completed.outputs.answer
    if (typeof answer !== 'string' || !answer.trim()) {
      throw new Error(`Automation“${definition.name}”没有返回可交付的 answer。`)
    }
    const artifactIds = automationArtifactIds(completed)
    const completedRun = this.deps.store.getRun(input.runId)
    return {
      automationRunId,
      automationId: definition.automationId,
      answer: answer.trim(),
      outputs: structuredClone(completed.outputs),
      artifacts: structuredClone(completedRun.state.artifacts.filter(artifact => artifactIds.has(artifact.artifactId))),
    }
  }

  private requireCurrentRun(auth: AuthContext, context: AttachedAutomationContext) {
    const run = this.deps.store.getRun(context.runId)
    if (!run.threadId || run.sessionId !== context.sessionId || run.threadId !== context.threadId) {
      throw new Error('Automation 附着目标与当前 Agent 运行不一致。')
    }
    if (!run.workspaceId) {
      throw new Error('当前 Agent 运行没有工作区归属，不能执行确定性流程。')
    }
    if (run.workspaceId !== auth.defaultWorkspaceId) {
      throw new Error('Automation 不能跨工作区附着到 Agent 运行。')
    }
    return { ...run, workspaceId: run.workspaceId }
  }

  private async assertInvocationRequirements(
    definition: AutomationDefinition,
    context: { workspaceId: string; sessionId: string; threadId: string },
  ): Promise<void> {
    for (const requirement of definition.agentInvocation.requirements) {
      if (requirement.resource !== 'meteorological_files') continue
      const availableCount = await this.deps.store.countMeteorologicalDatasets({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        threadId: requirement.scope === 'thread' ? context.threadId : null,
        status: requirement.readyOnly ? 'ready' : null,
      })
      if (availableCount >= requirement.minimumCount) continue
      const scopeLabel = requirement.scope === 'thread' ? '当前对话' : '当前会话'
      throw new AutomationInputRequirementError(
        `自动化流程“${definition.name}”需要${scopeLabel}至少 `
        + `${requirement.minimumCount} 个可用气象文件，当前只有 ${availableCount} 个。`
        + `请先在${scopeLabel}上传完整文件后再执行。`,
      )
    }
  }
}

class AutomationInputRequirementError extends Error {
  readonly failureSource = 'data' as const
  readonly code = 'automation_input_requirement_failed'

  constructor(message: string) {
    super(message)
    this.name = 'AutomationInputRequirementError'
  }
}

function automationArtifactIds(record: AutomationRunRecord): Set<string> {
  const ids = new Set<string>()
  for (const nodeRun of record.nodeRuns) {
    const artifacts = nodeRun.output.artifacts
    if (!Array.isArray(artifacts)) continue
    for (const artifact of artifacts) {
      if (isRecord(artifact) && typeof artifact.artifactId === 'string') ids.add(artifact.artifactId)
    }
  }
  return ids
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

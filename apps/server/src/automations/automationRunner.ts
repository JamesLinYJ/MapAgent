// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation DAG 执行器
//
//   文件:       automationRunner.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 平台 Automation DAG 执行器。
// 每次运行固定消费 definition revision 快照；节点状态、分支选择和审批 checkpoint 持久化后才继续。

import type { RunTaskManager } from '../agent/runTaskManager.js'
import type { ToolRegistry } from '../framework/registry.js'
import type {
  AgentRuntimeConfig,
  AgentState,
  AgentThreadRecord,
  AnalysisRun,
  SessionRecord,
  TranscriptEntry,
} from '../schemas/types.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { ModelCompletionService } from '../model/modelResultCache.js'
import type { SecurityServices } from '../security/routes.js'
import type { AuthContext } from '../security/types.js'
import type { AutomationStore } from '../store/postgres/automationStore.js'
import type { ResourceOwner } from '../store/sessionStore.js'
import type { PersistentToolStore } from '../store/runtimePorts.js'
import type { RuntimeConfigStore } from '../store/postgres/runtimeConfigStore.js'
import type { UsageStatsService } from '../usage/usageStatsService.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { resolveRuntimeConfig } from '../ws/runtimeConfig.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import { automationNodeDurationMs, automationNodeExecutionsTotal, automationRunsTotal } from '../observability/metrics.js'
import { executePersistedTool } from '../tools/persistentToolExecutor.js'
import type { ToolResultCommitService } from '../tools/resultPersistence.js'
import { computeNextFireAt } from './cronSchedule.js'
import type { AutomationJobPayload } from './jobQueueService.js'
import { automationJobPayloadSchema } from './jobQueueService.js'
import {
  evaluateAutomationCondition,
  renderAutomationPrompt,
  resolveAutomationArguments,
  resolveAutomationBinding,
  type AutomationBindingContext,
} from './automationBindings.js'
import type { CompiledAutomation, AutomationCompiler } from './automationCompiler.js'
import type { AutomationDefinitionService } from './automationDefinitionService.js'
import type { BackgroundTaskRegistry } from './backgroundTaskRegistry.js'
import {
  createAutomationExecutionState,
  parseAutomationExecutionState,
  withExecutionState,
  type AutomationExecutionState,
} from './automationExecutionState.js'
import type { AutomationNode, AutomationNodeRun, AutomationRunRecord } from './schemas.js'

export interface AutomationRunnerOptions {
  automations: Pick<AutomationStore,
    | 'createAutomationRunRecord'
    | 'getAutomationRunRecord'
    | 'getScheduledTask'
    | 'updateAutomationRunRecord'
    | 'updateScheduledTask'
  >
  conversations: AutomationConversationPort
  toolExecutionStore: PersistentToolStore
  resultCommitService: Pick<ToolResultCommitService, 'commit'>
  runtimeConfiguration: Pick<RuntimeConfigStore, 'getRuntimeConfig'>
  definitions: AutomationDefinitionService
  compiler: AutomationCompiler
  toolRegistry: ToolRegistry
  runTasks: RunTaskManager
  modelRegistry: ModelAdapterRegistry
  modelCompletions?: ModelCompletionService
  security: SecurityServices
  usageStats: UsageStatsService
  backgroundTasks: BackgroundTaskRegistry
  defaultRuntimeConfig?: AgentRuntimeConfig
  unscheduleTask?: (taskId: string) => Promise<void>
}

interface AutomationConversationPort {
  activeTranscript(threadId: string): Promise<TranscriptEntry[]>
  completeRun(runId: string, status: string): Promise<AnalysisRun>
  createRun(sessionId: string, query: string, options?: {
    threadId?: string | null
    modelProvider?: string | null
    modelName?: string | null
    runtimeConfigSnapshot?: AgentRuntimeConfig | null
  }): Promise<AnalysisRun>
  createThread(sessionId: string, title?: string | null): Promise<AgentThreadRecord>
  getOrCreateUserDefaultSession(owner: ResourceOwner): Promise<SessionRecord>
  getRun(runId: string): AnalysisRun
  updateRunState(runId: string, updates: Partial<AgentState>): Promise<AnalysisRun>
  updateRunStatus(runId: string, status: AnalysisRun['status']): Promise<AnalysisRun>
}

export class AutomationRunner {
  constructor(private readonly options: AutomationRunnerOptions) {}

  async executeAttached(automationRunId: string, auth: AuthContext, signal: AbortSignal): Promise<AutomationRunRecord> {
    const automationRun = await this.requireAutomationRun(automationRunId)
    if (automationRun.triggerKind !== 'agent') {
      throw new Error('只有智能体触发的自动化流程可以附着到现有运行。')
    }
    try {
      await this.executeAutomationRun(automationRun, auth, signal)
      return this.requireAutomationRun(automationRunId)
    } catch (error) {
      await this.failAutomationRun(automationRunId, error)
      throw error
    }
  }

  async executeQueuedJob(rawPayload: AutomationJobPayload, queueJobId: string): Promise<void> {
    const payload = automationJobPayloadSchema.parse(rawPayload)
    // 审批恢复仍携带原 automationRunId。它必须继续原 revision 快照，不能因为
    // triggerKind= schedule 而按本次队列 jobId 新建一条运行并从头执行。
    if (payload.automationRunId) await this.executePersisted(payload)
    else if (payload.triggerKind === 'schedule') await this.executeScheduled(payload, queueJobId)
    else throw new Error('手动自动化流程任务缺少 automationRunId。')
  }

  private async executePersisted(payload: AutomationJobPayload): Promise<void> {
    const automationRunId = requireAutomationRunId(payload)
    const automationRun = await this.requireAutomationRun(automationRunId)
    if (automationRun.automationId !== payload.automationId
      || automationRun.workspaceId !== payload.workspaceId
      || automationRun.createdByUserId !== payload.triggeredByUserId
      || automationRun.triggerKind !== payload.triggerKind) {
      throw new Error('自动化流程队列载荷与持久化运行归属不一致。')
    }
    if (automationRun.status === 'completed' || automationRun.status === 'cancelled' || automationRun.status === 'waiting_approval') return
    if (automationRun.status === 'failed') throw new Error('自动化流程运行已经失败，队列不会隐式重置节点状态。')
    let auth: AuthContext | null = null
    try {
      auth = await this.options.security.auth.buildServiceAuthContext(payload.triggeredByUserId, payload.workspaceId)
      await this.options.security.authorization.enforce(auth, 'automation', 'execute', {
        workspaceId: payload.workspaceId,
        resourceId: payload.automationId,
      })
      await this.executeTracked(automationRun, auth)
    } catch (error) {
      await this.failAutomationRun(automationRunId, error)
      await this.options.security.authorization.audit(auth, 'automation', 'execute', {
        workspaceId: payload.workspaceId,
        resourceId: payload.automationId,
      }, 'error', { automationRunId, error: formatAutomationError(error) })
      logger.warn({ error: errorLogPayload(error), automationRunId, automationId: payload.automationId }, 'persisted automation failed')
      throw error
    }
  }

  private async executeScheduled(payload: AutomationJobPayload, queueJobId: string): Promise<void> {
    if (!payload.scheduledTaskId) throw new Error('定时任务 job 缺少 scheduledTaskId。')
    const task = await this.options.automations.getScheduledTask(payload.scheduledTaskId)
    if (!task || task.status === 'deleted') throw new Error(`定时任务 '${payload.scheduledTaskId}' 不存在或已删除。`)
    if (!task.enabled || task.status !== 'active') throw new Error('定时任务当前未启用。')
    if (!task.recurring && task.nextFireAt && Date.now() - new Date(task.nextFireAt).getTime() > 60_000) {
      await this.options.unscheduleTask?.(task.taskId)
      await this.options.automations.updateScheduledTask(task.taskId, {
        enabled: false,
        status: 'missed',
        queueJobId: null,
        lastErrorMessage: '一次性任务触发时间已错过，系统不会补执行。',
      })
      return
    }
    const definition = await this.options.definitions.requirePublished(task.workspaceId, task.targetId)
    const compiled = this.options.compiler.compile(definition)
    const parameters = { ...definition.defaultParameters, ...task.parameters }
    compiled.validateParameters(parameters)
    const automationRunId = `automation_run_${queueJobId}`
    const existing = await this.options.automations.getAutomationRunRecord(automationRunId)
    if (existing?.status === 'completed' || existing?.status === 'cancelled' || existing?.status === 'waiting_approval') return
    if (existing?.status === 'failed') throw new Error('该次定时自动化流程运行已经失败，不会创建重复运行。')
    const executionState = createAutomationExecutionState({ definition, prompt: task.prompt, parameters })
    const automationRun = existing ?? await this.options.automations.createAutomationRunRecord({
      automationRunId,
      automationId: definition.automationId,
      automationRevision: definition.revision,
      scheduledTaskId: task.taskId,
      workspaceId: task.workspaceId,
      createdByUserId: task.createdByUserId,
      runId: null,
      status: 'queued',
      currentStep: definition.graph.entryNodeId,
      triggerKind: 'schedule',
      metadata: withExecutionState({ queueJobId }, executionState),
      nodeRuns: executionState.nodeRuns,
    })
    let auth: AuthContext | null = null
    try {
      auth = await this.options.security.auth.buildServiceAuthContext(task.createdByUserId, task.workspaceId)
      await this.options.security.authorization.enforce(auth, 'automation', 'execute', {
        workspaceId: task.workspaceId,
        resourceId: task.targetId,
      })
      await this.executeTracked(automationRun, auth)
      await this.updateTaskAfterFire(task.taskId, task.recurring, task.cron, task.timezone, automationRunId, null)
    } catch (error) {
      await this.failAutomationRun(automationRunId, error)
      await this.options.security.authorization.audit(auth, 'automation', 'execute', {
        workspaceId: task.workspaceId,
        resourceId: task.targetId,
      }, 'error', { automationRunId, scheduledTaskId: task.taskId, error: formatAutomationError(error) })
      await this.updateTaskAfterFire(task.taskId, task.recurring, task.cron, task.timezone, automationRunId, error)
      logger.warn({ error: errorLogPayload(error), taskId: task.taskId, automationRunId }, 'scheduled automation failed')
      throw error
    }
  }

  private async executeAutomationRun(
    initialRecord: AutomationRunRecord,
    auth: AuthContext,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    let record = initialRecord
    let state = parseAutomationExecutionState(record.metadata)
    const interrupted = state.nodeRuns.filter(node => node.status === 'running')
    if (record.status === 'running' && interrupted.length) {
      const labels = interrupted.map(node => node.label).join('、')
      const message = `自动化流程上次在节点“${labels}”执行中断，结果状态不明确。为避免重复副作用，系统不会自动重跑该节点。`
      state = {
        ...state,
        currentAgentRunId: null,
        nodeRuns: state.nodeRuns.map(node => node.status === 'running'
          ? { ...node, status: 'failed' as const, completedAt: nowUtc(), errorMessage: message }
          : node),
      }
      await this.options.automations.updateAutomationRunRecord(record.automationRunId, {
        currentStep: interrupted[0]?.nodeId ?? null,
        errorMessage: message,
        nodeRuns: state.nodeRuns,
        metadata: withExecutionState(record.metadata, state),
        expectedStatuses: ['running'],
      })
      throw new Error(message)
    }
    const compiled = this.options.compiler.compile(state.definitionSnapshot)
    compiled.validateParameters(state.parameters)
    state = await this.ensureOrchestrationRun(record, state, auth)
    record = await this.persistState(record, state, 'running')

    while (true) {
      signal.throwIfAborted()
      const latest = await this.requireAutomationRun(record.automationRunId)
      if (latest.status === 'cancelled') {
        await this.cancelOrchestrationRun(state)
        return
      }
      state = parseAutomationExecutionState(latest.metadata)
      if (state.pendingApproval?.status === 'pending') return

      const next = findNextNode(compiled, state)
      if (!next) {
        const incomplete = state.nodeRuns.filter(node => !isTerminal(node.status))
        if (incomplete.length) throw new Error(`自动化流程无法继续，仍有未决节点：${incomplete.map(node => node.label).join('、')}`)
        await this.completeAutomationRun(latest, state, auth)
        return
      }
      if (next.action === 'skip') {
        state = updateNodeRun(state, next.node.nodeId, {
          status: 'skipped',
          completedAt: nowUtc(),
          errorMessage: null,
        })
        record = await this.persistState(latest, state, 'running')
        continue
      }

      const nodeStartedAt = performance.now()
      let outcome: Awaited<ReturnType<AutomationRunner['executeNode']>>
      try {
        outcome = await this.executeNode(compiled, next.node, latest, state, auth, signal)
        automationNodeExecutionsTotal.inc({ node_type: next.node.type, status: outcome.paused ? 'waiting_approval' : 'completed' })
      } catch (error) {
        automationNodeExecutionsTotal.inc({ node_type: next.node.type, status: 'failed' })
        throw error
      } finally {
        automationNodeDurationMs.observe({ node_type: next.node.type }, performance.now() - nodeStartedAt)
      }
      state = outcome.state
      record = await this.persistState(latest, state, outcome.paused ? 'waiting_approval' : 'running')
      if (outcome.paused) {
        if (state.orchestrationRunId) await this.options.conversations.updateRunStatus(state.orchestrationRunId, 'waiting_approval')
        return
      }
    }
  }

  private executeTracked(record: AutomationRunRecord, auth: AuthContext): Promise<void> {
    const state = parseAutomationExecutionState(record.metadata)
    return this.options.backgroundTasks.start({
      taskId: `automation:${record.automationRunId}`,
      label: `自动化流程：${record.automationId}`,
      kind: 'automation_run',
      workspaceId: record.workspaceId,
      userId: record.createdByUserId,
      metadata: { automationRunId: record.automationRunId, automationId: record.automationId },
      run: signal => this.executeAutomationRun(record, auth, AbortSignal.any([
        signal,
        AbortSignal.timeout(state.definitionSnapshot.timeoutSeconds * 1_000),
      ])),
    })
  }

  private async executeNode(
    compiled: CompiledAutomation,
    node: AutomationNode,
    record: AutomationRunRecord,
    state: AutomationExecutionState,
    auth: AuthContext,
    signal: AbortSignal,
  ): Promise<{ state: AutomationExecutionState; paused: boolean }> {
    signal.throwIfAborted()
    let nextState = updateNodeRun(state, node.nodeId, {
      status: 'running',
      startedAt: nowUtc(),
      attempt: nodeRun(state, node.nodeId).attempt + 1,
      errorMessage: null,
    })
    await this.persistState(record, nextState, 'running')
    const context = bindingContext(nextState)
    try {
      if (node.type === 'trigger') {
        return completed(nextState, node, { prompt: state.prompt, parameters: state.parameters }, ['default'])
      }
      if (node.type === 'condition') {
        const left = resolveAutomationBinding(node.config.left, context)
        const right = node.config.right ? resolveAutomationBinding(node.config.right, context) : null
        const result = evaluateAutomationCondition(left, node.config.operator, right)
        return completed(nextState, node, { result, left, right }, [result ? 'true' : 'false'])
      }
      if (node.type === 'approval') {
        const existing = nextState.pendingApproval
        if (existing?.nodeId === node.nodeId && existing.status !== 'pending') {
          return completed(nextState, node, { decision: existing.status }, [existing.status === 'approved' ? 'approved' : 'rejected'])
        }
        const approval = {
          approvalId: makeId('automation_approval'),
          nodeId: node.nodeId,
          title: node.config.title,
          question: node.config.question,
          description: node.config.description,
          status: 'pending' as const,
          createdAt: nowUtc(),
          resolvedAt: null,
          resolvedByUserId: null,
        }
        nextState = updateNodeRun({ ...nextState, pendingApproval: approval }, node.nodeId, { status: 'waiting_approval' })
        return { state: nextState, paused: true }
      }
      if (node.type === 'tool') {
        const tool = this.options.toolRegistry.get(node.config.toolName)
        if (!tool) throw new Error(`工具“${node.label}”未注册。`)
        await this.options.security.authorization.enforce(auth, 'tool', 'execute', {
          workspaceId: record.workspaceId,
          resourceId: node.config.toolName,
        })
        const needsApproval = node.config.approvalMode === 'always' || tool.isDestructive || tool.requiresApproval === true
        if (needsApproval && !nextState.approvedNodeIds.includes(node.nodeId)) {
          const approval = {
            approvalId: makeId('automation_approval'),
            nodeId: node.nodeId,
            title: `批准执行：${tool.label}`,
            question: `是否允许自动化流程执行工具“${tool.label}”？`,
            description: tool.isDestructive ? '该工具包含破坏性操作。' : '该工具声明需要人工批准。',
            status: 'pending' as const,
            createdAt: nowUtc(),
            resolvedAt: null,
            resolvedByUserId: null,
          }
          nextState = updateNodeRun({ ...nextState, pendingApproval: approval }, node.nodeId, { status: 'waiting_approval' })
          return { state: nextState, paused: true }
        }
        const args = resolveAutomationArguments(node.config.arguments, context)
        const result = await retry(node.config.retry, async () => executePersistedTool({
          runId: requireOrchestrationRunId(nextState),
          toolName: node.config.toolName,
          args,
          auth,
          executionSurface: 'automation',
          signal,
        }, {
          store: this.options.toolExecutionStore,
          runtimeConfiguration: this.options.runtimeConfiguration,
          resultCommitService: this.options.resultCommitService,
          registry: this.options.toolRegistry,
          modelRegistry: this.options.modelRegistry,
          ...(this.options.modelCompletions ? { modelCompletions: this.options.modelCompletions } : {}),
          defaultRuntimeConfig: this.options.defaultRuntimeConfig,
        }), signal)
        return completed(nextState, node, {
          message: result.message,
          payload: result.payload,
          valueRefs: result.valueRefs ?? [],
          artifacts: result.artifacts ?? [],
          resultId: result.resultId,
          source: result.source,
        }, successPorts(compiled, node.nodeId))
      }
      if (node.type === 'agent') {
        this.options.usageStats.assertWorkspaceCanStartModelRun(auth)
        const prompt = renderAutomationPrompt(node.config.promptTemplate, context)
        const response = await retry(
          node.config.retry,
          () => this.executeAgentNode(record, nextState, node.nodeId, prompt, node.config, auth, signal),
          signal,
        )
        nextState = { ...nextState, currentAgentRunId: null }
        return completed(nextState, node, response, successPorts(compiled, node.nodeId))
      }
      const outputs = Object.fromEntries(Object.entries(node.config.outputs).map(([name, binding]) => [
        name,
        resolveAutomationBinding(binding, context),
      ]))
      return completed(nextState, node, outputs, [])
    } catch (error) {
      const message = formatAutomationError(error)
      const errorEdges = compiled.outgoingEdges.get(node.nodeId)?.filter(edge => edge.sourcePort === 'error') ?? []
      nextState = updateNodeRun(nextState, node.nodeId, {
        status: 'failed',
        completedAt: nowUtc(),
        errorMessage: message,
        output: { error: message },
      })
      nextState = {
        ...nextState,
        nodeOutputs: { ...nextState.nodeOutputs, [node.nodeId]: { error: message } },
        selectedPorts: { ...nextState.selectedPorts, [node.nodeId]: errorEdges.length ? ['error'] : [] },
        currentAgentRunId: null,
      }
      if (errorEdges.length) return { state: nextState, paused: false }
      await this.options.automations.updateAutomationRunRecord(record.automationRunId, {
        status: 'failed',
        currentStep: node.nodeId,
        errorMessage: message,
        nodeRuns: nextState.nodeRuns,
        metadata: withExecutionState(record.metadata, nextState),
        completedAt: nowUtc(),
        expectedStatuses: [record.status],
      })
      throw error
    }
  }

  private async executeAgentNode(
    record: AutomationRunRecord,
    state: AutomationExecutionState,
    nodeId: string,
    prompt: string,
    config: Extract<AutomationNode, { type: 'agent' }>['config'],
    auth: AuthContext,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const sessionId = requireString(state.sessionId, '自动化流程会话 ID')
    const threadId = requireString(state.threadId, '自动化流程线程 ID')
    const runtimeConfig = await resolveRuntimeConfig(this.options.runtimeConfiguration, this.options.defaultRuntimeConfig)
    const provider = this.options.modelRegistry.defaultProvider
    if (!provider) throw new Error('必须配置默认模型提供方，自动化流程的智能体节点才能执行。')
    const run = await this.options.conversations.createRun(sessionId, prompt, {
      threadId,
      modelProvider: provider,
      modelName: null,
      runtimeConfigSnapshot: runtimeConfig,
    })
    const nextState = { ...state, currentAgentRunId: run.id }
    await this.persistState(record, nextState, 'running')
    const cancelAgentRun = (): void => {
      void this.options.runTasks.cancel(run.id)
    }
    signal.addEventListener('abort', cancelAgentRun, { once: true })
    let completedRun: Awaited<ReturnType<RunTaskManager['start']>>
    try {
      signal.throwIfAborted()
      completedRun = await this.options.runTasks.start({
        runId: run.id,
        threadId,
        sessionId,
        query: prompt,
        provider,
        modelName: run.modelName,
        runtimeConfig,
        executionMode: config.executionMode,
        reasoning: config.reasoning,
        auth,
      })
      signal.throwIfAborted()
    } finally {
      signal.removeEventListener('abort', cancelAgentRun)
    }
    if (completedRun.status !== 'completed') {
      throw new Error(completedRun.state.errors.at(-1) ?? `Agent 节点 '${nodeId}' 状态为 ${completedRun.status}。`)
    }
    const response = await latestAssistantResponse(this.options.conversations, threadId, completedRun.id)
    return { runId: completedRun.id, threadId, response }
  }

  private async ensureOrchestrationRun(
    record: AutomationRunRecord,
    state: AutomationExecutionState,
    auth: AuthContext,
  ): Promise<AutomationExecutionState> {
    if (state.sessionId && state.threadId && state.orchestrationRunId) {
      if (state.orchestrationRunOwnership === 'automation'
        && this.options.conversations.getRun(state.orchestrationRunId).status === 'waiting_approval') {
        await this.options.conversations.updateRunStatus(state.orchestrationRunId, 'running')
      }
      return state
    }
    const session = await this.options.conversations.getOrCreateUserDefaultSession({
      workspaceId: record.workspaceId,
      userId: record.createdByUserId,
    })
    const thread = await this.options.conversations.createThread(session.id, state.definitionSnapshot.name)
    const config = await resolveRuntimeConfig(this.options.runtimeConfiguration, this.options.defaultRuntimeConfig)
    const run = await this.options.conversations.createRun(session.id, state.prompt || state.definitionSnapshot.name, {
      threadId: thread.id,
      modelProvider: this.options.modelRegistry.defaultProvider || null,
      modelName: null,
      runtimeConfigSnapshot: config,
    })
    await this.options.conversations.updateRunStatus(run.id, 'running')
    this.options.backgroundTasks.updateInfo(`automation:${record.automationRunId}`, {
      runId: run.id,
      metadata: {
        automationRunId: record.automationRunId,
        automationId: record.automationId,
        sessionId: session.id,
        threadId: thread.id,
      },
    })
    await this.options.security.authorization.audit(auth, 'automation', 'execute', {
      workspaceId: record.workspaceId,
      resourceId: record.automationId,
    }, 'allowed', { automationRunId: record.automationRunId, revision: record.automationRevision, runId: run.id })
    return {
      ...state,
      sessionId: session.id,
      threadId: thread.id,
      orchestrationRunId: run.id,
    }
  }

  private async persistState(
    record: AutomationRunRecord,
    state: AutomationExecutionState,
    status: AutomationRunRecord['status'],
  ): Promise<AutomationRunRecord> {
    const current = state.nodeRuns.find(node => node.status === 'running' || node.status === 'waiting_approval')
    return this.options.automations.updateAutomationRunRecord(record.automationRunId, {
      runId: state.orchestrationRunId,
      status,
      currentStep: current?.nodeId ?? null,
      errorMessage: null,
      metadata: withExecutionState(record.metadata, state),
      nodeRuns: state.nodeRuns,
      pendingApproval: state.pendingApproval,
      expectedStatuses: [record.status],
    })
  }

  private async completeAutomationRun(record: AutomationRunRecord, state: AutomationExecutionState, auth: AuthContext): Promise<void> {
    const outputNodes = state.definitionSnapshot.graph.nodes.filter(node => node.type === 'output')
    const outputs = Object.assign({}, ...outputNodes.map(node => state.nodeOutputs[node.nodeId] ?? {})) as Record<string, unknown>
    if (state.definitionSnapshot.agentInvocation.enabled
      && (typeof outputs.answer !== 'string' || !outputs.answer.trim())) {
      throw new Error(`自动化流程“${state.definitionSnapshot.name}”没有生成可交付的回答。`)
    }
    if (state.orchestrationRunId && state.orchestrationRunOwnership === 'automation') {
      await this.options.conversations.completeRun(state.orchestrationRunId, 'completed')
    }
    await this.options.automations.updateAutomationRunRecord(record.automationRunId, {
      status: 'completed',
      currentStep: null,
      outputs,
      pendingApproval: null,
      metadata: withExecutionState(record.metadata, { ...state, pendingApproval: null }),
      nodeRuns: state.nodeRuns,
      completedAt: nowUtc(),
      expectedStatuses: [record.status],
    })
    await this.options.security.authorization.audit(auth, 'automation', 'execute', {
      workspaceId: record.workspaceId,
      resourceId: record.automationId,
    }, 'allowed', { automationRunId: record.automationRunId, revision: record.automationRevision, status: 'completed' })
    automationRunsTotal.inc({ trigger: record.triggerKind, status: 'completed' })
  }

  private async failAutomationRun(automationRunId: string, error: unknown): Promise<void> {
    const record = await this.options.automations.getAutomationRunRecord(automationRunId)
    if (!record || record.status === 'cancelled' || record.status === 'completed') return
    const message = formatAutomationError(error)
    const state = parseAutomationExecutionState(record.metadata)
    if (state.orchestrationRunId && state.orchestrationRunOwnership === 'automation') {
      const run = this.options.conversations.getRun(state.orchestrationRunId)
      if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
        await this.options.conversations.updateRunState(run.id, { errors: [...run.state.errors, message] })
        await this.options.conversations.completeRun(run.id, 'failed')
      }
    }
    await this.options.automations.updateAutomationRunRecord(automationRunId, {
      status: 'failed',
      errorMessage: message,
      completedAt: nowUtc(),
      nodeRuns: state.nodeRuns,
      metadata: withExecutionState(record.metadata, state),
      expectedStatuses: [record.status],
    })
    automationRunsTotal.inc({ trigger: record.triggerKind, status: 'failed' })
  }

  private async cancelOrchestrationRun(state: AutomationExecutionState): Promise<void> {
    if (state.currentAgentRunId) await this.options.runTasks.cancel(state.currentAgentRunId)
    if (state.orchestrationRunId && state.orchestrationRunOwnership === 'automation') {
      const run = this.options.conversations.getRun(state.orchestrationRunId)
      if (!['completed', 'failed', 'cancelled'].includes(run.status)) await this.options.conversations.completeRun(run.id, 'cancelled')
    }
  }

  private async requireAutomationRun(automationRunId: string): Promise<AutomationRunRecord> {
    const run = await this.options.automations.getAutomationRunRecord(automationRunId)
    if (!run) throw new Error(`自动化流程运行 '${automationRunId}' 不存在。`)
    return run
  }

  private async updateTaskAfterFire(
    taskId: string,
    recurring: boolean,
    cron: string,
    timezone: string,
    automationRunId: string,
    error: unknown,
  ): Promise<void> {
    const task = await this.options.automations.getScheduledTask(taskId)
    const failureCount = (task?.failureCount ?? 0) + (error ? 1 : 0)
    if (!recurring) {
      await this.options.unscheduleTask?.(taskId)
      await this.options.automations.updateScheduledTask(taskId, {
        enabled: false,
        status: error ? 'failed' : 'paused',
        lastFiredAt: nowUtc(),
        nextFireAt: null,
        lastRunId: automationRunId,
        queueJobId: null,
        failureCount,
        lastErrorMessage: error ? formatAutomationError(error) : null,
      })
      return
    }
    await this.options.automations.updateScheduledTask(taskId, {
      status: 'active',
      lastFiredAt: nowUtc(),
      nextFireAt: computeNextFireAt({ cron, timezone, from: new Date() }),
      lastRunId: automationRunId,
      failureCount,
      lastErrorMessage: error ? formatAutomationError(error) : null,
    })
  }
}

function findNextNode(
  compiled: CompiledAutomation,
  state: AutomationExecutionState,
): { node: AutomationNode; action: 'execute' | 'skip' } | null {
  for (const nodeId of compiled.topologicalOrder) {
    const current = nodeRun(state, nodeId)
    if (current.status !== 'pending') continue
    const node = compiled.nodesById.get(nodeId)
    if (!node) throw new Error(`编译结果缺少节点 '${nodeId}'。`)
    const incoming = compiled.incomingEdges.get(nodeId) ?? []
    if (incoming.length === 0) return { node, action: 'execute' }
    const sourceRuns = incoming.map(edge => nodeRun(state, edge.sourceNodeId))
    if (sourceRuns.some(source => !isTerminal(source.status))) continue
    const active = incoming.some(edge => (state.selectedPorts[edge.sourceNodeId] ?? []).includes(edge.sourcePort))
    return { node, action: active ? 'execute' : 'skip' }
  }
  return null
}

function completed(
  state: AutomationExecutionState,
  node: AutomationNode,
  output: Record<string, unknown>,
  ports: string[],
): { state: AutomationExecutionState; paused: false } {
  const next = updateNodeRun(state, node.nodeId, {
    status: 'completed',
    completedAt: nowUtc(),
    errorMessage: null,
    output,
  })
  return {
    state: {
      ...next,
      nodeOutputs: { ...next.nodeOutputs, [node.nodeId]: output },
      selectedPorts: { ...next.selectedPorts, [node.nodeId]: ports },
      pendingApproval: next.pendingApproval?.nodeId === node.nodeId ? null : next.pendingApproval,
    },
    paused: false,
  }
}

function successPorts(compiled: CompiledAutomation, nodeId: string): string[] {
  const edges = compiled.outgoingEdges.get(nodeId) ?? []
  const ports = new Set(edges
    .map(edge => edge.sourcePort)
    .filter(port => port === 'default' || port === 'success'))
  return ports.size ? [...ports] : ['default']
}

function updateNodeRun(
  state: AutomationExecutionState,
  nodeId: string,
  patch: Partial<AutomationNodeRun>,
): AutomationExecutionState {
  let found = false
  const nodeRuns = state.nodeRuns.map(node => {
    if (node.nodeId !== nodeId) return node
    found = true
    return { ...node, ...patch }
  })
  if (!found) throw new Error(`自动化流程运行状态缺少节点 '${nodeId}'。`)
  return { ...state, nodeRuns }
}

function nodeRun(state: AutomationExecutionState, nodeId: string): AutomationNodeRun {
  const run = state.nodeRuns.find(node => node.nodeId === nodeId)
  if (!run) throw new Error(`自动化流程运行状态缺少节点 '${nodeId}'。`)
  return run
}

function bindingContext(state: AutomationExecutionState): AutomationBindingContext {
  return { prompt: state.prompt, parameters: state.parameters, nodeOutputs: state.nodeOutputs }
}

async function retry<T>(
  policy: { maxAttempts: number; backoffSeconds: number },
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    signal.throwIfAborted()
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt < policy.maxAttempts && policy.backoffSeconds > 0) {
        await abortableDelay(policy.backoffSeconds * 1_000, signal)
      }
    }
  }
  throw lastError
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const finish = (): void => {
      cleanup()
      resolve()
    }
    const abort = (): void => {
      cleanup()
      reject(signal.reason)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    const timer = setTimeout(finish, milliseconds)
    timer.unref?.()
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function latestAssistantResponse(
  store: Pick<AutomationConversationPort, 'activeTranscript'>,
  threadId: string,
  runId: string,
): Promise<string> {
  const entries = await store.activeTranscript(threadId)
  const entry = [...entries].reverse().find(item => (
    item.runId === runId
    && item.kind === 'message'
    && item.payload.role === 'assistant'
    && typeof item.payload.content === 'string'
  ))
  if (!entry || typeof entry.payload.content !== 'string' || !entry.payload.content.trim()) {
    throw new Error('Agent 节点完成但没有可用的助手输出。')
  }
  return entry.payload.content.trim()
}

function isTerminal(status: AutomationNodeRun['status']): boolean {
  return status === 'completed' || status === 'skipped' || status === 'failed' || status === 'cancelled'
}

function requireAutomationRunId(payload: AutomationJobPayload): string {
  if (!payload.automationRunId) throw new Error('手动自动化流程任务缺少运行 ID。')
  return payload.automationRunId
}

function requireOrchestrationRunId(state: AutomationExecutionState): string {
  return requireString(state.orchestrationRunId, '自动化流程编排运行 ID')
}

function requireString(value: string | null, label: string): string {
  if (!value) throw new Error(`${label} 尚未建立。`)
  return value
}

function formatAutomationError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return '自动化流程执行超时。'
  if (error instanceof DOMException && error.name === 'AbortError') return '自动化流程执行已取消。'
  return error instanceof Error && error.message.trim() ? error.message : '自动化流程执行失败。'
}

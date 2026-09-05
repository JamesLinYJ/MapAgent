// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 调度服务
//
//   文件:       scheduledTaskService.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 平台 Automation 启动、审批、取消、定时任务和进程内后台任务服务。
// 定义版本由 AutomationDefinitionService 管理，持久队列由 pg-boss 管理。

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RunTaskManager } from '../agent/runTaskManager.js'
import type { SecurityServices } from '../security/routes.js'
import type { AuthContext } from '../security/types.js'
import type { AnalysisRun } from '../schemas/types.js'
import type { AutomationStore } from '../store/postgres/automationStore.js'
import type { UsageStatsService } from '../usage/usageStatsService.js'
import { makeId, nowUtc } from '../utils/ids.js'
import { automationRunsTotal } from '../observability/metrics.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import { assertSupportedCronExpression, computeNextFireAt } from './cronSchedule.js'
import type { BackgroundTaskRegistry } from './backgroundTaskRegistry.js'
import type { AutomationJobPayload, JobQueueService } from './jobQueueService.js'
import type { ScheduledTask, AutomationNodeRun, AutomationRunRecord } from './schemas.js'
import type { AutomationCompiler } from './automationCompiler.js'
import type { AutomationDefinitionService } from './automationDefinitionService.js'
import {
  createAutomationExecutionState,
  parseAutomationExecutionState,
  withExecutionState,
} from './automationExecutionState.js'

const automationDispatchMetadataSchema = z.object({
  dispatchId: z.string().min(1),
  queueJobId: z.string().uuid(),
}).passthrough()

export interface AutomationStartInput {
  automationId: string
  prompt: string
  parameters?: Record<string, unknown> | undefined
}

export interface ScheduledTaskMutationInput {
  targetKind: 'automation'
  targetId: string
  title?: string | null | undefined
  prompt: string
  parameters?: Record<string, unknown> | undefined
  cron: string
  timezone: string
  recurring?: boolean | undefined
  enabled?: boolean | undefined
}

export type ScheduledTaskPatchInput = {
  [Key in keyof ScheduledTaskMutationInput]?: ScheduledTaskMutationInput[Key] | undefined
}

interface NormalizedScheduledTaskMutation {
  targetKind: 'automation'
  targetId: string
  title: string | null
  prompt: string
  parameters: Record<string, unknown>
  cron: string
  timezone: string
  recurring: boolean
  enabled: boolean
}

export interface ScheduledTaskSnapshot {
  tasks: ScheduledTask[]
  automationRuns: AutomationRunRecord[]
}

export interface ScheduledTaskConversationPort {
  getRun(runId: string): AnalysisRun
  completeRun(runId: string, status: string): Promise<AnalysisRun>
}

export class ScheduledTaskService {
  constructor(private readonly deps: {
    automations: Pick<AutomationStore,
      | 'createAutomationRunRecord'
      | 'createScheduledTask'
      | 'deleteScheduledTask'
      | 'getAutomationRunRecord'
      | 'getScheduledTask'
      | 'listActiveScheduledTasks'
      | 'listAutomationRuns'
      | 'listQueuedAutomationRuns'
      | 'listScheduledTasks'
      | 'updateAutomationRunRecord'
      | 'updateScheduledTask'
    >
    conversations: ScheduledTaskConversationPort
    definitions: AutomationDefinitionService
    compiler: AutomationCompiler
    jobQueue: JobQueueService
    backgroundTasks: BackgroundTaskRegistry
    runTasks: RunTaskManager
    usageStats: UsageStatsService
    security: SecurityServices
  }) {}

  async reconcileSchedules(): Promise<void> {
    const tasks = await this.deps.automations.listActiveScheduledTasks()
    for (const task of tasks) {
      try {
        if (isMissedOneShot(task)) {
          await this.deps.jobQueue.unscheduleTask(task.taskId, task.queueJobId)
          await this.deps.automations.updateScheduledTask(task.taskId, {
            enabled: false,
            status: 'missed',
            queueJobId: null,
            lastErrorMessage: '一次性任务触发时间已错过，系统不会补执行。',
          })
          continue
        }
        await this.registerTaskSchedule(task)
      } catch (error) {
        logger.error({ error: errorLogPayload(error), taskId: task.taskId }, 'scheduled task reconciliation failed')
        await this.markScheduleRegistrationFailed(task)
      }
    }
  }

  async reconcileQueuedAutomationRuns(): Promise<void> {
    const queuedRuns = await this.deps.automations.listQueuedAutomationRuns()
    for (const automationRun of queuedRuns) {
      if (automationRun.triggerKind === 'agent') {
        await this.failUndispatchableRun(
          automationRun,
          '智能体附着的 Automation 不应进入持久任务队列，系统已停止恢复。',
        )
        continue
      }
      const dispatch = automationDispatchMetadataSchema.safeParse(automationRun.metadata)
      if (!dispatch.success) {
        await this.failUndispatchableRun(
          automationRun,
          'Automation 排队记录缺少可核验的 dispatchId 或 queueJobId，为避免重复执行，系统不会自动补发。',
        )
        continue
      }
      let state: ReturnType<typeof parseAutomationExecutionState>
      try {
        state = parseAutomationExecutionState(automationRun.metadata)
      } catch (error) {
        logger.error({
          error: errorLogPayload(error),
          automationRunId: automationRun.automationRunId,
        }, 'queued automation execution state is invalid')
        await this.failUndispatchableRun(
          automationRun,
          'Automation 排队记录的执行快照无效，为避免使用漂移定义执行，系统不会自动补发。',
        )
        continue
      }
      try {
        await this.dispatchAutomationRun(automationRun, {
          automationRunId: automationRun.automationRunId,
          scheduledTaskId: automationRun.scheduledTaskId,
          automationId: automationRun.automationId,
          workspaceId: automationRun.workspaceId,
          triggeredByUserId: automationRun.createdByUserId,
          triggerKind: automationRun.triggerKind,
          dispatchId: dispatch.data.dispatchId,
          prompt: state.prompt,
          parameters: state.parameters,
        }, dispatch.data.queueJobId)
        logger.info({
          automationRunId: automationRun.automationRunId,
          queueJobId: dispatch.data.queueJobId,
        }, 'queued automation dispatch reconciled')
      } catch (error) {
        logger.error({
          error: errorLogPayload(error),
          automationRunId: automationRun.automationRunId,
        }, 'queued automation dispatch reconciliation failed')
      }
    }
  }

  async startAutomation(auth: AuthContext, input: AutomationStartInput): Promise<{ automationRun: AutomationRunRecord; jobId: string }> {
    const definition = await this.deps.definitions.requirePublished(auth.defaultWorkspaceId, input.automationId)
    await this.deps.security.authorization.enforce(auth, 'automation', 'execute', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: definition.automationId,
    })
    const compiled = this.deps.compiler.compile(definition)
    if (compiled.definition.graph.nodes.some(node => node.type === 'agent')) {
      this.deps.usageStats.assertWorkspaceCanStartModelRun(auth)
    }
    const parameters = { ...definition.defaultParameters, ...(input.parameters ?? {}) }
    compiled.validateParameters(parameters)
    const executionState = createAutomationExecutionState({
      definition: compiled.definition,
      prompt: input.prompt.trim(),
      parameters,
    })
    const automationRunId = makeId('automation_run')
    const dispatchId = makeId('automation_dispatch')
    const queueJobId = randomUUID()
    const automationRun = await this.deps.automations.createAutomationRunRecord({
      automationRunId,
      automationId: definition.automationId,
      automationRevision: definition.revision,
      scheduledTaskId: null,
      workspaceId: auth.defaultWorkspaceId,
      createdByUserId: auth.userId,
      runId: null,
      status: 'queued',
      currentStep: definition.graph.entryNodeId,
      triggerKind: 'manual',
      metadata: withExecutionState({ dispatchId, queueJobId }, executionState),
      nodeRuns: executionState.nodeRuns,
    })
    const dispatched = await this.dispatchAutomationRun(automationRun, {
      automationRunId,
      scheduledTaskId: null,
      automationId: definition.automationId,
      workspaceId: auth.defaultWorkspaceId,
      triggeredByUserId: auth.userId,
      triggerKind: 'manual',
      dispatchId,
      prompt: input.prompt.trim(),
      parameters,
    }, queueJobId)
    await this.deps.security.authorization.audit(auth, 'automation', 'execute', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: definition.automationId,
    }, 'allowed', { operation: 'enqueue', automationRunId, jobId: queueJobId, revision: definition.revision })
    return { automationRun: dispatched, jobId: queueJobId }
  }

  async cancelAutomation(auth: AuthContext, automationRunId: string): Promise<AutomationRunRecord> {
    const automationRun = await this.requireAutomationRunInWorkspace(auth, automationRunId)
    await this.deps.security.authorization.enforce(auth, 'automation', 'execute', {
      workspaceId: automationRun.workspaceId,
      resourceId: automationRun.automationId,
    })
    if (automationRun.status === 'completed' || automationRun.status === 'failed' || automationRun.status === 'cancelled') {
      throw new Error('该自动化流程运行已经结束，不能取消。')
    }
    const queueJobId = typeof automationRun.metadata.queueJobId === 'string' ? automationRun.metadata.queueJobId : null
    if (queueJobId) await this.deps.jobQueue.cancelAutomationJob(queueJobId)
    const state = parseAutomationExecutionState(automationRun.metadata)
    if (state.currentAgentRunId) await this.deps.runTasks.cancel(state.currentAgentRunId)
    if (state.orchestrationRunId) {
      const run = this.deps.conversations.getRun(state.orchestrationRunId)
      if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
        await this.deps.conversations.completeRun(run.id, 'cancelled')
      }
    }
    const nodeRuns = state.nodeRuns.map(node => (
      node.status === 'pending' || node.status === 'running' || node.status === 'waiting_approval'
        ? { ...node, status: 'cancelled' as const, completedAt: nowUtc() }
        : node
    ))
    const cancelled = await this.deps.automations.updateAutomationRunRecord(automationRunId, {
      status: 'cancelled',
      currentStep: null,
      pendingApproval: null,
      nodeRuns,
      metadata: withExecutionState(automationRun.metadata, { ...state, nodeRuns, pendingApproval: null }),
      completedAt: nowUtc(),
      expectedStatuses: [automationRun.status],
    })
    const backgroundTaskId = `automation:${automationRunId}`
    if (this.deps.backgroundTasks.get(backgroundTaskId)?.status === 'running') {
      this.deps.backgroundTasks.cancel(backgroundTaskId)
    }
    automationRunsTotal.inc({ trigger: automationRun.triggerKind, status: 'cancelled' })
    await this.deps.security.authorization.audit(auth, 'automation', 'execute', {
      workspaceId: automationRun.workspaceId,
      resourceId: automationRun.automationId,
    }, 'allowed', { operation: 'cancel', automationRunId })
    return cancelled
  }

  async respondApproval(
    auth: AuthContext,
    automationRunId: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<{ automationRun: AutomationRunRecord; jobId: string | null }> {
    const automationRun = await this.requireAutomationRunInWorkspace(auth, automationRunId)
    await this.deps.security.authorization.enforce(auth, 'automation', 'approve', {
      workspaceId: automationRun.workspaceId,
      resourceId: automationRun.automationId,
    })
    const triggerKind = automationRun.triggerKind
    if (triggerKind === 'agent') {
      throw new Error('智能体附着式自动化流程不支持审批恢复。')
    }
    if (automationRun.status !== 'waiting_approval') throw new Error('该自动化流程当前不在等待审批。')
    let state = parseAutomationExecutionState(automationRun.metadata)
    const pending = state.pendingApproval
    if (!pending || pending.approvalId !== approvalId || pending.status !== 'pending') {
      throw new Error('自动化流程审批请求不存在、已处理或与运行不匹配。')
    }
    const node = state.definitionSnapshot.graph.nodes.find(item => item.nodeId === pending.nodeId)
    if (!node) throw new Error(`审批节点 '${pending.nodeId}' 不存在。`)
    const resolved = {
      ...pending,
      status: decision,
      resolvedAt: nowUtc(),
      resolvedByUserId: auth.userId,
    }
    state = {
      ...state,
      pendingApproval: resolved,
      nodeRuns: patchNodeRun(state.nodeRuns, node.nodeId, { status: 'pending', errorMessage: null }),
      approvedNodeIds: decision === 'approved' && node.type === 'tool'
        ? [...new Set([...state.approvedNodeIds, node.nodeId])]
        : state.approvedNodeIds,
    }
    if (decision === 'rejected' && node.type === 'tool') {
      const hasErrorEdge = state.definitionSnapshot.graph.edges.some(edge => edge.sourceNodeId === node.nodeId && edge.sourcePort === 'error')
      if (!hasErrorEdge) {
        const rejectedNodeRuns = patchNodeRun(state.nodeRuns, node.nodeId, {
          status: 'failed',
          completedAt: nowUtc(),
          errorMessage: '用户拒绝执行工具。',
          output: { error: '用户拒绝执行工具。' },
        })
        const failed = await this.deps.automations.updateAutomationRunRecord(automationRunId, {
          status: 'failed',
          currentStep: node.nodeId,
          errorMessage: '用户拒绝执行工具，且该节点没有错误分支。',
          nodeRuns: rejectedNodeRuns,
          pendingApproval: resolved,
          metadata: withExecutionState(automationRun.metadata, { ...state, nodeRuns: rejectedNodeRuns }),
          completedAt: nowUtc(),
          expectedStatuses: ['waiting_approval'],
        })
        await this.deps.security.authorization.audit(auth, 'automation', 'approve', {
          workspaceId: automationRun.workspaceId,
          resourceId: automationRun.automationId,
        }, 'allowed', { automationRunId, approvalId, decision, status: 'failed' })
        return { automationRun: failed, jobId: null }
      }
      state = {
        ...state,
        pendingApproval: null,
        selectedPorts: { ...state.selectedPorts, [node.nodeId]: ['error'] },
        nodeOutputs: { ...state.nodeOutputs, [node.nodeId]: { error: '用户拒绝执行工具。' } },
        nodeRuns: patchNodeRun(state.nodeRuns, node.nodeId, {
          status: 'failed',
          completedAt: nowUtc(),
          errorMessage: '用户拒绝执行工具。',
          output: { error: '用户拒绝执行工具。' },
        }),
      }
    }
    const dispatchId = makeId('automation_dispatch')
    const queueJobId = randomUUID()
    const resumed = await this.deps.automations.updateAutomationRunRecord(automationRunId, {
      status: 'queued',
      currentStep: node.nodeId,
      pendingApproval: state.pendingApproval,
      nodeRuns: state.nodeRuns,
      metadata: withExecutionState({ ...automationRun.metadata, dispatchId, queueJobId }, state),
      expectedStatuses: ['waiting_approval'],
    })
    const dispatched = await this.dispatchAutomationRun(resumed, {
      automationRunId,
      scheduledTaskId: automationRun.scheduledTaskId,
      automationId: automationRun.automationId,
      workspaceId: automationRun.workspaceId,
      triggeredByUserId: automationRun.createdByUserId,
      triggerKind,
      dispatchId,
      prompt: state.prompt,
      parameters: state.parameters,
    }, queueJobId)
    await this.deps.security.authorization.audit(auth, 'automation', 'approve', {
      workspaceId: automationRun.workspaceId,
      resourceId: automationRun.automationId,
    }, 'allowed', { automationRunId, approvalId, decision })
    return { automationRun: dispatched, jobId: queueJobId }
  }

  async listScheduledTasks(auth: AuthContext): Promise<ScheduledTaskSnapshot> {
    await this.deps.security.authorization.enforce(auth, 'scheduled_task', 'read', {
      workspaceId: auth.defaultWorkspaceId,
    })
    await this.deps.security.authorization.enforce(auth, 'automation', 'read', {
      workspaceId: auth.defaultWorkspaceId,
    })
    return {
      tasks: await this.deps.automations.listScheduledTasks(auth.defaultWorkspaceId),
      automationRuns: await this.deps.automations.listAutomationRuns(auth.defaultWorkspaceId),
    }
  }

  async createScheduledTask(auth: AuthContext, input: ScheduledTaskMutationInput): Promise<ScheduledTask> {
    const normalized = this.normalizeMutationInput(input)
    const definition = await this.deps.definitions.requirePublished(auth.defaultWorkspaceId, normalized.targetId)
    await this.deps.security.authorization.enforce(auth, 'scheduled_task', 'create', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: definition.automationId,
    })
    const compiled = this.deps.compiler.compile(definition)
    compiled.validateParameters({ ...definition.defaultParameters, ...normalized.parameters })
    assertSupportedCronExpression(normalized.cron)
    const taskId = makeId('scheduled_task')
    const nextFireAt = normalized.enabled
      ? computeNextFireAt({ cron: normalized.cron, timezone: normalized.timezone })
      : null
    let task = await this.deps.automations.createScheduledTask({
      taskId,
      targetKind: normalized.targetKind,
      targetId: definition.automationId,
      workspaceId: auth.defaultWorkspaceId,
      createdByUserId: auth.userId,
      title: normalized.title ?? definition.name,
      prompt: normalized.prompt,
      parameters: normalized.parameters,
      cron: normalized.cron,
      timezone: normalized.timezone,
      recurring: normalized.recurring,
      enabled: normalized.enabled,
      status: normalized.enabled ? 'active' : 'paused',
      nextFireAt,
    })
    if (task.enabled) {
      try {
        task = await this.registerTaskSchedule(task)
      } catch (error) {
        logger.error({ error: errorLogPayload(error), taskId: task.taskId }, 'scheduled task creation registration failed')
        await this.markScheduleRegistrationFailed(task)
        throw new Error('定时任务已保存，但持久调度注册失败。请查看服务端日志后重新启用。')
      }
    }
    await this.deps.security.authorization.audit(auth, 'scheduled_task', 'create', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: task.taskId,
    }, 'allowed', { automationId: definition.automationId, cron: task.cron, timezone: task.timezone })
    return task
  }

  async updateScheduledTask(auth: AuthContext, taskId: string, input: ScheduledTaskPatchInput): Promise<ScheduledTask> {
    const existing = await this.requireTaskInWorkspace(auth, taskId)
    await this.deps.security.authorization.enforce(auth, 'scheduled_task', 'update', {
      workspaceId: existing.workspaceId,
      resourceId: existing.taskId,
    })
    const merged = this.normalizeMutationInput({
      targetKind: input.targetKind ?? existing.targetKind,
      targetId: input.targetId ?? existing.targetId,
      title: input.title ?? existing.title,
      prompt: input.prompt ?? existing.prompt,
      parameters: input.parameters ?? existing.parameters,
      cron: input.cron ?? existing.cron,
      timezone: input.timezone ?? existing.timezone,
      recurring: input.recurring ?? existing.recurring,
      enabled: input.enabled ?? existing.enabled,
    })
    const definition = await this.deps.definitions.requirePublished(auth.defaultWorkspaceId, merged.targetId)
    const compiled = this.deps.compiler.compile(definition)
    compiled.validateParameters({ ...definition.defaultParameters, ...merged.parameters })
    assertSupportedCronExpression(merged.cron)
    const nextFireAt = merged.enabled ? computeNextFireAt({ cron: merged.cron, timezone: merged.timezone }) : null
    let task = await this.deps.automations.updateScheduledTask(taskId, {
      targetKind: merged.targetKind,
      targetId: definition.automationId,
      title: merged.title ?? definition.name,
      prompt: merged.prompt,
      parameters: merged.parameters,
      cron: merged.cron,
      timezone: merged.timezone,
      recurring: merged.recurring,
      enabled: merged.enabled,
      status: merged.enabled ? 'active' : 'paused',
      nextFireAt,
    })
    if (task.enabled) {
      try {
        task = await this.registerTaskSchedule(task)
      } catch (error) {
        logger.error({ error: errorLogPayload(error), taskId: task.taskId }, 'scheduled task update registration failed')
        await this.markScheduleRegistrationFailed(task)
        throw new Error('定时任务配置已保存，但持久调度注册失败。请查看服务端日志后重新启用。')
      }
    }
    else {
      await this.deps.jobQueue.unscheduleTask(task.taskId, existing.queueJobId)
      task = await this.deps.automations.updateScheduledTask(task.taskId, { queueJobId: null })
    }
    return task
  }

  async deleteScheduledTask(auth: AuthContext, taskId: string): Promise<ScheduledTask> {
    const existing = await this.requireTaskInWorkspace(auth, taskId)
    await this.deps.security.authorization.enforce(auth, 'scheduled_task', 'delete', {
      workspaceId: existing.workspaceId,
      resourceId: existing.taskId,
    })
    await this.deps.jobQueue.unscheduleTask(taskId, existing.queueJobId)
    const deleted = await this.deps.automations.deleteScheduledTask(taskId)
    await this.deps.security.authorization.audit(auth, 'scheduled_task', 'delete', {
      workspaceId: existing.workspaceId,
      resourceId: taskId,
    }, 'allowed', { automationId: existing.targetId })
    return deleted
  }

  async listBackgroundTasks(auth: AuthContext) {
    await this.deps.security.authorization.enforce(auth, 'scheduled_task', 'read', {
      workspaceId: auth.defaultWorkspaceId,
    })
    return this.deps.backgroundTasks.list().filter(task => task.workspaceId === auth.defaultWorkspaceId)
  }

  async cancelBackgroundTask(auth: AuthContext, taskId: string) {
    const task = this.requireBackgroundTask(auth, taskId)
    await this.deps.security.authorization.enforce(auth, 'scheduled_task', 'delete', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: taskId,
    })
    const automationRunId = typeof task.metadata.automationRunId === 'string'
      ? task.metadata.automationRunId
      : null
    if (task.kind === 'automation_run' && automationRunId) {
      await this.cancelAutomation(auth, automationRunId)
      return this.deps.backgroundTasks.get(taskId) ?? task
    }
    return this.deps.backgroundTasks.cancel(taskId)
  }

  async promoteBackgroundTask(auth: AuthContext, taskId: string) {
    await this.deps.security.authorization.enforce(auth, 'scheduled_task', 'update', {
      workspaceId: auth.defaultWorkspaceId,
      resourceId: taskId,
    })
    this.requireBackgroundTask(auth, taskId)
    return this.deps.backgroundTasks.promote(taskId)
  }

  private requireBackgroundTask(auth: AuthContext, taskId: string) {
    const task = this.deps.backgroundTasks.get(taskId)
    if (!task || task.workspaceId !== auth.defaultWorkspaceId) throw new Error(`后台任务 '${taskId}' 不存在。`)
    return task
  }

  private async requireAutomationRunInWorkspace(auth: AuthContext, automationRunId: string): Promise<AutomationRunRecord> {
    const automationRun = await this.deps.automations.getAutomationRunRecord(automationRunId)
    if (!automationRun || automationRun.workspaceId !== auth.defaultWorkspaceId) {
      throw new Error(`自动化流程运行 '${automationRunId}' 不存在。`)
    }
    return automationRun
  }

  private async requireTaskInWorkspace(auth: AuthContext, taskId: string): Promise<ScheduledTask> {
    const task = await this.deps.automations.getScheduledTask(taskId)
    if (!task || task.status === 'deleted' || task.workspaceId !== auth.defaultWorkspaceId) {
      throw new Error(`定时任务 '${taskId}' 不存在。`)
    }
    return task
  }

  private async registerTaskSchedule(task: ScheduledTask): Promise<ScheduledTask> {
    if (!task.nextFireAt) throw new Error('启用定时任务前必须计算 nextFireAt。')
    if (task.queueJobId) await this.deps.jobQueue.unscheduleTask(task.taskId, task.queueJobId)
    const queueJobId = await this.deps.jobQueue.scheduleTask({
      taskId: task.taskId,
      cron: task.cron,
      timezone: task.timezone,
      recurring: task.recurring,
      nextFireAt: task.nextFireAt,
      payload: {
        automationRunId: null,
        scheduledTaskId: task.taskId,
        automationId: task.targetId,
        workspaceId: task.workspaceId,
        triggeredByUserId: task.createdByUserId,
        triggerKind: 'schedule',
        dispatchId: `schedule:${task.taskId}`,
        prompt: '',
        parameters: {},
      },
    })
    return this.deps.automations.updateScheduledTask(task.taskId, { queueJobId })
  }

  private async markScheduleRegistrationFailed(task: ScheduledTask): Promise<ScheduledTask> {
    try {
      await this.deps.jobQueue.unscheduleTask(task.taskId, task.queueJobId)
    } catch (error) {
      logger.error({
        error: errorLogPayload(error),
        taskId: task.taskId,
      }, 'failed to remove uncertain scheduled task registration')
    }
    return this.deps.automations.updateScheduledTask(task.taskId, {
      enabled: false,
      status: 'failed',
      queueJobId: null,
      failureCount: task.failureCount + 1,
      lastErrorMessage: '定时任务注册失败，请查看服务端日志后重新启用。',
    })
  }

  private async dispatchAutomationRun(
    automationRun: AutomationRunRecord,
    payload: AutomationJobPayload,
    queueJobId: string,
  ): Promise<AutomationRunRecord> {
    try {
      const dispatchedJobId = await this.deps.jobQueue.enqueueAutomationRun(payload, queueJobId)
      if (dispatchedJobId !== queueJobId) {
        throw new Error(`Automation dispatch 返回了不一致的队列任务 id '${dispatchedJobId}'。`)
      }
      return automationRun
    } catch (error) {
      logger.error({
        error: errorLogPayload(error),
        automationRunId: automationRun.automationRunId,
        queueJobId,
      }, 'automation dispatch failed')
      const latest = await this.deps.automations.getAutomationRunRecord(automationRun.automationRunId)
      if (latest && latest.status !== 'queued') return latest
      if (latest) {
        await this.failUndispatchableRun(
          latest,
          'Automation 任务未能进入持久队列，系统已终止本次运行。请查看服务端日志。',
        )
      }
      throw new Error('Automation 任务未能进入持久队列。请查看服务端日志。')
    }
  }

  async getAutomationRun(auth: AuthContext, automationRunId: string): Promise<AutomationRunRecord> {
    const automationRun = await this.requireAutomationRunInWorkspace(auth, automationRunId)
    await this.deps.security.authorization.enforce(auth, 'automation', 'read', {
      workspaceId: automationRun.workspaceId,
      resourceId: automationRun.automationId,
    })
    return automationRun
  }

  private async failUndispatchableRun(
    automationRun: AutomationRunRecord,
    message: string,
  ): Promise<AutomationRunRecord> {
    return this.deps.automations.updateAutomationRunRecord(automationRun.automationRunId, {
      status: 'failed',
      errorMessage: message,
      completedAt: nowUtc(),
      expectedStatuses: ['queued'],
    })
  }

  private normalizeMutationInput(input: ScheduledTaskMutationInput): NormalizedScheduledTaskMutation {
    if (input.targetKind !== 'automation') throw new Error('当前定时任务只支持 automation 目标。')
    if (!input.targetId.trim()) throw new Error('定时任务 targetId 不能为空。')
    if (!input.prompt.trim()) throw new Error('定时任务 prompt 不能为空。')
    if (!input.timezone.trim()) throw new Error('定时任务 timezone 不能为空。')
    return {
      targetKind: 'automation',
      targetId: input.targetId.trim(),
      title: input.title?.trim() || null,
      prompt: input.prompt.trim(),
      parameters: input.parameters ?? {},
      cron: input.cron.trim().replace(/\s+/gu, ' '),
      timezone: input.timezone.trim(),
      recurring: input.recurring ?? true,
      enabled: input.enabled ?? true,
    }
  }
}

function patchNodeRun(
  nodeRuns: AutomationNodeRun[],
  nodeId: string,
  patch: Partial<AutomationNodeRun>,
): AutomationNodeRun[] {
  let found = false
  const next = nodeRuns.map(node => {
    if (node.nodeId !== nodeId) return node
    found = true
    return { ...node, ...patch }
  })
  if (!found) throw new Error(`自动化流程运行状态缺少节点 '${nodeId}'。`)
  return next
}

function isMissedOneShot(task: ScheduledTask): boolean {
  if (task.recurring || !task.nextFireAt) return false
  return Date.now() - new Date(task.nextFireAt).getTime() > 60_000
}

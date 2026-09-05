// +-------------------------------------------------------------------------
//
//   地理智能平台 - OpenAI Agents SDK 运行时
//
//   文件:       runtime.ts
//
//   日期:       2026年06月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { errorLogPayload, logger } from '../observability/logger.js'
import type { LocalAgentTracing } from '../observability/agentTracing.js'
import type { ToolRegistry } from '../framework/registry.js'
import type { ModelAdapterRegistry } from '../model/registry.js'
import type { ModelCompletionService } from '../model/modelResultCache.js'
import type { AnalysisRun } from '../schemas/types.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import { ItemSink } from '../conversation/itemSink.js'
import { nowUtc } from '../utils/ids.js'
import {
  createMemoryRuntime,
  dreamMemories,
  extractMemoriesFromThread,
} from '../memory/service.js'
import {
  createSdkMemoryDreamer,
  createSdkMemoryExtractor,
} from '../memory/sdkMemoryExtractor.js'
import { RunEventSink, TurnFinalizer } from './turnRunner.js'
import type { AuthContext } from '../security/types.js'
import {
  errorMessage,
  functionCallId,
  requireString,
  requireThreadId,
} from './runtimeSdkProjection.js'
import { approvalRejectionMessage, resolveDecision } from './runtimeApprovals.js'
import type { SandboxClientFactory } from './runtimeSandbox.js'
import { AgentsSdkBridge } from '../agent-runtime/sdk/AgentsSdkBridge.js'
import { AgentsSdkCheckpointService } from '../agent-runtime/sdk/AgentsSdkCheckpointService.js'
import { RuntimeTranscriptProjector } from './runtimeTranscriptProjector.js'
import { RuntimeApprovalPersistence } from './runtimeApprovalPersistence.js'
import { RunSteeringController } from './runSteeringController.js'
import type { RunOptions } from './runtimeTypes.js'
import { runtimeFailure } from './runtimeErrors.js'
import { RuntimeSdkExecutor } from './runtimeSdkExecutor.js'
import { RuntimeAssemblyFactory } from './runtimeAssembly.js'
import { GoalJudge, type GoalJudgePort } from './goalJudge.js'
import { SubAgentControlPlane, type SubAgentControlInput } from './subAgentControlPlane.js'
import { authorizedAttachmentSummaries } from './multimodalInput.js'
import { withToolAuthorizationLease } from '../agent-runtime/tools/ToolExecutionGate.js'
import type { AgentStepContextRecorder } from '../agent-runtime/step/AgentStepContextFactory.js'
import {
  approvalDecisionInputSchema,
  type ApprovalDecisionInput,
} from '@geo-agent-platform/shared-types/approval-runtime'
import {
  RuntimeHookRegistry,
  type RuntimeHookHandler,
} from '../agent-runtime/hooks/RuntimeHookRegistry.js'
import type { AgentMessage } from '@geo-agent-platform/shared-types/child-run'
import { RunEngine } from '../agent-runtime/engine/RunEngine.js'
import { TurnEngine } from '../agent-runtime/engine/TurnEngine.js'

export type { SandboxClientFactory } from './runtimeSandbox.js'
export type { RunOptions } from './runtimeTypes.js'

export interface OpenAIAgentsRuntimeOptions {
  stepContexts: AgentStepContextRecorder
  createSandboxClient?: SandboxClientFactory
  agentTracing?: LocalAgentTracing
  goalJudge?: GoalJudgePort
  authorizationLease?: (auth: AuthContext, run: AnalysisRun) => Promise<AuthContext>
  hookHandlers?: readonly RuntimeHookHandler[]
  agentMailbox?: {
    listMessages(runId: string): Promise<AgentMessage[]>
    markMessageDelivered(runId: string, messageId: string): Promise<AgentMessage>
    checkpointDeliveredMessages(runId: string): Promise<AgentMessage[]>
  }
}

// OpenAIAgentsRuntime
//
// SDK Runner 仍是模型与工具循环的唯一状态机；RunEngine/TurnEngine 只拥有
// 持久 Run 执行租约、稳定 Turn 身份和单段驱动边界。本类负责装配与持久化收口。
export class OpenAIAgentsRuntime {
  private readonly runEngine = new RunEngine()
  private readonly checkpoints: AgentsSdkCheckpointService
  private readonly turnEngine: TurnEngine
  private readonly sdk = new AgentsSdkBridge()
  private readonly transcriptProjector: RuntimeTranscriptProjector
  private readonly approvalPersistence: RuntimeApprovalPersistence
  private readonly steering: RunSteeringController
  private readonly sdkExecutor: RuntimeSdkExecutor
  private readonly assemblyFactory: RuntimeAssemblyFactory
  private readonly subAgentControls: SubAgentControlPlane

  constructor(
    private readonly store: AgentRuntimeStore,
    private readonly toolRegistry: ToolRegistry,
    private readonly modelRegistry: ModelAdapterRegistry,
    private readonly runtimeOptions: OpenAIAgentsRuntimeOptions,
    modelCompletions?: ModelCompletionService,
  ) {
    this.subAgentControls = new SubAgentControlPlane(store)
    this.checkpoints = new AgentsSdkCheckpointService(store)
    this.turnEngine = new TurnEngine((threadId, runId) => this.checkpoints.requireTurnId(threadId, runId))
    this.transcriptProjector = new RuntimeTranscriptProjector(store, toolRegistry)
    this.approvalPersistence = new RuntimeApprovalPersistence(store, toolRegistry, this.checkpoints)
    this.steering = new RunSteeringController(store)
    this.assemblyFactory = new RuntimeAssemblyFactory({
      store,
      toolRegistry,
      modelRegistry,
      runtimeOptions,
      stepContexts: runtimeOptions.stepContexts,
      subAgentControls: this.subAgentControls,
      runtimeHooks: new RuntimeHookRegistry(runtimeOptions.hookHandlers ?? []),
      ...(modelCompletions ? { modelCompletions } : {}),
      recordWarning: (runId, message, eventSink) => this.recordWarning(runId, message, eventSink),
    })
    this.sdkExecutor = new RuntimeSdkExecutor({
      store,
      checkpoints: this.checkpoints,
      transcriptProjector: this.transcriptProjector,
      approvalPersistence: this.approvalPersistence,
      steering: this.steering,
      goalJudge: runtimeOptions.goalJudge ?? new GoalJudge(store, modelCompletions),
      turnEngine: this.turnEngine,
    })
  }

  async run(options: RunOptions): Promise<AnalysisRun> {
    const threadId = requireThreadId(options.threadId)
    const turnId = await this.turnEngine.resolveTurnId({
      runId: options.runId,
      threadId,
      resume: options.resume === true,
    })
    const eventSink = new RunEventSink(event => this.store.appendEvent(options.runId, event), options.runId, threadId)
    const itemSink = new ItemSink(item => this.store.appendItem(item), options.runId, threadId, turnId)
    const finalizer = new TurnFinalizer(eventSink, itemSink, status => this.store.completeRun(options.runId, status))
    const execution = this.runEngine.start(options.runId, options.signal)
    let detachTracing = (): void => {}
    try {
      detachTracing = this.runtimeOptions.agentTracing?.attachRun(options.runId) ?? (() => {})
      await this.refreshAuthorization(options)
      await this.store.updateRunStatus(options.runId, 'running')
      if (!options.resume && (options.executionMode === 'plan' || options.runProfile === 'geospatial_compose')) {
        await this.store.updateRunState(options.runId, {
          runProfile: options.runProfile ?? 'standard',
          planMode: true,
          agentWorkflow: null,
        })
      }

      if (!options.resume) {
        const attachmentSummaries = authorizedAttachmentSummaries(this.store.getRun(options.runId))
        const userEntry = await this.store.appendTranscript({
          threadId,
          runId: options.runId,
          turnId,
          kind: 'message',
          payload: {
            role: 'user',
            content: options.query,
            ...(attachmentSummaries.length ? { attachments: attachmentSummaries } : {}),
          },
        })
        itemSink.appendUserMessage(options.query, { transcriptEntryId: userEntry.entryId })
        eventSink.emit('intent.parsed', '开始分析...', {})
      }

      await this.steering.open(options.runId, { recoverLeased: options.resume === true })
      await this.deliverAgentMailbox(options.runId)
      const completed = await withToolAuthorizationLease(
        () => this.refreshAuthorization(options),
        async () => {
          await this.refreshAuthorization(options)
          const assembly = await this.assemblyFactory.create(options, threadId, turnId, eventSink, itemSink, execution.signal)
          const checkpoint = options.resume
            ? await this.store.getRunCheckpoint(options.runId)
            : null
          if (
            options.resume
            && !checkpoint?.sdkStateContentHash
            && !assembly.replayInputLeaseId
          ) {
            throw new Error(`run '${options.runId}' 缺少可恢复 SDK checkpoint 或 included ModelRequest`)
          }
          const restored = options.resume && checkpoint?.sdkStateContentHash
            ? await this.checkpoints.restore({
              runId: options.runId,
              agent: assembly.agent,
              context: assembly.context,
              sdkVersion: assembly.sdkVersion,
              configDigest: assembly.configDigest,
              resolveStepContext: stepId => this.runtimeOptions.stepContexts.get(stepId),
              resolveActiveContextWindow: runId => (
                this.runtimeOptions.stepContexts.getActiveContextWindow(runId)
              ),
            })
            : null
          if (restored) assembly.checkpointContext.adopt(restored.stepContext)
          return this.sdkExecutor.execute(
            options,
            assembly,
            restored?.state ?? null,
            execution.signal,
            eventSink,
            itemSink,
          )
        },
      )
      if (completed === 'waiting_approval') return this.store.getRun(options.runId)
      if (completed === 'clarification_needed') return this.store.getRun(options.runId)
      await this.runtimeOptions.agentMailbox?.checkpointDeliveredMessages(options.runId)
      await finalizer.complete()
      await this.maybeExtractLongTermMemories(options, threadId, eventSink)
      return this.store.getRun(options.runId)
    } catch (error) {
      const current = this.store.getRun(options.runId)
      const failure = runtimeFailure(error, { failedTool: current.state.failedTool })
      const message = failure.message
      logger.error({
        error: errorLogPayload(error),
        failureSource: failure.source,
        failureCode: failure.code,
      }, 'run failed')
      if (execution.signal.aborted) {
        if (current.state.goal && ['active', 'evaluating'].includes(current.state.goal.status)) {
          const cancelledAt = nowUtc()
          await this.store.updateRunState(options.runId, {
            goal: {
              ...current.state.goal,
              status: 'cancelled',
              failureReason: '运行已取消。',
              updatedAt: cancelledAt,
              completedAt: cancelledAt,
            },
          })
        }
        await finalizer.cancel()
      } else {
        const failedAt = nowUtc()
        await this.store.updateRunState(options.runId, {
          errors: [...current.state.errors, message],
          failure,
          goal: current.state.goal && ['active', 'evaluating'].includes(current.state.goal.status)
            ? {
                ...current.state.goal,
                status: 'failed',
                failureReason: message,
                updatedAt: failedAt,
                completedAt: failedAt,
              }
            : current.state.goal,
        })
        await finalizer.fail(message, [], failure)
      }
      return this.store.getRun(options.runId)
    } finally {
      detachTracing()
      try {
        await eventSink.flush()
      } finally {
        try {
          await this.steering.close(options.runId)
        } finally {
          this.subAgentControls.finishRun(options.runId)
          execution.close()
        }
      }
    }
  }

  async cancel(runId: string): Promise<AnalysisRun> {
    if (!this.runEngine.abort(runId)) throw new Error(`运行 '${runId}' 不可取消`)
    const run = await this.store.updateRunStatus(runId, 'cancelled')
    if (!run.state.goal || !['active', 'evaluating'].includes(run.state.goal.status)) return run
    const cancelledAt = nowUtc()
    return this.store.updateRunState(runId, {
      goal: {
        ...run.state.goal,
        status: 'cancelled',
        failureReason: '运行已取消。',
        updatedAt: cancelledAt,
        completedAt: cancelledAt,
      },
    })
  }

  private async deliverAgentMailbox(runId: string): Promise<void> {
    const mailbox = this.runtimeOptions.agentMailbox
    if (!mailbox) return
    const queued = (await mailbox.listMessages(runId))
      .filter(message => message.status === 'queued')
      .sort((left, right) => left.sequence - right.sequence)
    for (const message of queued) {
      await this.steering.enqueue(
        runId,
        message.messageId,
        `来自运行 '${message.senderRunId}' 的智能体消息：${message.content}`,
      )
      await mailbox.markMessageDelivered(runId, message.messageId)
    }
  }

  steer(runId: string, steeringId: string, content: string) {
    return this.steering.enqueue(runId, steeringId, content)
  }

  followUpSubAgent(input: SubAgentControlInput) {
    return this.subAgentControls.followUp(input)
  }

  cancelSubAgent(input: SubAgentControlInput) {
    return this.subAgentControls.cancel(input)
  }

  async acceptApprovalDecision(
    runId: string,
    approvalId: string,
    input: boolean | ApprovalDecisionInput,
    auth?: AuthContext | null,
  ): Promise<{ run: AnalysisRun; accepted: boolean }> {
    const decision = normalizeApprovalDecision(input)
    const approved = decision.decision === 'approved'
    const run = this.store.getRun(runId)
    const approval = run.state.approvals.find(candidate => candidate.approvalId === approvalId)
    if (!approval) throw new Error(`审批 '${approvalId}' 不存在`)
    const durable = await this.store.getApprovalRecord(approvalId)
    if (!durable || durable.runId !== runId) throw new Error(`审批 '${approvalId}' 缺少持久事实`)
    if (approval.payload.consumed === true && durable.status === 'consumed') {
      return { run, accepted: false }
    }
    if (run.status !== 'waiting_approval' && run.status !== 'queued') {
      throw new Error(`审批 '${approvalId}' 当前运行状态为 '${run.status}'，不能重新启动续跑`)
    }

    const expectedStatus = approved ? 'approved' : 'rejected'
    // WS 在审批已经落盘、后台任务尚未成功登记时断开，可以安全重试同一决定。
    // 只允许 queued 状态重试；一旦续跑进入 running/failed，禁止重放副作用。
    if (durable.status === 'pending') {
      await this.store.resolveApprovalRecord({
        ...decision,
        runId,
        approvalId,
        expectedVersion: durable.version,
        decidedByUserId: auth?.userId ?? null,
        resolvedAt: nowUtc(),
      })
    } else if (
      durable.decision !== decision.decision
      || durable.decisionScope !== decision.scope
      || durable.decisionReason !== decision.reason
    ) {
      throw new Error(`审批 '${approvalId}' 已用不同决定处理`)
    }

    const resolvedApproval = {
      ...approval,
      status: approved ? 'approved' as const : 'rejected' as const,
      resolvedAt: nowUtc(),
    }
    await this.store.updateRunState(runId, {
      approvals: run.state.approvals.map(candidate => candidate.approvalId === approvalId
        ? resolvedApproval
        : candidate),
      decisions: resolveDecision(run.state.decisions, approvalId, expectedStatus, {
        approved,
        scope: decision.scope,
        reason: decision.reason,
      }),
    })
    await this.store.updateRunStatus(runId, 'queued')
    return { run: this.store.getRun(runId), accepted: true }
  }

  async continueApprovalDecision(
    runId: string,
    approvalId: string,
    input: boolean | ApprovalDecisionInput,
    auth?: AuthContext | null,
    signal?: AbortSignal,
  ): Promise<AnalysisRun> {
    const decision = normalizeApprovalDecision(input)
    const approved = decision.decision === 'approved'
    const run = this.store.getRun(runId)
    const threadId = requireThreadId(run.threadId)
    if (!run.runtimeConfigSnapshot) throw new Error(`运行 '${runId}' 缺少 runtimeConfigSnapshot`)
    const approval = run.state.approvals.find(candidate => candidate.approvalId === approvalId)
    if (!approval) throw new Error(`审批 '${approvalId}' 不存在`)
    const durableApproval = await this.store.getApprovalRecord(approvalId)
    if (!durableApproval || durableApproval.runId !== runId) {
      throw new Error(`审批 '${approvalId}' 缺少持久事实`)
    }
    const expectedStatus = approved ? 'approved' : 'rejected'
    if (
      approval.status !== expectedStatus
      || !['resolved', 'consumed'].includes(durableApproval.status)
      || durableApproval.decision !== decision.decision
      || durableApproval.decisionScope !== decision.scope
      || durableApproval.decisionReason !== decision.reason
    ) {
      throw new Error(`审批 '${approvalId}' 未处于可续跑的 ${expectedStatus} 状态`)
    }
    const turnId = requireString(approval.payload.turnId, '审批 payload.turnId')
    const eventSink = new RunEventSink(event => this.store.appendEvent(runId, event), runId, threadId)
    const itemSink = new ItemSink(item => this.store.appendItem(item), runId, threadId, turnId)
    const options: RunOptions = {
      runId,
      threadId,
      sessionId: run.sessionId,
      query: run.userQuery,
      provider: requireString(run.modelProvider, '运行 modelProvider'),
      modelName: run.modelName,
      runtimeConfig: run.runtimeConfigSnapshot,
      runProfile: run.state.runProfile,
      reasoning: true,
      resume: true,
      auth: auth ?? null,
    }
    const execution = this.runEngine.start(runId, signal)
    let detachTracing = (): void => {}
    const finalizer = new TurnFinalizer(eventSink, itemSink, status => this.store.completeRun(runId, status))
    try {
      detachTracing = this.runtimeOptions.agentTracing?.attachRun(runId) ?? (() => {})
      await this.refreshAuthorization(options)
      await this.store.updateRunStatus(runId, 'running')
      await this.steering.open(runId, { recoverLeased: true })
      const result = await withToolAuthorizationLease(
        () => this.refreshAuthorization(options),
        async () => {
          await this.refreshAuthorization(options)
          const assembly = await this.assemblyFactory.create(
            options,
            threadId,
            turnId,
            eventSink,
            itemSink,
            execution.signal,
            false,
          )
          const restored = await this.checkpoints.restore({
            runId: options.runId,
            agent: assembly.agent,
            context: assembly.context,
            sdkVersion: assembly.sdkVersion,
            configDigest: assembly.configDigest,
            resolveStepContext: stepId => this.runtimeOptions.stepContexts.get(stepId),
            resolveActiveContextWindow: restoredRunId => (
              this.runtimeOptions.stepContexts.getActiveContextWindow(restoredRunId)
            ),
          })
          assembly.checkpointContext.adopt(restored.stepContext)
          const state = restored.state
          const callId = requireString(approval.payload.callId, '审批 payload.callId')
          const interruption = this.sdk.interruptions(state).find(item => functionCallId(item) === callId)
          if (!interruption) throw new Error(`SDK 状态中不存在待审批调用 '${callId}'`)
          const rejectionMessage = approvalRejectionMessage(approval.action)
          this.sdk.resolveApproval({
            state,
            interruption,
            approved,
            rejectionMessage,
          })
          if (!approved) {
            await assembly.coordinator.rejectToolApproval(callId, rejectionMessage)
            const currentApproval = await this.store.getApprovalRecord(approvalId)
            if (currentApproval?.status === 'resolved') {
              await this.store.consumeApprovalRecord({
                runId,
                approvalId,
                expectedVersion: currentApproval.version,
                consumedAt: nowUtc(),
              })
            }
          }
          return this.sdkExecutor.execute(options, assembly, state, execution.signal, eventSink, itemSink)
        },
      )
      // SDK 执行器可能在拒绝后立即产生一条新的审批。必须以刚落盘的
      // run state 为事实源，只消费当前审批，不能用恢复前的 approvals 快照
      // 覆盖新审批，否则前端会拿到一个在 approvals 中已经消失的 decisionId。
      const latest = this.store.getRun(runId)
      await this.store.updateRunState(runId, {
        approvals: latest.state.approvals.map(candidate => candidate.approvalId === approvalId
          ? { ...candidate, payload: { ...candidate.payload, consumed: true } }
          : candidate),
        decisions: resolveDecision(latest.state.decisions, approvalId, expectedStatus, {
          approved,
          scope: decision.scope,
          reason: decision.reason,
          consumed: true,
        }),
      })
      if (result === 'waiting_approval') return this.store.getRun(runId)
      if (result === 'clarification_needed') return this.store.getRun(runId)
      await finalizer.complete()
      await this.maybeExtractLongTermMemories(options, threadId, eventSink)
      return this.store.getRun(runId)
    } catch (error) {
      const current = this.store.getRun(runId)
      const failure = runtimeFailure(error, { failedTool: current.state.failedTool })
      const message = failure.message
      logger.error({
        error: errorLogPayload(error),
        failureSource: failure.source,
        failureCode: failure.code,
      }, 'approval continuation failed')
      if (execution.signal.aborted) {
        await finalizer.cancel()
      } else {
        await this.store.updateRunState(runId, {
          errors: [...current.state.errors, message],
          failure,
        })
        await finalizer.fail(message, [], failure)
      }
      return this.store.getRun(runId)
    } finally {
      detachTracing()
      try {
        await eventSink.flush()
      } finally {
        try {
          await this.steering.close(runId)
        } finally {
          execution.close()
        }
      }
    }
  }

  async resolveApproval(
    runId: string,
    approvalId: string,
    input: boolean | ApprovalDecisionInput,
    auth?: AuthContext | null,
  ): Promise<AnalysisRun> {
    const receipt = await this.acceptApprovalDecision(runId, approvalId, input, auth)
    if (!receipt.accepted) return receipt.run
    return this.continueApprovalDecision(runId, approvalId, input, auth)
  }

  private async refreshAuthorization(options: RunOptions): Promise<void> {
    const auth = options.auth
    if (!auth) return
    const lease = this.runtimeOptions.authorizationLease
    if (!lease) throw new Error('Agent 运行缺少持续授权租约。')
    options.auth = await lease(auth, this.store.getRun(options.runId))
  }

  private async maybeExtractLongTermMemories(options: RunOptions, threadId: string, eventSink: RunEventSink): Promise<void> {
    const config = options.runtimeConfig.context
    if (!config.memoryEnabled || !config.memoryAutoExtractEnabled) return
    if (!this.memoryToolsAvailable()) return
    try {
      const adapter = this.modelRegistry.resolveProvider(options.runtimeConfig.context.summaryProvider ?? options.provider)
      const model = options.runtimeConfig.context.summaryModel
        ?? adapter.subagentModel
        ?? options.modelName
        ?? adapter.defaultModel
      if (!model) throw new Error('未配置记忆提取模型')
      const runtimeMemory = createMemoryRuntime(this.store.runtimeRoot, config)
      await extractMemoriesFromThread(
        runtimeMemory,
        this.store,
        threadId,
        options.runId,
        createSdkMemoryExtractor(adapter, model, options.signal),
      )
      if (config.memoryAutoDreamEnabled) {
        await dreamMemories(runtimeMemory, createSdkMemoryDreamer(adapter, model, options.signal))
      }
    } catch (error) {
      await this.recordWarning(options.runId, `长期记忆自动提取失败：${errorMessage(error)}`, eventSink)
    }
  }

  private async recordWarning(runId: string, message: string, eventSink: RunEventSink): Promise<void> {
    const run = this.store.getRun(runId)
    await this.store.updateRunState(runId, { warnings: [...run.state.warnings, message] })
    eventSink.emit('warning.raised', message, {})
  }

  private memoryToolsAvailable(): boolean {
    return Boolean(this.toolRegistry.get('list_memories')
      && this.toolRegistry.get('search_memory')
      && this.toolRegistry.get('read_memory')
      && this.toolRegistry.get('write_memory')
      && this.toolRegistry.get('forget_memory'))
  }
}

function normalizeApprovalDecision(input: boolean | ApprovalDecisionInput): ApprovalDecisionInput {
  return approvalDecisionInputSchema.parse(typeof input === 'boolean'
    ? input
      ? { decision: 'approved', scope: 'exact_call', reason: null }
      : { decision: 'rejected', scope: 'exact_call', reason: '用户拒绝执行该工具。' }
    : input)
}

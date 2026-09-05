// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 单次运行执行器
//
//   文件:       runtimeSdkExecutor.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
RunContext,
type AgentInputItem,
} from '@openai/agents'
import PQueue from 'p-queue'

import type { ItemSink } from '../conversation/itemSink.js'
import { errorLogPayload,logger } from '../observability/logger.js'
import { ModelRequestTelemetry } from '../observability/modelRequestTelemetry.js'
import type { AgentState,RunGoal,RunGoalVerdict,SupervisorDelivery } from '../schemas/types.js'
import type { AgentRuntimeStore } from '../store/runtimePorts.js'
import type { AgentsExecutionContext } from './agentsToolBridge.js'
import { assertArtifactDeliveryIsVisible } from './artifactDeliveryPolicy.js'
import type { ModelUsageResponseLike } from '../model/modelUsage.js'
import type { RuntimeApprovalPersistence } from './runtimeApprovalPersistence.js'
import {
combineSessionInput,
errorMessage,
} from './runtimeSdkProjection.js'
import type { RuntimeTranscriptProjector } from './runtimeTranscriptProjector.js'
import type {
RunOptions,
RuntimeAgentsSdkState,
RuntimeAssembly,
StreamProjectionState,
} from './runtimeTypes.js'
import type { RunSteeringController } from './runSteeringController.js'
import type { RunEventSink } from './turnRunner.js'
import { goalTokenUsage,type GoalJudgePort } from './goalJudge.js'
import { buildInitialAgentInput } from './multimodalInput.js'
import { AgentsSdkBridge } from '../agent-runtime/sdk/AgentsSdkBridge.js'
import type { AgentsSdkCheckpointService } from '../agent-runtime/sdk/AgentsSdkCheckpointService.js'
import { AgentsSdkSegmentRotation } from '../agent-runtime/sdk/AgentsSdkSegmentRotation.js'
import type { RecordedAgentStepContext } from '../agent-runtime/step/AgentStepContextFactory.js'
import type { TurnEngine } from '../agent-runtime/engine/TurnEngine.js'
import {
evaluateGoalBeforeJudge,
evaluateGoalVerdict,
evaluateTerminalCandidateState,
evaluateTerminalDeliveryCandidate,
} from '../agent-runtime/terminal/TerminalPolicy.js'

export type RuntimeSdkOutcome = 'completed' | 'waiting_approval' | 'clarification_needed'

interface RuntimeSdkExecutorDependencies {
  store: AgentRuntimeStore
  checkpoints: AgentsSdkCheckpointService
  transcriptProjector: RuntimeTranscriptProjector
  approvalPersistence: RuntimeApprovalPersistence
  steering: RunSteeringController
  goalJudge: GoalJudgePort
  turnEngine: TurnEngine
}

// 负责编排一个 Turn 内的顺序 SDK segments；每个 segment 的启动、事件消费与
// 释放交给 TurnEngine。PostgreSQL 仍是 transcript、审批、工作流和结果账本的事实源。
export class RuntimeSdkExecutor {
  private readonly sdk = new AgentsSdkBridge()

  constructor(private readonly dependencies: RuntimeSdkExecutorDependencies) {}

  async execute(
    options: RunOptions,
    assembly: RuntimeAssembly,
    resumeState: RuntimeAgentsSdkState | null,
    signal: AbortSignal,
    eventSink: RunEventSink,
    itemSink: ItemSink,
  ): Promise<RuntimeSdkOutcome> {
    const {
      approvalPersistence,
      checkpoints,
      goalJudge,
      steering,
      store,
      transcriptProjector,
      turnEngine,
    } = this.dependencies
    let outcome: RuntimeSdkOutcome | null = null
    let nextInput: RuntimeAgentsSdkState | AgentInputItem[] | string = resumeState ?? await buildInitialAgentInput(
      store,
      options.runId,
      options.query,
      assembly.modelCapabilities,
    )
    let activeProjection: StreamProjectionState | null = null
    let activeModelTelemetry: ModelRequestTelemetry | null = null
    let activeResponseUsageFlush: (() => Promise<void>) | null = null
    let terminalRepairAttempts = 0
    let terminalRepairObjectiveRevision: number | null = null
    let pendingInputLeaseId: string | null = assembly.replayInputLeaseId
    const inputCheckpointQueue = new PQueue({ concurrency: 1 })
    const serializeInputCheckpoint = async <T>(work: () => Promise<T>): Promise<T> => {
      const result = await inputCheckpointQueue.add(async () => ({ value: await work() }))
      if (!result) throw new Error(`运行 '${options.runId}' 的输入 checkpoint 队列未返回结果`)
      return result.value
    }

    try {
      if (pendingInputLeaseId) {
        const replay = await steering.replayIncludedInputs(options.runId, pendingInputLeaseId)
        assembly.coordinator.bindModelInputObjectiveRevision(replay.objectiveRevision)
        if (this.sdk.isState<AgentsExecutionContext>(nextInput)) {
          this.sdk.stageInput(nextInput, replay.items)
        } else {
          nextInput = appendSegmentInput(nextInput, replay.items)
        }
      }
      while (true) {
        // Fresh segment 也必须在第一次 provider 请求前租取已排队输入。
        // StepContext 会在 transport 边界基于这份最终 ModelRequest 创建；若反过来
        // 等已有 StepContext 才租取，首次请求窗口内到达的 steering 只能迟到下一轮。
        if (!pendingInputLeaseId) {
          const delivery = await steering.consumePendingWithRevision(options.runId)
          assembly.coordinator.bindModelInputObjectiveRevision(delivery.objectiveRevision)
          if (delivery.leaseId) {
            if (this.sdk.isState<AgentsExecutionContext>(nextInput)) {
              this.sdk.stageInput(nextInput, delivery.items)
            } else {
              nextInput = appendSegmentInput(nextInput, delivery.items)
            }
            pendingInputLeaseId = delivery.leaseId
          }
        }
        const projection = transcriptProjector.createState()
        activeProjection = projection
        const modelTelemetry = new ModelRequestTelemetry({
          provider: options.provider,
          model: assembly.modelName,
          transport: assembly.adapter.agentRuntimeCapabilities.transport,
          runId: options.runId,
          threadId: assembly.threadId,
        })
        activeModelTelemetry = modelTelemetry
        const streamStateReady = deferred<RuntimeAgentsSdkState>()
        let responseUsageCursor: RawResponseUsageCursor | null = null
        let currentRawResponses: (() => ModelUsageResponseLike[]) | null = null
        let stateCheckpointed = false
        let filterInvocationCount = 0
        const flushResponseUsage = async (): Promise<void> => {
          if (!responseUsageCursor || !currentRawResponses) {
            throw new Error(`运行 '${options.runId}' 的模型响应计量游标尚未初始化`)
          }
          await responseUsageCursor.flush(
            currentRawResponses(),
            responses => assembly.modelUsageRecorder.recordResponses(responses),
          )
        }
        const checkpointCurrentState = async (
          state: RuntimeAgentsSdkState,
          stepContext: RecordedAgentStepContext,
          checkpointModelRequest: boolean,
        ): Promise<void> => {
          // 用量必须先于包含这些 raw responses 的 SDK checkpoint 落盘。
          // 这样恢复时 checkpoint 内已有响应天然成为游标基线；即使进程恰好
          // 在两次写入之间退出，也只会留下已实际发生且已计费的调用，不会在
          // 恢复后把整段历史响应再次合并。
          await flushResponseUsage()
          const leaseId = pendingInputLeaseId
          const terminalToolCallIds = await assembly.coordinator.checkpointTerminalToolCallIds()
          const commit = await checkpoints.persist(options.runId, state, {
            sdkVersion: assembly.sdkVersion,
            configDigest: assembly.configDigest,
            stepContext,
            terminalToolCallIds,
          }, leaseId, checkpointModelRequest)
          if (leaseId) {
            pendingInputLeaseId = null
            await steering.recordCheckpointedInputs(options.runId, commit.acknowledgedInputs)
          }
          stateCheckpointed = true
        }
        const unsubscribeCheckpointContext = assembly.checkpointContext.subscribe(async stepContext => {
          // 新 lease 已经用 RunState.addInput() 排队，但在 provider 完整响应前
          // 不能推进 input cursor。没有活动 lease 的首个模型请求则在发包前
          // 保存可恢复 baseline，并绑定刚捕获的精确 StepContext。
          if (stateCheckpointed || pendingInputLeaseId) return
          await serializeInputCheckpoint(async () => checkpointCurrentState(
            await streamStateReady.promise,
            stepContext,
            false,
          ))
        })
        const segment = await turnEngine.executeSegment({
          runId: options.runId,
          turnId: assembly.turnId,
          start: () => assembly.runner.run(
            assembly.agent,
            nextInput,
            {
              stream: true,
              context: new RunContext(assembly.context),
              session: assembly.session,
              sessionInputCallback: combineSessionInput,
              ...(assembly.sandbox ? { sandbox: assembly.sandbox } : {}),
              maxTurns: options.runtimeConfig.maxTurns,
              signal,
              callModelInputFilter: ({ modelData }) => serializeInputCheckpoint(async () => {
                filterInvocationCount += 1
                if (filterInvocationCount === 1) {
                  // Segment 首次请求的 baseline 由模型 transport 边界在精确
                  // StepContext 捕获后保存。若已有 pending input，必须等模型完整
                  // 接纳后才 ack，所以这里也不提前 checkpoint。
                  return assembly.modelInput.filter(modelData, [])
                }

                stateCheckpointed = false
                const stepContext = assembly.checkpointContext.current()
                if (!stepContext) throw new Error('Agent SDK 后续模型请求缺少 StepContext')
                await checkpointCurrentState(await streamStateReady.promise, stepContext, true)
                const delivery = await steering.consumePendingWithRevision(options.runId)
                if (delivery.leaseId) {
                  throw new AgentsSdkSegmentRotation({
                    items: delivery.items,
                    objectiveRevision: delivery.objectiveRevision,
                    leaseId: delivery.leaseId,
                  })
                }
                assembly.coordinator.bindModelInputObjectiveRevision(delivery.objectiveRevision)
                return assembly.modelInput.filter(modelData, [])
              }),
            },
          ),
          onStarted: stream => {
            // StreamedRunResult 在返回时已经挂接恢复态，但首个 provider 请求仍被
            // StepContext checkpoint listener 阻塞。此处记录的是确定的恢复基线，
            // 后续只按数组位置消费新增后缀，不依赖响应对象在序列化前后的身份。
            responseUsageCursor = new RawResponseUsageCursor(stream.rawResponses.length)
            currentRawResponses = () => stream.rawResponses
            streamStateReady.resolve(stream.state)
          },
          onEvent: async event => {
            modelTelemetry.observe(event)
            await transcriptProjector.projectStreamEvent(event, projection, assembly, eventSink, itemSink)
          },
        }).finally(unsubscribeCheckpointContext)
        const stream = segment.stream
        activeResponseUsageFlush = flushResponseUsage
        const segmentError = segment.error

        if (segmentError instanceof AgentsSdkSegmentRotation) {
          this.sdk.stageInput(stream.state, segmentError.input.items)
          pendingInputLeaseId = segmentError.input.leaseId
          assembly.coordinator.bindModelInputObjectiveRevision(segmentError.input.objectiveRevision)
          await transcriptProjector.linkAssistantTranscriptEntries(options.runId, assembly, projection, itemSink)
          if (projection.reasoningItemId) itemSink.completeItem(projection.reasoningItemId)
          await flushResponseUsage()
          nextInput = stream.state
          continue
        }
        if (segmentError) {
          await flushResponseUsage()
          modelTelemetry.fail(segmentError)
          throw segmentError
        }
        if (stream.error) {
          await flushResponseUsage()
          modelTelemetry.fail(stream.error)
          throw stream.error
        }
        if (stream.cancelled || signal.aborted) {
          await flushResponseUsage()
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error(`运行 '${options.runId}' 的模型流在完整响应前被取消`)
        }
        stateCheckpointed = false
        const finalStepContext = assembly.checkpointContext.current()
        if (!finalStepContext) throw new Error('Agent SDK 完整响应缺少 StepContext')
        await serializeInputCheckpoint(() => checkpointCurrentState(
          stream.state,
          finalStepContext,
          true,
        ))
        await transcriptProjector.linkAssistantTranscriptEntries(options.runId, assembly, projection, itemSink)
        if (projection.reasoningItemId) {
          itemSink.completeItem(projection.reasoningItemId)
          projection.reasoningItemId = null
        }
        await flushResponseUsage()

        const interruptions = stream.interruptions
        if (interruptions.length) {
          await approvalPersistence.persist(options, interruptions, eventSink, itemSink)
          await eventSink.flush()
          await itemSink.flush()
          outcome = 'waiting_approval'
          return outcome
        }

        const candidateFinalOutput = optionalFinalText(stream.finalOutput)
        const candidateSnapshot = await steering.modelInputRevisionSnapshot(options.runId)
        const candidateObjectiveRevision = candidateSnapshot.objectiveRevision
        if (terminalRepairObjectiveRevision !== candidateObjectiveRevision) {
          terminalRepairObjectiveRevision = candidateObjectiveRevision
          terminalRepairAttempts = 0
        }
        const candidateStateDecision = evaluateTerminalCandidateState(
          candidateSnapshot.state,
          candidateObjectiveRevision,
        )
        if (candidateStateDecision.type === 'supersede') {
          await supersedeAssistantCandidate({
            store,
            checkpoints,
            assembly,
            streamState: stream.state,
            eventSink,
            itemSink,
            projection,
            runId: options.runId,
            objectiveRevision: candidateObjectiveRevision,
            ...(candidateFinalOutput === null ? {} : { body: candidateFinalOutput }),
          })
          nextInput = []
          continue
        }
        const candidateState = candidateSnapshot.state
        if (!candidateState) throw new Error('终态策略返回非 supersede，但候选状态不存在。')
        const supersedeProjectionCandidate = () => supersedeAssistantCandidate({
          store,
          checkpoints,
          assembly,
          streamState: stream.state,
          eventSink,
          itemSink,
          projection,
          runId: options.runId,
          objectiveRevision: candidateObjectiveRevision,
          ...(candidateFinalOutput === null ? {} : { body: candidateFinalOutput }),
        })

        if (candidateStateDecision.type === 'clarification') {
          if (!await steering.tryClaimTerminal(options.runId, candidateSnapshot)) {
            await supersedeAssistantCandidate({
              store,
              checkpoints,
              assembly,
              streamState: stream.state,
              eventSink,
              itemSink,
              projection,
              runId: options.runId,
              objectiveRevision: candidateObjectiveRevision,
              ...(candidateFinalOutput === null ? {} : { body: candidateFinalOutput }),
            })
            nextInput = []
            continue
          }
          if (candidateStateDecision.cancelActiveGoal && candidateState.goal) {
            const transferredAt = new Date().toISOString()
            await store.updateRunState(options.runId, {
              goal: {
                ...candidateState.goal,
                status: 'cancelled',
                failureReason: '等待用户澄清，Goal 将由后续运行继承。',
                updatedAt: transferredAt,
                completedAt: transferredAt,
              },
            })
          }
          eventSink.emit('clarification.required', candidateStateDecision.clarification.question, {
            clarification: candidateStateDecision.clarification,
          })
          itemSink.appendResult('clarification_needed', {
            decisionId: candidateStateDecision.clarification.clarificationId,
            clarification: candidateStateDecision.clarification,
            message: candidateStateDecision.clarification.question,
            objectiveRevision: candidateObjectiveRevision,
          })
          await eventSink.flush()
          await itemSink.flush()
          await store.completeRun(options.runId, 'clarification_needed')
          outcome = 'clarification_needed'
          return outcome
        }

        if (candidateStateDecision.type === 'reject') {
          if (!await steering.tryClaimTerminal(options.runId, candidateSnapshot)) {
            await supersedeProjectionCandidate()
            nextInput = []
            continue
          }
          throw new Error(candidateStateDecision.message)
        }

        const finalOutput = candidateFinalOutput ?? requireFinalText(stream.finalOutput)
        const delivery = platformDelivery(finalOutput, candidateState)
        const terminalDecision = evaluateTerminalDeliveryCandidate({
          executionMode: options.executionMode,
          delivery,
          repairAttempts: terminalRepairAttempts,
        })
        if (terminalDecision.type !== 'accepted') {
          if (terminalDecision.type === 'reject') {
            if (!await steering.tryClaimTerminal(options.runId, candidateSnapshot)) {
              await supersedeProjectionCandidate()
              nextInput = []
              continue
            }
            throw new Error(`Agent 最终交付缺少可核验证据：${terminalDecision.reason}`)
          }
          terminalRepairAttempts = terminalDecision.nextAttempt
          eventSink.emit('warning.raised', '最终回答缺少可核验证据，正在继续执行。', {
            code: terminalDecision.code,
            repairAttempt: terminalRepairAttempts,
          })
          await eventSink.flush()
          await itemSink.flush()
          nextInput = [{
            type: 'message',
            role: 'user',
            content: terminalDecision.instruction,
          }]
          continue
        }

        await assertArtifactDeliveryIsVisible(store, options.runId, delivery.artifactIds)
        const itemId = projection.assistantItemId
          ?? itemSink.startItem('message', { role: 'assistant' }).itemId
        const persisted = await transcriptProjector.appendAssistantMessageTranscript(
          assembly,
          finalOutput,
          { itemId, objectiveRevision: candidateObjectiveRevision },
        )
        projection.assistantItemId = null
        const supersedeCurrentCandidate = () => supersedeAssistantCandidate({
          store,
          checkpoints,
          assembly,
          streamState: stream.state,
          eventSink,
          itemSink,
          projection,
          runId: options.runId,
          objectiveRevision: candidateObjectiveRevision,
          itemId,
          transcriptEntryId: persisted.entryId,
          body: finalOutput,
        })

        let goalMetadata: Record<string, unknown> = {}
        let satisfiedGoal: { goal: RunGoal; verdict: RunGoalVerdict } | null = null
        const persistedGoal = candidateState.goal
        if (persistedGoal && (persistedGoal.status === 'active' || persistedGoal.status === 'evaluating')) {
          const tokenUsageBeforeJudge = goalTokenUsage(candidateState.runtimeStats)
          const beforeJudgeDecision = evaluateGoalBeforeJudge({
            goal: persistedGoal,
            tokenUsage: tokenUsageBeforeJudge,
            nowEpochMs: Date.now(),
          })
          if (beforeJudgeDecision.type === 'exhausted') {
            const beforeJudgeBoundary = beforeJudgeDecision.reason
            if (!await steering.tryClaimTerminal(options.runId, candidateSnapshot)) {
              await supersedeAssistantCandidate({
                store,
                checkpoints,
                assembly,
                streamState: stream.state,
                eventSink,
                itemSink,
                projection,
                runId: options.runId,
                objectiveRevision: candidateObjectiveRevision,
                itemId,
                transcriptEntryId: persisted.entryId,
                body: finalOutput,
              })
              nextInput = []
              continue
            }
            const completedAt = new Date().toISOString()
            await store.updateRunState(options.runId, {
              goal: {
                ...persistedGoal,
                status: 'exhausted',
                failureReason: beforeJudgeBoundary,
                updatedAt: completedAt,
                completedAt,
              },
            })
            eventSink.emit('goal.updated', beforeJudgeBoundary, {
              goalId: persistedGoal.goalId,
              status: 'exhausted',
              tokenUsage: tokenUsageBeforeJudge,
              objectiveRevision: candidateObjectiveRevision,
            })
            itemSink.completeItem(itemId, {
              body: finalOutput,
              metadata: {
                transcriptEntryId: persisted.entryId,
                goalStatus: 'exhausted',
                objectiveRevision: candidateObjectiveRevision,
              },
            })
            await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
            await eventSink.flush()
            await itemSink.flush()
            throw new Error(beforeJudgeBoundary)
          }

          const evaluatingAt = new Date().toISOString()
          const evaluatingGoal: RunGoal = {
            ...persistedGoal,
            objectiveRevision: candidateObjectiveRevision,
            status: 'evaluating',
            failureReason: null,
            updatedAt: evaluatingAt,
          }
          const evaluationStarted = await steering.commitRevision(
            options.runId,
            candidateObjectiveRevision,
            async state => {
              if (state.goal?.goalId !== evaluatingGoal.goalId) {
                throw new Error('Goal 验收前持久化状态发生了不一致变化。')
              }
              await store.updateRunState(options.runId, { goal: evaluatingGoal })
              eventSink.emit('goal.updated', `正在执行 Goal 第 ${evaluatingGoal.recheckCount + 1} 次独立验收。`, {
                goalId: evaluatingGoal.goalId,
                status: 'evaluating',
                attempt: evaluatingGoal.recheckCount + 1,
                objectiveRevision: candidateObjectiveRevision,
              })
              await eventSink.flush()
              await itemSink.flush()
            },
          )
          if (!evaluationStarted) {
            await supersedeAssistantCandidate({
              store,
              checkpoints,
              assembly,
              streamState: stream.state,
              eventSink,
              itemSink,
              projection,
              runId: options.runId,
              objectiveRevision: candidateObjectiveRevision,
              itemId,
              transcriptEntryId: persisted.entryId,
              body: finalOutput,
            })
            nextInput = []
            continue
          }

          const verdict = await goalJudge.evaluate({
            runId: options.runId,
            threadId: assembly.threadId,
            provider: options.provider,
            ...(options.modelName !== undefined ? { model: options.modelName } : {}),
            goal: evaluatingGoal,
            signal,
          })
          const latestGoal = evaluatingGoal
          const goalDecision = evaluateGoalVerdict({
            goal: latestGoal,
            verdict,
            nowEpochMs: Date.now(),
          })
          if (goalDecision.type === 'exhausted') {
            const afterJudgeBoundary = goalDecision.reason
            if (!await steering.tryClaimTerminal(options.runId, candidateSnapshot)) {
              await supersedeCurrentCandidate()
              nextInput = []
              continue
            }
            const completedAt = new Date().toISOString()
            await store.updateRunState(options.runId, {
              goal: {
                ...latestGoal,
                status: 'exhausted',
                lastVerdict: verdict,
                failureReason: afterJudgeBoundary,
                updatedAt: completedAt,
                completedAt,
              },
            })
            eventSink.emit('goal.updated', afterJudgeBoundary, {
              goalId: latestGoal.goalId,
              status: 'exhausted',
              verdict,
              objectiveRevision: candidateObjectiveRevision,
            })
            itemSink.completeItem(itemId, {
              body: finalOutput,
              metadata: {
                transcriptEntryId: persisted.entryId,
                goalStatus: 'exhausted',
                goalVerdict: verdict,
                objectiveRevision: candidateObjectiveRevision,
              },
            })
            await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
            await eventSink.flush()
            await itemSink.flush()
            throw new Error(afterJudgeBoundary)
          }

          if (goalDecision.type === 'impossible') {
            if (!await steering.tryClaimTerminal(options.runId, candidateSnapshot)) {
              await supersedeCurrentCandidate()
              nextInput = []
              continue
            }
            const completedAt = new Date().toISOString()
            await store.updateRunState(options.runId, {
              goal: {
                ...latestGoal,
                status: 'impossible',
                lastVerdict: verdict,
                failureReason: verdict.reason,
                updatedAt: completedAt,
                completedAt,
              },
            })
            eventSink.emit('goal.updated', `Goal 被独立验收器判定为不可达：${verdict.reason}`, {
              goalId: latestGoal.goalId,
              status: 'impossible',
              verdict,
              objectiveRevision: candidateObjectiveRevision,
            })
            itemSink.completeItem(itemId, {
              body: finalOutput,
              metadata: {
                transcriptEntryId: persisted.entryId,
                goalStatus: 'impossible',
                goalVerdict: verdict,
                objectiveRevision: candidateObjectiveRevision,
              },
            })
            await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
            await eventSink.flush()
            await itemSink.flush()
            throw new Error(`Goal 不可达：${verdict.reason}`)
          }

          if (goalDecision.type === 'recheck') {
            const recheckAt = new Date().toISOString()
            const recheckCount = goalDecision.recheckCount
            const recheckCommitted = await steering.commitRevision(
              options.runId,
              candidateObjectiveRevision,
              async state => {
                if (
                  state.goal?.goalId !== latestGoal.goalId
                  || state.goal.objectiveRevision !== candidateObjectiveRevision
                ) {
                  throw new Error('Goal 复验提交时持久化状态发生了不一致变化。')
                }
                await store.updateRunState(options.runId, {
                  goal: {
                    ...state.goal,
                    status: 'active',
                    recheckCount,
                    lastVerdict: verdict,
                    failureReason: null,
                    updatedAt: recheckAt,
                  },
                })
                await store.appendTranscript({
                  threadId: assembly.threadId,
                  runId: options.runId,
                  turnId: assembly.turnId,
                  kind: 'checkpoint',
                  payload: {
                    type: 'goal_recheck',
                    goalId: latestGoal.goalId,
                    objectiveRevision: candidateObjectiveRevision,
                    recheckCount,
                    verdict,
                  },
                })
                eventSink.emit('goal.updated', `Goal 尚未满足，正在边界内继续执行：${verdict.reason}`, {
                  goalId: latestGoal.goalId,
                  status: 'active',
                  objectiveRevision: candidateObjectiveRevision,
                  recheckCount,
                  verdict,
                })
                itemSink.completeItem(itemId, {
                  body: finalOutput,
                  metadata: {
                    transcriptEntryId: persisted.entryId,
                    goalStatus: 'incomplete',
                    goalVerdict: verdict,
                    objectiveRevision: candidateObjectiveRevision,
                  },
                })
                await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
                await eventSink.flush()
                await itemSink.flush()
              },
            )
            if (!recheckCommitted) {
              await supersedeCurrentCandidate()
              nextInput = []
              continue
            }
            nextInput = [{
              type: 'message',
              role: 'user',
              content: goalDecision.instruction,
            }]
            continue
          }

          if (goalDecision.type === 'satisfied') {
            satisfiedGoal = { goal: latestGoal, verdict }
          }
        }

        if (!await steering.tryClaimTerminal(options.runId, candidateSnapshot)) {
          await supersedeCurrentCandidate()
          nextInput = []
          continue
        }
        if (satisfiedGoal) {
          const completedAt = new Date().toISOString()
          await store.updateRunState(options.runId, {
            goal: {
              ...satisfiedGoal.goal,
              status: 'satisfied',
              lastVerdict: satisfiedGoal.verdict,
              failureReason: null,
              updatedAt: completedAt,
              completedAt,
            },
          })
          eventSink.emit('goal.updated', `Goal 已通过第 ${satisfiedGoal.verdict.attempt} 次独立验收。`, {
            goalId: satisfiedGoal.goal.goalId,
            status: 'satisfied',
            objectiveRevision: candidateObjectiveRevision,
            verdict: satisfiedGoal.verdict,
          })
          goalMetadata = {
            goalStatus: 'satisfied',
            goalVerdict: satisfiedGoal.verdict,
            objectiveRevision: candidateObjectiveRevision,
          }
        }

        const lastAgentName = stream.lastAgent?.name
        if (lastAgentName && assembly.handoffAgentNames.has(lastAgentName)) {
          await assembly.completeHandoff(lastAgentName, delivery.summary)
        }
        itemSink.completeItem(itemId, {
          body: finalOutput,
          metadata: {
            transcriptEntryId: persisted.entryId,
            deliverySummary: delivery.summary,
            artifactIds: delivery.artifactIds,
            warnings: delivery.warnings,
            objectiveRevision: candidateObjectiveRevision,
            ...goalMetadata,
          },
        })
        await persistCleanCheckpoint(store, checkpoints, options.runId, stream.state, assembly)
        await eventSink.flush()
        await itemSink.flush()

        outcome = 'completed'
        return outcome
      }
    } catch (error) {
      let failure = error
      if (activeResponseUsageFlush) {
        try {
          // 投影、工具结算或终态校验都可能在完整模型响应之后失败。
          // rawResponses 只包含已完整响应，因此失败收口必须再做一次幂等 flush。
          await activeResponseUsageFlush()
        } catch (usageError) {
          failure = new AggregateError(
            [error, usageError],
            `运行 '${options.runId}' 失败，且已完成模型响应的用量保存失败`,
          )
        }
      }
      activeModelTelemetry?.fail(failure)
      const activeHandoff = assembly.coordinator.activeHandoffAgent()
      if (activeHandoff) {
        await assembly.failHandoff(activeHandoff, errorMessage(failure)).catch(handoffError => {
          logger.warn({ error: errorLogPayload(handoffError) }, 'handoff failure state update failed')
        })
      }
      if (activeProjection) {
        transcriptProjector.failPendingSubAgentItems(activeProjection, itemSink, errorMessage(failure))
      }
      throw failure
    } finally {
      await assembly.sdkIntegration.close().catch(error => {
        logger.warn({ error: errorLogPayload(error) }, 'sdk mcp close failed')
      })
    }
  }

}

/**
 * 单个 SDK stream 的 rawResponses 是累计数组；恢复态与分段续跑会把旧响应
 * 带入新 StreamedRunResult。游标只记录已消费的数组长度，并在 checkpoint
 * 之前推进，因此恢复后的初始长度就是持久增量边界。
 */
class RawResponseUsageCursor {
  constructor(private consumedResponseCount: number) {
    if (!Number.isSafeInteger(consumedResponseCount) || consumedResponseCount < 0) {
      throw new Error('模型响应计量游标必须是非负安全整数')
    }
  }

  async flush(
    responses: ModelUsageResponseLike[],
    persist: (increment: ModelUsageResponseLike[]) => Promise<void>,
  ): Promise<void> {
    const observedResponseCount = responses.length
    if (observedResponseCount < this.consumedResponseCount) {
      throw new Error(
        `模型响应累计数组从 ${this.consumedResponseCount} 缩短到 ${observedResponseCount}，拒绝重复计量`,
      )
    }
    const increment = responses.slice(this.consumedResponseCount, observedResponseCount)
    await persist(increment)
    this.consumedResponseCount = observedResponseCount
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function persistCleanCheckpoint(
  store: AgentRuntimeStore,
  checkpoints: AgentsSdkCheckpointService,
  runId: string,
  state: RuntimeAgentsSdkState,
  assembly: RuntimeAssembly,
): Promise<void> {
  // stream.completed 后的统一 checkpoint 已落盘相同 RunState。这些
  // terminal/supersede 分支只验证 ledger，不重写同一 blob/DB，也不得
  // 用 pending=[] 覆盖尚未进入 SDK state 的未知副作用。
  void checkpoints
  void state
  void assembly
  const checkpoint = await store.getRunCheckpoint(runId)
  if (checkpoint.pendingToolCallIds.length) {
    throw new Error(
      `运行 '${runId}' 的 SDK checkpoint 尚未包含工具结果：`
      + checkpoint.pendingToolCallIds.join('、'),
    )
  }
}

async function supersedeAssistantCandidate(input: {
  store: AgentRuntimeStore
  checkpoints: AgentsSdkCheckpointService
  assembly: RuntimeAssembly
  streamState: RuntimeAgentsSdkState
  eventSink: RunEventSink
  itemSink: ItemSink
  projection: StreamProjectionState
  runId: string
  objectiveRevision: number
  itemId?: string
  transcriptEntryId?: string
  body?: string
}): Promise<void> {
  const matchingCompleted = input.body === undefined
    ? undefined
    : [...input.projection.completedAssistantItems]
        .reverse()
        .find(item => item.text.trim() === input.body?.trim())
  const itemId = input.itemId
    ?? input.projection.assistantItemId
    ?? matchingCompleted?.itemId
    ?? (input.body === undefined
      ? null
      : input.itemSink.startItem('message', { role: 'assistant' }).itemId)
  if (itemId) {
    input.itemSink.completeItem(itemId, {
      ...(input.body === undefined ? {} : { body: input.body }),
      metadata: {
        ...(input.transcriptEntryId === undefined
          ? {}
          : { transcriptEntryId: input.transcriptEntryId }),
        objectiveRevision: input.objectiveRevision,
        supersededByNewObjectiveRevision: true,
      },
    })
    if (input.projection.assistantItemId === itemId) input.projection.assistantItemId = null
    if (input.body && input.projection.lastAssistantText.trim() === input.body.trim()) {
      input.projection.lastAssistantText = ''
    }
  }
  await persistCleanCheckpoint(
    input.store,
    input.checkpoints,
    input.runId,
    input.streamState,
    input.assembly,
  )
  await input.eventSink.flush()
  await input.itemSink.flush()
}

function optionalFinalText(finalOutput: unknown): string | null {
  return typeof finalOutput === 'string' && finalOutput.trim()
    ? finalOutput.trim()
    : null
}

function appendSegmentInput(
  input: AgentInputItem[] | string,
  items: readonly AgentInputItem[],
): AgentInputItem[] {
  const initial = typeof input === 'string'
    ? [{ type: 'message' as const, role: 'user' as const, content: input }]
    : input
  return [...structuredClone(initial), ...structuredClone(items)]
}

function requireFinalText(finalOutput: unknown): string {
  if (typeof finalOutput !== 'string' || !finalOutput.trim()) {
    throw new Error('Agent 最终输出不是非空文本')
  }
  return finalOutput.trim()
}

function platformDelivery(markdown: string, state: AgentState): SupervisorDelivery {
  return {
    markdown,
    summary: summarizeMarkdown(markdown),
    artifactIds: [...new Set(state.artifacts
      .filter(artifact => !artifact.isIntermediate)
      .map(artifact => artifact.artifactId))],
    warnings: [...state.warnings],
  }
}

function summarizeMarkdown(markdown: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/[#>*_`[\]()!-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!plain) return '任务已完成。'
  return plain.length > 160 ? `${plain.slice(0, 157)}…` : plain
}

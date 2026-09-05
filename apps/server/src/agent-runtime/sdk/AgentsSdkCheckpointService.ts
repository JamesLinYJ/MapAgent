// +-------------------------------------------------------------------------
//
//   地理智能平台 - OpenAI Agents SDK opaque checkpoint 服务
//
//   文件:       AgentsSdkCheckpointService.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import type { Agent } from '@openai/agents'
import { AGENT_STEP_CONTEXT_SCHEMA_VERSION } from '@geo-agent-platform/shared-types/agent-step-context'
import {
  CONTEXT_PROMPT_PROTOCOL_VERSION,
  CONTEXT_WINDOW_SCHEMA_VERSION,
  contextWindowSchema,
  type ContextWindow,
} from '@geo-agent-platform/shared-types/context-window'
import {
  MODEL_REQUEST_RECORD_SCHEMA_VERSION,
  type ModelRequestRecord,
} from '@geo-agent-platform/shared-types/model-request'

import type { RunSteeringRecord } from '../../schemas/types.js'
import type { AgentRuntimeStore } from '../../store/runtimePorts.js'
import type { AgentsExecutionContext } from '../../agent/agentsToolBridge.js'
import { SDK_STATE_SCHEMA_VERSION } from '../../agent/agentsRuntimeMetadata.js'
import type { RecordedAgentStepContext } from '../step/AgentStepContextFactory.js'
import { agentContextDigest } from '../step/agentContextDigest.js'
import { AgentsSdkBridge, type AgentsSdkState } from './AgentsSdkBridge.js'
import {
  AGENTS_SDK_CHECKPOINT_ENVELOPE_VERSION,
  AgentsSdkCheckpointCodec,
  type AgentsSdkCheckpointEnvelope,
} from './AgentsSdkCheckpointCodec.js'

type SupervisorAgent = Agent<AgentsExecutionContext>

export interface RestoreAgentsCheckpointOptions {
  runId: string
  agent: SupervisorAgent
  context: AgentsExecutionContext
  sdkVersion: string
  configDigest: string
  resolveStepContext(stepId: string): Promise<RecordedAgentStepContext | null>
  resolveActiveContextWindow(runId: string): Promise<ContextWindow | null>
}

export interface AgentsCheckpointCommit {
  acknowledgedInputs: RunSteeringRecord[]
  terminalToolCallIds: string[]
}

export interface RestoredAgentsCheckpoint {
  state: AgentsSdkState<AgentsExecutionContext>
  stepContext: RecordedAgentStepContext
}

export interface PersistAgentsCheckpointMetadata {
  sdkVersion: string
  configDigest: string
  stepContext: RecordedAgentStepContext
  terminalToolCallIds: readonly string[]
}

export class AgentsSdkCheckpointService {
  private readonly bridge = new AgentsSdkBridge()
  private readonly codec = new AgentsSdkCheckpointCodec()

  constructor(private readonly store: AgentRuntimeStore) {}

  async persist(
    runId: string,
    state: AgentsSdkState<AgentsExecutionContext>,
    metadata: PersistAgentsCheckpointMetadata,
    inputLeaseId: string | null = null,
    checkpointModelRequest = false,
  ): Promise<AgentsCheckpointCommit> {
    const checkpoint = await this.store.getRunCheckpoint(runId)
    const activeModelRequest = await this.store.getActiveModelRequest(runId)
    if (!activeModelRequest) {
      throw new Error(`run '${runId}' 缺少与 SDK checkpoint 绑定的模型请求`)
    }
    if (activeModelRequest.stepId !== metadata.stepContext.identity.stepId) {
      throw new Error(
        `run '${runId}' 的活动模型请求 StepContext 与 SDK checkpoint 不一致`,
      )
    }
    const inputCursor = checkpointCursorAfterCommit(checkpoint, inputLeaseId)
    if (inputCursor !== metadata.stepContext.inputCursor) {
      throw new Error(`run '${runId}' 的 checkpoint input cursor 与 StepContext 不一致`)
    }
    assertModelRequestBinding(activeModelRequest, metadata.stepContext, runId)
    const terminalToolCallIds = [...new Set(metadata.terminalToolCallIds)]
    const serializedEnvelope = this.codec.encode({
      envelopeVersion: AGENTS_SDK_CHECKPOINT_ENVELOPE_VERSION,
      publicSerializedState: this.bridge.serialize(state),
      sdkVersion: metadata.sdkVersion,
      sdkStateSchemaVersion: SDK_STATE_SCHEMA_VERSION,
      agentStepContextSchemaVersion: AGENT_STEP_CONTEXT_SCHEMA_VERSION,
      modelRequestSchemaVersion: MODEL_REQUEST_RECORD_SCHEMA_VERSION,
      runtimeConfigDigest: metadata.configDigest,
      toolPlanDigest: metadata.stepContext.toolPlanDigest,
      worldRevision: metadata.stepContext.worldRevision,
      objectiveRevision: metadata.stepContext.objectiveRevision,
      inputCursor,
      contextWindowId: metadata.stepContext.contextWindowId,
      contextDigest: metadata.stepContext.contextDigest,
      modelRequestId: activeModelRequest.requestId,
      segmentId: metadata.stepContext.identity.segmentId,
      stepId: metadata.stepContext.identity.stepId,
    })
    const acknowledgedInputs = await this.store.saveAgentsSdkCheckpointEnvelope(runId, serializedEnvelope, {
      agentsSdkVersion: metadata.sdkVersion,
      runtimeConfigDigest: metadata.configDigest,
      inputLeaseId,
      terminalToolCallIds,
      checkpointModelRequestStepId: checkpointModelRequest ? activeModelRequest.stepId : null,
    })
    return { acknowledgedInputs, terminalToolCallIds }
  }

  async restore(
    options: RestoreAgentsCheckpointOptions,
  ): Promise<RestoredAgentsCheckpoint> {
    const checkpoint = await this.store.getRunCheckpoint(options.runId)
    assertCheckpointCompatibility(checkpoint, {
      runId: options.runId,
      sdkVersion: options.sdkVersion,
      configDigest: options.configDigest,
    })
    const envelope = this.codec.decode(await this.store.readAgentsSdkCheckpointEnvelope(options.runId))
    assertEnvelopeCompatibility(envelope, checkpoint, options)
    const contextWindow = await options.resolveActiveContextWindow(options.runId)
    assertContextWindowCompatibility(contextWindow, envelope, options.runId)
    const stepContext = await options.resolveStepContext(envelope.stepId)
    if (!stepContext) throw new Error(`run '${options.runId}' 缺少 checkpoint StepContext '${envelope.stepId}'`)
    if (
      stepContext.runId !== options.runId
      || stepContext.identity.segmentId !== envelope.segmentId
      || stepContext.toolPlanDigest !== envelope.toolPlanDigest
      || stepContext.worldRevision !== envelope.worldRevision
      || stepContext.schemaVersion !== envelope.agentStepContextSchemaVersion
      || stepContext.objectiveRevision !== envelope.objectiveRevision
      || stepContext.inputCursor !== envelope.inputCursor
      || stepContext.contextWindowId !== envelope.contextWindowId
      || stepContext.contextDigest !== envelope.contextDigest
    ) {
      throw new Error(`run '${options.runId}' checkpoint StepContext 与 envelope 不一致`)
    }
    const modelRequests = await this.store.listModelRequests(options.runId)
    const modelRequest = modelRequests.find(record => record.requestId === envelope.modelRequestId)
    if (!modelRequest) {
      throw new Error(
        `run '${options.runId}' 缺少 checkpoint 模型请求 '${envelope.modelRequestId}'`,
      )
    }
    assertModelRequestBinding(modelRequest, stepContext, options.runId)
    return {
      state: await this.bridge.restore({
        agent: options.agent,
        context: options.context,
        publicSerializedState: envelope.publicSerializedState,
      }),
      stepContext,
    }
  }

  async requireTurnId(threadId: string, runId: string): Promise<string> {
    const entries = await this.store.activeTranscript(threadId)
    const entry = [...entries].reverse().find(candidate => candidate.runId === runId && candidate.turnId)
    if (!entry?.turnId) throw new Error(`run '${runId}' 缺少可恢复 turnId`)
    return entry.turnId
  }
}

export function assertCheckpointCompatibility(
  checkpoint: {
    orchestrationEngine: string | null
    sdkStateSchemaVersion: number | null
    agentsSdkVersion: string | null
    runtimeConfigDigest: string | null
  },
  expected: { runId: string; sdkVersion: string; configDigest: string },
): void {
  if (checkpoint.orchestrationEngine !== 'openai_agents') {
    throw new Error(`run '${expected.runId}' 不是 OpenAI Agents SDK 检查点，不能续跑`)
  }
  if (checkpoint.sdkStateSchemaVersion !== SDK_STATE_SCHEMA_VERSION) {
    throw new Error(`run '${expected.runId}' SDK 状态 schema 不匹配`)
  }
  if (checkpoint.agentsSdkVersion !== expected.sdkVersion) {
    throw new Error(`run '${expected.runId}' SDK 版本不匹配：${checkpoint.agentsSdkVersion} != ${expected.sdkVersion}`)
  }
  if (checkpoint.runtimeConfigDigest !== expected.configDigest) {
    throw new Error(`run '${expected.runId}' 运行配置已变化，拒绝恢复`)
  }
}

function checkpointCursorAfterCommit(
  checkpoint: {
    checkpointInputCursor: number
    activeInputLeaseId: string | null
    activeInputLeaseTo: number | null
  },
  inputLeaseId: string | null,
): number {
  if (!inputLeaseId) return checkpoint.checkpointInputCursor
  if (checkpoint.activeInputLeaseId !== inputLeaseId || checkpoint.activeInputLeaseTo === null) {
    throw new Error(
      `输入 lease '${inputLeaseId}' 与活动 checkpoint lease `
      + `'${checkpoint.activeInputLeaseId ?? 'none'}' 不一致`,
    )
  }
  return checkpoint.activeInputLeaseTo
}

function assertEnvelopeCompatibility(
  envelope: AgentsSdkCheckpointEnvelope,
  checkpoint: {
    sdkStateSchemaVersion: number | null
    agentsSdkVersion: string | null
    runtimeConfigDigest: string | null
    checkpointInputCursor: number
  },
  expected: RestoreAgentsCheckpointOptions,
): void {
  if (envelope.sdkStateSchemaVersion !== checkpoint.sdkStateSchemaVersion) {
    throw new Error(`run '${expected.runId}' checkpoint envelope schema 与数据库不一致`)
  }
  if (envelope.sdkVersion !== checkpoint.agentsSdkVersion) {
    throw new Error(`run '${expected.runId}' checkpoint envelope SDK 版本与数据库不一致`)
  }
  if (envelope.runtimeConfigDigest !== checkpoint.runtimeConfigDigest) {
    throw new Error(`run '${expected.runId}' checkpoint envelope 配置摘要与数据库不一致`)
  }
  if (envelope.inputCursor !== checkpoint.checkpointInputCursor) {
    throw new Error(`run '${expected.runId}' checkpoint envelope input cursor 与数据库不一致`)
  }
  if (envelope.agentStepContextSchemaVersion !== AGENT_STEP_CONTEXT_SCHEMA_VERSION) {
    throw new Error(`run '${expected.runId}' StepContext schema 版本不匹配`)
  }
  if (envelope.modelRequestSchemaVersion !== MODEL_REQUEST_RECORD_SCHEMA_VERSION) {
    throw new Error(`run '${expected.runId}' 模型请求 schema 版本不匹配`)
  }
}

function assertModelRequestBinding(
  request: ModelRequestRecord,
  stepContext: RecordedAgentStepContext,
  runId: string,
): void {
  if (
    request.schemaVersion !== MODEL_REQUEST_RECORD_SCHEMA_VERSION
    || request.runId !== runId
    || request.stepId !== stepContext.identity.stepId
    || request.turnId !== stepContext.turnId
    || request.segmentId !== stepContext.identity.segmentId
    || request.objectiveRevision !== stepContext.objectiveRevision
    || request.inputCursor !== stepContext.inputCursor
    || request.contextWindowId !== stepContext.contextWindowId
    || request.contextDigest !== stepContext.contextDigest
    || request.agentStepContextSchemaVersion !== stepContext.schemaVersion
    || request.toolPlanDigest !== stepContext.toolPlanDigest
    || request.worldRevision !== stepContext.worldRevision
  ) {
    throw new Error(`run '${runId}' 的模型请求与 StepContext 绑定不一致`)
  }
}

function assertContextWindowCompatibility(
  candidate: ContextWindow | null,
  envelope: AgentsSdkCheckpointEnvelope,
  runId: string,
): void {
  if (!candidate) {
    throw new Error(`run '${runId}' 缺少活动上下文窗口 '${envelope.contextWindowId}'`)
  }
  let contextWindow: ContextWindow
  try {
    contextWindow = contextWindowSchema.parse(candidate)
  } catch (error) {
    throw new Error(`run '${runId}' 上下文窗口 schema 版本不匹配`, { cause: error })
  }
  if (contextWindow.schemaVersion !== CONTEXT_WINDOW_SCHEMA_VERSION) {
    throw new Error(`run '${runId}' 上下文窗口 schema 版本不匹配`)
  }
  if (contextWindow.promptProtocolVersion !== CONTEXT_PROMPT_PROTOCOL_VERSION) {
    throw new Error(`run '${runId}' 上下文窗口提示协议版本不匹配`)
  }
  if (agentContextDigest(contextWindow.sourceSummary) !== contextWindow.sourceDigest) {
    throw new Error(`run '${runId}' 上下文窗口来源摘要校验失败`)
  }
  if (
    contextWindow.runId !== runId
    || contextWindow.contextWindowId !== envelope.contextWindowId
    || contextWindow.closedAt !== null
  ) {
    throw new Error(`run '${runId}' checkpoint 上下文窗口与活动窗口不一致`)
  }
}

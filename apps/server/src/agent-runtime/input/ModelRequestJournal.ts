// +-------------------------------------------------------------------------
//
//   地理智能平台 - 精确 ModelRequest 日志
//
//   文件:       ModelRequestJournal.ts
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-08-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 新请求与恢复重放统一使用 canonical 快照，避免对象键序改变模型前缀。
//
//   维护记录 (2026-08-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 重放仅透传 signal、SDK 重试标记和追踪父 Span 等瞬态控制，其余字段保持快照。
//
//   provider 发包前把去除 AbortSignal 的完整请求写入内容寻址对象，并与
//   StepContext / input.included 原子绑定。恢复只重放该对象，不重新拼接请求。
// --------------------------------------------------------------------------

import type { ModelRequest } from '@openai/agents'
import {
MODEL_REQUEST_RECORD_SCHEMA_VERSION,
type ModelRequestRecord,
} from '@geo-agent-platform/shared-types/model-request'

import { isRecord,stableJson } from '../../framework/schema.js'
import { runInputConversationItem } from '../../store/runInputConversationItem.js'
import type { AgentRuntimeStore } from '../../store/runtimePorts.js'
import { makeId,nowUtc } from '../../utils/ids.js'
import type { RecordedAgentStepContext } from '../step/AgentStepContextFactory.js'
import { agentContextDigest } from '../step/agentContextDigest.js'
import { buildAgentInputContextUnits } from '../context/ContextUnit.js'

type PersistedModelRequest = Omit<ModelRequest, 'signal'>

export class ModelRequestJournal {
  constructor(private readonly store: AgentRuntimeStore) {}

  async commit(input: {
    runId: string
    provider: string
    modelId: string
    context: RecordedAgentStepContext
    request: ModelRequest
  }): Promise<{ record: ModelRequestRecord; request: ModelRequest }> {
    const snapshot = snapshotRequest(input.request)
    const serialized = stableJson(snapshot)
    const canonicalSnapshot = parseSnapshot(serialized, 'new')
    const summaryObjectHashes = await persistSummaryObjects(this.store, canonicalSnapshot.input)
    const committed = await this.store.publishModelRequestSnapshot(serialized, {
      schemaVersion: MODEL_REQUEST_RECORD_SCHEMA_VERSION,
      requestId: makeId('model_request'),
      runId: input.runId,
      turnId: input.context.turnId,
      stepId: input.context.identity.stepId,
      segmentId: input.context.identity.segmentId,
      objectiveRevision: input.context.objectiveRevision,
      inputCursor: input.context.inputCursor,
      contextWindowId: input.context.contextWindowId,
      contextDigest: input.context.contextDigest,
      agentStepContextSchemaVersion: input.context.schemaVersion,
      provider: input.provider,
      modelId: input.modelId,
      inputDigest: agentContextDigest(canonicalSnapshot.input),
      instructionsDigest: agentContextDigest(canonicalSnapshot.systemInstructions ?? null),
      toolPlanDigest: input.context.toolPlanDigest,
      worldRevision: input.context.worldRevision,
      summaryObjectHashes,
      createdAt: nowUtc(),
    })
    await this.store.projectPersistedItems(
      committed.includedInputs.map(runInputConversationItem),
    )
    return {
      record: committed.record,
      request: withTransientTransportControls(canonicalSnapshot, input.request),
    }
  }

  async replay(
    record: ModelRequestRecord,
    currentRequest: ModelRequest,
  ): Promise<ModelRequest> {
    const serialized = await this.store.readModelRequestSnapshot(record)
    const parsed = parseSnapshot(serialized, record.requestId)
    if (stableJson(parsed) !== serialized) {
      throw new Error(`模型请求 '${record.requestId}' 对象不是 canonical JSON`)
    }
    if (agentContextDigest(parsed.input) !== record.inputDigest) {
      throw new Error(`模型请求 '${record.requestId}' input digest 校验失败`)
    }
    if (agentContextDigest(parsed.systemInstructions ?? null) !== record.instructionsDigest) {
      throw new Error(`模型请求 '${record.requestId}' instructions digest 校验失败`)
    }
    return withTransientTransportControls(parsed, currentRequest)
  }
}

async function persistSummaryObjects(
  store: AgentRuntimeStore,
  input: PersistedModelRequest['input'],
): Promise<string[]> {
  if (typeof input === 'string') return []
  const summaries = buildAgentInputContextUnits(input)
    .filter(unit => unit.kind === 'compaction_summary' && unit.objectHash)
  const references = await Promise.all(summaries.map(unit => (
    store.putConversationObject(stableJson(unit.items), 'application/json')
  )))
  return references.map(reference => reference.hash)
}

function snapshotRequest(request: ModelRequest): PersistedModelRequest {
  const { signal: _signal, ...persistable } = request
  const serialized = JSON.stringify(persistable)
  if (!serialized) throw new Error('ModelRequest 不能序列化为 JSON')
  const snapshot: unknown = JSON.parse(serialized)
  if (isRecord(snapshot) && isRecord(snapshot._internal)) {
    delete snapshot._internal.runnerManagedRetry
    delete snapshot._internal.tracingParent
    if (Object.keys(snapshot._internal).length === 0) delete snapshot._internal
  }
  const encoded = JSON.stringify(snapshot)
  return parseSnapshot(encoded, 'new')
}

function parseSnapshot(serialized: string, requestId: string): PersistedModelRequest {
  const value: unknown = JSON.parse(serialized)
  if (
    !isRecord(value)
    || !(typeof value.input === 'string' || Array.isArray(value.input))
    || !isRecord(value.modelSettings)
    || !Array.isArray(value.tools)
    || !Array.isArray(value.handoffs)
    || !(
      typeof value.tracing === 'boolean'
      || value.tracing === 'enabled_without_data'
    )
    || !(typeof value.outputType === 'string' || isRecord(value.outputType))
  ) {
    throw new Error(`模型请求 '${requestId}' 对象结构不完整`)
  }
  return value as PersistedModelRequest
}

function withTransientTransportControls(
  snapshot: PersistedModelRequest,
  currentRequest: ModelRequest,
): ModelRequest {
  const copy = structuredClone(snapshot)
  const runnerManagedRetry = readRunnerManagedRetry(currentRequest)
  const tracingParent = readInternalControls(currentRequest).tracingParent
  const transientInternal = {
    ...readInternalControls(copy),
    ...(runnerManagedRetry === undefined ? {} : { runnerManagedRetry }),
    ...(tracingParent === undefined ? {} : { tracingParent }),
  }
  const withTransientInternal = Object.keys(transientInternal).length
    ? { ...copy, _internal: transientInternal }
    : copy
  return currentRequest.signal
    ? { ...withTransientInternal, signal: currentRequest.signal }
    : withTransientInternal
}

function readRunnerManagedRetry(request: ModelRequest): boolean | undefined {
  const candidate: unknown = request
  if (!isRecord(candidate) || !isRecord(candidate._internal)) return undefined
  return typeof candidate._internal.runnerManagedRetry === 'boolean'
    ? candidate._internal.runnerManagedRetry
    : undefined
}

function readInternalControls(request: unknown): Record<string, unknown> {
  const candidate: unknown = request
  return isRecord(candidate) && isRecord(candidate._internal)
    ? candidate._internal
    : {}
}

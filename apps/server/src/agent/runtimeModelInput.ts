// +-------------------------------------------------------------------------
//
//   地理智能平台 - Runner 模型输入预算控制
//
//   文件:       runtimeModelInput.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-08-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 压缩决策纳入后注入上下文与完整请求包络，并以最终请求回写容量估算。
// --------------------------------------------------------------------------

import type { AgentInputItem,Model,ModelRequest } from '@openai/agents'
import type { RuntimeContextConfig } from '../schemas/types.js'
import {
buildAgentInputContextUnits,
flattenContextUnits,
selectContextCompactionSlice,
} from '../agent-runtime/context/ContextUnit.js'
import { isRuntimeContextItem } from '../agent-runtime/context/RuntimeContextReinjection.js'
import { isWorldBaselineItem } from '../agent-runtime/context/WorldBaselineReinjection.js'
import { estimateTextTokens } from './tokenEstimate.js'

const MODEL_INPUT_SUMMARY_PROMPT_VERSION = 'run-history-summary-v2'

export interface RuntimeModelInputData {
  input: AgentInputItem[]
  instructions?: string
}

class ModelRequestContextBudgetExceededError extends Error {
  readonly code = 'model_request_context_budget_exceeded'

  constructor(
    readonly estimatedTokens: number,
    readonly hardLimitTokens: number,
  ) {
    super(`精确模型请求需要约 ${estimatedTokens} 个估算词元，超过硬限制 ${hardLimitTokens} 个估算词元。`)
    this.name = 'ModelRequestContextBudgetExceededError'
  }
}

export interface ToolOutputReference {
  callId: string
  toolName: string
  resultId: string | null
  summary: string
  valueRefIds: string[]
  artifactIds: string[]
}

interface PersistedModelInputSummary {
  sourceDigest: string
  summary: string
  sourceItemCount: number
  sourceUnitIds: string[]
  sourceEntryIds: string[]
  sourceObjectHashes: string[]
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  summaryProvider: string
  summaryModel: string
  promptVersion: string
}

interface RuntimeModelInputControllerOptions {
  config: RuntimeContextConfig
  summarize(prompt: string): Promise<string>
  resolveToolOutput(callId: string): Promise<ToolOutputReference | null>
  persistSummary(record: PersistedModelInputSummary): Promise<void>
  onCompacted(record: PersistedModelInputSummary): Promise<void>
  existingSummaries?: ReadonlyMap<string, string>
  summaryIdentity: {
    provider: string
    model: string
  }
  updateEstimatedTokens(tokens: number): Promise<void>
}

interface CompactedModelInput {
  input: AgentInputItem[]
  estimatedBefore: number
  estimatedAfter: number
}

// 跨轮压缩仍由 contextManager 维护 canonical transcript；这里仅控制单次
// Runner 调用的模型输入。任何压缩都以完整旧消息/工具组为单位，不改写事实源。
export class RuntimeModelInputController {
  private readonly summaries: Map<string, string>
  private readonly persistedDigests: Set<string>
  private lastReportedTokens: number | null = null
  private requestEnvelopeReservationTokens = 0
  private hasMeasuredRequestEnvelope = false

  constructor(private readonly options: RuntimeModelInputControllerOptions) {
    this.summaries = new Map(options.existingSummaries)
    this.persistedDigests = new Set(options.existingSummaries?.keys() ?? [])
  }

  async filter(
    modelData: RuntimeModelInputData,
    appendedItems: AgentInputItem[],
  ): Promise<RuntimeModelInputData> {
    const combined = [...modelData.input, ...appendedItems]
    const reduced = await this.reduceLargeToolOutputs(combined)
    const instructions = modelData.instructions ?? ''
    const reservation = this.requestEnvelopeReservationTokens
    const compacted = await this.compactReducedInput(
      reduced,
      items => this.hasMeasuredRequestEnvelope
        ? estimateInputTokens(items, '') + reservation
        : estimateInputTokens(items, instructions),
    )
    await this.reportEstimatedTokens(compacted.estimatedAfter)
    return withInstructions(compacted.input, modelData.instructions)
  }

  /**
   * 在 transport 边界对已注入 Runtime Context、GeoWorld、工具目录与输出
   * schema 的完整请求做权威预算决策。这里仍只改变本次 provider 视图，
   * canonical transcript 和 SDK Session 均不被改写。
   */
  async finalizeRequest(request: ModelRequest): Promise<ModelRequest> {
    const input = await this.reduceLargeToolOutputs(modelRequestInputItems(request.input))
    const requestWithReducedOutputs = { ...request, input }
    this.rememberRequestEnvelopeReservation(requestWithReducedOutputs)
    const compacted = await this.compactReducedInput(
      input,
      items => estimateModelRequestTokens({ ...request, input: items }),
    )
    assertEstimatedTokensWithinContextBudget(compacted.estimatedAfter, this.options.config)
    await this.reportEstimatedTokens(compacted.estimatedAfter)
    return { ...request, input: compacted.input }
  }

  /**
   * durable replay 必须保持已提交 ModelRequest 的字节语义不变，因此这里只
   * 回写完整请求估算并校验硬上限，不再次压缩或改写请求。
   */
  async observeFinalRequest(request: ModelRequest): Promise<number> {
    const estimatedTokens = estimateModelRequestTokens(request)
    this.rememberRequestEnvelopeReservation(request)
    assertEstimatedTokensWithinContextBudget(estimatedTokens, this.options.config)
    await this.reportEstimatedTokens(estimatedTokens)
    return estimatedTokens
  }

  private async compactReducedInput(
    reduced: AgentInputItem[],
    estimateTokens: (items: AgentInputItem[]) => number,
  ): Promise<CompactedModelInput> {
    const estimatedBefore = estimateTokens(reduced)
    const compactThreshold = Math.floor(
      this.options.config.contextWindowTokens * this.options.config.compactRatio,
    )
    const hardLimit = Math.floor(
      this.options.config.contextWindowTokens * this.options.config.hardLimitRatio,
    )
    if (estimatedBefore < compactThreshold) {
      return {
        input: reduced,
        estimatedBefore,
        estimatedAfter: estimatedBefore,
      }
    }

    const units = buildAgentInputContextUnits(reduced, {
      projectItem: stripRunInputMarkerForModel,
    })
    const selection = selectContextCompactionSlice(
      units,
      this.options.config.preserveRecentTurns,
    )
    if (!selection.sourceUnits.length || !selection.sourceDigest) {
      if (estimatedBefore >= hardLimit) {
        await this.reportEstimatedTokens(estimatedBefore)
        throw new Error('模型上下文已达到硬上限，且没有可安全压缩的完整旧消息组。请新建任务或减少输入。')
      }
      return {
        input: reduced,
        estimatedBefore,
        estimatedAfter: estimatedBefore,
      }
    }

    const sourceItems = flattenContextUnits(selection.sourceUnits)
    const modelVisibleSourceItems = sourceItems.map(stripRunInputMarkerForModel)
    const sourceDigest = selection.sourceDigest
    let summary = this.summaries.get(sourceDigest)
    if (!summary) {
      summary = (await this.options.summarize(buildSummaryPrompt(modelVisibleSourceItems))).trim()
      if (!summary) throw new Error('运行中上下文压缩失败：摘要模型返回空内容。')
      this.summaries.set(sourceDigest, summary)
    }
    const summaryItem: AgentInputItem = {
      type: 'message',
      role: 'system',
      content: `<run-history-summary source-digest="${sourceDigest}">\n${summary}\n</run-history-summary>`,
    }
    const nextInput = [
      ...flattenContextUnits(selection.leadingUnits),
      summaryItem,
      ...flattenContextUnits(selection.preservedUnits),
    ]
    const estimatedAfter = estimateTokens(nextInput)
    if (estimatedAfter >= hardLimit) {
      await this.reportEstimatedTokens(estimatedAfter)
      throw new Error('模型上下文压缩后仍达到硬上限；为避免破坏工具调用或推理配对，运行已停止。')
    }
    const record: PersistedModelInputSummary = {
      sourceDigest,
      summary,
      sourceItemCount: sourceItems.length,
      sourceUnitIds: selection.sourceUnits.map(unit => unit.unitId),
      sourceEntryIds: selection.sourceEntryIds,
      sourceObjectHashes: selection.sourceUnits.flatMap(unit => (
        unit.objectHash ? [unit.objectHash] : []
      )),
      estimatedTokensBefore: estimatedBefore,
      estimatedTokensAfter: estimatedAfter,
      summaryProvider: this.options.summaryIdentity.provider,
      summaryModel: this.options.summaryIdentity.model,
      promptVersion: MODEL_INPUT_SUMMARY_PROMPT_VERSION,
    }
    if (!this.persistedDigests.has(sourceDigest)) {
      await this.options.persistSummary(record)
      this.persistedDigests.add(sourceDigest)
    }
    // 即使摘要已存在也再次核对窗口；这样进程若在“摘要落盘”和“窗口换代”
    // 之间中断，恢复后仍能补齐显式窗口事实，而不会依赖隐含内存状态。
    await this.options.onCompacted(record)
    return {
      input: nextInput,
      estimatedBefore,
      estimatedAfter,
    }
  }

  private async reportEstimatedTokens(tokens: number): Promise<void> {
    if (this.lastReportedTokens === tokens) return
    await this.options.updateEstimatedTokens(tokens)
    this.lastReportedTokens = tokens
  }

  private rememberRequestEnvelopeReservation(request: ModelRequest): void {
    const input = modelRequestInputItems(request.input)
    const inputBeforeLateInjection = input.filter(item => (
      !isRuntimeContextItem(item) && !isWorldBaselineItem(item)
    ))
    const inputTokensBeforeLateInjection = estimateInputTokens(inputBeforeLateInjection, '')
    const reservation = Math.max(
      0,
      estimateModelRequestTokens(request) - inputTokensBeforeLateInjection,
    )
    this.requestEnvelopeReservationTokens = Math.max(
      this.requestEnvelopeReservationTokens,
      reservation,
    )
    this.hasMeasuredRequestEnvelope = true
  }

  private async reduceLargeToolOutputs(items: AgentInputItem[]): Promise<AgentInputItem[]> {
    const selection = selectContextCompactionSlice(
      buildAgentInputContextUnits(items, { projectItem: stripRunInputMarkerForModel }),
      this.options.config.preserveRecentTurns,
    )
    const compactableItems = new Set(flattenContextUnits(selection.sourceUnits))
    const output: AgentInputItem[] = []
    for (const item of items) {
      if (
        !compactableItems.has(item)
        || item.type !== 'function_call_result'
        || serializedOutputLength(item.output) <= this.options.config.inlineToolResultMaxChars
      ) {
        output.push(item)
        continue
      }
      const reference = await this.options.resolveToolOutput(item.callId)
      if (!reference) {
        output.push(item)
        continue
      }
      output.push({
        ...item,
        output: JSON.stringify({
          summary: reference.summary,
          resultId: reference.resultId,
          valueRefIds: reference.valueRefIds,
          artifactIds: reference.artifactIds,
          note: '大型结果已从模型上下文缩减；完整内容仍保存在平台事实源中。',
        }),
      })
    }
    return output
  }
}

const protectedModels = new WeakMap<Model, Model>()

export type ModelRequestObserver = (request: ModelRequest) => Promise<ModelRequest>

// filter 的返回值同时用于 SDK Session 持久化，不能在这里删除 delivery
// marker；否则外层 Runner 会把无 marker 副本再次写入历史。模型边界仅对
// 即将发给 provider 的请求副本脱敏，RunState/Session 继续保留幂等键。
export function protectModelTransportFromRunInputMarkers(
  model: Model,
  observeRequest?: ModelRequestObserver,
): Model {
  if (!observeRequest) {
    const existing = protectedModels.get(model)
    if (existing) return existing
  }
  const protectedModel: Model = {
    getResponse: async request => {
      const protectedRequest = stripRunInputMarkersFromRequest(request)
      const committedRequest = observeRequest
        ? await observeRequest(protectedRequest)
        : protectedRequest
      return model.getResponse(committedRequest)
    },
    getStreamedResponse: request => observeStreamedRequest(
      model,
      stripRunInputMarkersFromRequest(request),
      observeRequest,
    ),
    getRetryAdvice: args => model.getRetryAdvice?.(args),
  }
  if (!observeRequest) {
    protectedModels.set(model, protectedModel)
    protectedModels.set(protectedModel, protectedModel)
  }
  return protectedModel
}

/**
 * transport 边界的请求还包含工具目录、handoff、输出 schema 与 GeoWorld 基线，
 * 它们不一定出现在 SDK 的 history filter 中。provider I/O 前必须按最终可见
 * 请求重新核对硬上限，不能只相信压缩前的历史估算。
 */
export function assertModelRequestWithinContextBudget(
  request: ModelRequest,
  config: Pick<RuntimeContextConfig, 'contextWindowTokens' | 'hardLimitRatio'>,
): number {
  const estimatedTokens = estimateModelRequestTokens(request)
  assertEstimatedTokensWithinContextBudget(estimatedTokens, config)
  return estimatedTokens
}

export function estimateModelRequestTokens(request: ModelRequest): number {
  return estimateTextTokens(JSON.stringify({
    input: typeof request.input === 'string'
      ? request.input
      : request.input.map(stripRunInputMarkerForModel),
    systemInstructions: request.systemInstructions ?? null,
    tools: request.tools,
    handoffs: request.handoffs,
    outputType: request.outputType,
  }))
}

function assertEstimatedTokensWithinContextBudget(
  estimatedTokens: number,
  config: Pick<RuntimeContextConfig, 'contextWindowTokens' | 'hardLimitRatio'>,
): void {
  const hardLimitTokens = Math.floor(config.contextWindowTokens * config.hardLimitRatio)
  if (estimatedTokens >= hardLimitTokens) {
    throw new ModelRequestContextBudgetExceededError(estimatedTokens, hardLimitTokens)
  }
}

async function* observeStreamedRequest(
  model: Model,
  request: ModelRequest,
  observer: ModelRequestObserver | undefined,
): ReturnType<Model['getStreamedResponse']> {
  const committedRequest = observer ? await observer(request) : request
  yield* model.getStreamedResponse(committedRequest)
}

function stripRunInputMarkersFromRequest(request: ModelRequest): ModelRequest {
  if (typeof request.input === 'string') return request
  return { ...request, input: request.input.map(stripRunInputMarkerForModel) }
}

function modelRequestInputItems(input: ModelRequest['input']): AgentInputItem[] {
  return typeof input === 'string'
    ? [{ type: 'message', role: 'user', content: input }]
    : input
}

function stripRunInputMarkerForModel(item: AgentInputItem): AgentInputItem {
  if (!('providerData' in item) || !item.providerData) return item
  if (!Object.prototype.hasOwnProperty.call(item.providerData, 'geoAgentRunInput')) return item

  const copy = structuredClone(item)
  if (!('providerData' in copy) || !copy.providerData) return copy
  const providerData: Record<string, unknown> = { ...copy.providerData }
  delete providerData.geoAgentRunInput
  if (Object.keys(providerData).length === 0) {
    delete copy.providerData
  } else {
    copy.providerData = providerData
  }
  return copy
}

function estimateInputTokens(items: AgentInputItem[], instructions: string): number {
  return estimateTextTokens(
    JSON.stringify(items.map(stripRunInputMarkerForModel)),
    instructions,
  )
}

function serializedOutputLength(output: Extract<AgentInputItem, { type: 'function_call_result' }>['output']): number {
  return typeof output === 'string' ? output.length : JSON.stringify(output).length
}

function buildSummaryPrompt(items: AgentInputItem[]): string {
  return [
    `摘要协议版本：${MODEL_INPUT_SUMMARY_PROMPT_VERSION}`,
    '请将以下完整旧对话组压缩为可供后续 Agent 继续工作的中文事实摘要。',
    '保留用户约束、已经确认的结论、工具结果引用、失败与未解决事项；不得补充未出现的事实。',
    '不要输出工具调用协议或代码块，只输出信息密集的摘要正文。',
    '',
    JSON.stringify(items),
  ].join('\n')
}

function withInstructions(
  input: AgentInputItem[],
  instructions: string | undefined,
): RuntimeModelInputData {
  return instructions === undefined ? { input } : { input, instructions }
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 统一上下文协议单元
//
//   文件:       ContextUnit.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import type { AgentInputItem } from '@openai/agents'
import type { TranscriptEntry } from '../../schemas/types.js'
import { estimateTextTokens } from '../../agent/tokenEstimate.js'

type ContextUnitKind =
  | 'system'
  | 'memory'
  | 'resource'
  | 'user_message'
  | 'assistant_message'
  | 'tool_exchange'
  | 'approval_exchange'
  | 'world_diff'
  | 'compaction_summary'

/**
 * Thread context 与单次模型窗口共用的最小协议单元。
 *
 * `items` 与 `complete` 是运行时选择所需的内部载荷；其余字段对应架构
 * 文档中的持久化/审计描述。调用方只能整组保留或移除，不能切开同一
 * `groupId` 下的 reasoning、call、result 或 approval exchange。
 */
export interface ContextUnit<T> {
  unitId: string
  kind: ContextUnitKind
  sourceEntryIds: string[]
  estimatedTokens: number
  mandatory: boolean
  groupId: string | null
  objectHash: string | null
  items: T[]
  complete: boolean
}

export interface ContextCompactionSlice<T> {
  leadingUnits: ContextUnit<T>[]
  sourceUnits: ContextUnit<T>[]
  preservedUnits: ContextUnit<T>[]
  sourceDigest: string | null
  sourceEntryIds: string[]
}

interface AgentContextUnitOptions {
  projectItem?: (item: AgentInputItem) => AgentInputItem
}

interface TranscriptContextUnitOptions {
  protectCompactionSummary?: boolean
}

interface ContextUnitDraft<T> {
  kind: ContextUnitKind
  items: T[]
  mandatory: boolean
  groupId: string | null
  complete: boolean
  sourceIds: string[]
  projectedItems: unknown[]
}

interface ProtocolCorrelation {
  calls: Set<string>
  results: Set<string>
  hasProtocolItem: boolean
}

export function buildAgentInputContextUnits(
  items: readonly AgentInputItem[],
  options: AgentContextUnitOptions = {},
): ContextUnit<AgentInputItem>[] {
  const project = options.projectItem ?? (item => item)
  const drafts: Array<ContextUnitDraft<AgentInputItem>> = []
  let responseItems: AgentInputItem[] = []
  let responseSourceIds: string[] = []
  let responseProjectedItems: AgentInputItem[] = []
  let activeGroupId: string | null = null
  let latestUserGroupId: string | null = null

  const flushResponse = (): void => {
    if (!responseItems.length) return
    const correlation = correlateAgentProtocol(responseItems)
    drafts.push({
      kind: responseUnitKind(responseItems),
      items: responseItems,
      sourceIds: responseSourceIds,
      projectedItems: responseProjectedItems,
      mandatory: !protocolCorrelationComplete(correlation),
      groupId: activeGroupId,
      complete: protocolCorrelationComplete(correlation),
    })
    responseItems = []
    responseSourceIds = []
    responseProjectedItems = []
  }

  for (const item of items) {
    const sourceId = agentItemSourceId(item)
    const projected = project(item)
    if (isSystemMessage(item)) {
      flushResponse()
      const kind = taggedSystemKind(item)
      drafts.push({
        kind,
        items: [item],
        sourceIds: [sourceId],
        projectedItems: [projected],
        mandatory: kind !== 'compaction_summary',
        groupId: null,
        complete: true,
      })
      activeGroupId = null
      continue
    }
    if (isUserMessage(item)) {
      flushResponse()
      activeGroupId = `turn:${sourceId}`
      latestUserGroupId = activeGroupId
      drafts.push({
        kind: 'user_message',
        items: [item],
        sourceIds: [sourceId],
        projectedItems: [projected],
        mandatory: false,
        groupId: activeGroupId,
        complete: true,
      })
      continue
    }
    if (!activeGroupId) activeGroupId = `protocol:${sourceId}`
    responseItems.push(item)
    responseSourceIds.push(sourceId)
    responseProjectedItems.push(projected)
    if (isAssistantMessage(item)) {
      flushResponse()
      activeGroupId = null
    }
  }
  flushResponse()

  return drafts.map(draft => materializeUnit({
    ...draft,
    mandatory: draft.mandatory
      || (draft.groupId !== null && draft.groupId === latestUserGroupId),
  }))
}

export function buildTranscriptContextUnits(
  entries: readonly TranscriptEntry[],
  options: TranscriptContextUnitOptions = {},
): ContextUnit<TranscriptEntry>[] {
  const drafts: Array<ContextUnitDraft<TranscriptEntry>> = []
  let responseEntries: TranscriptEntry[] = []
  let activeGroupId: string | null = null

  const flushResponse = (): void => {
    if (!responseEntries.length) return
    const correlation = correlateTranscriptProtocol(responseEntries)
    drafts.push({
      kind: transcriptResponseUnitKind(responseEntries),
      items: responseEntries,
      sourceIds: responseEntries.map(entry => entry.entryId),
      projectedItems: responseEntries,
      mandatory: !protocolCorrelationComplete(correlation),
      groupId: activeGroupId,
      complete: protocolCorrelationComplete(correlation),
    })
    responseEntries = []
  }

  for (const entry of entries) {
    if (entry.kind === 'compact_summary') {
      flushResponse()
      activeGroupId = `compaction:${stringField(entry.payload.compactionId) ?? entry.entryId}`
      drafts.push({
        kind: 'compaction_summary',
        items: [entry],
        sourceIds: [entry.entryId],
        projectedItems: [entry],
        mandatory: options.protectCompactionSummary === true,
        groupId: activeGroupId,
        complete: true,
      })
      continue
    }
    if (entry.kind === 'message' && entry.payload.role === 'system') {
      flushResponse()
      activeGroupId = null
      drafts.push({
        kind: 'system',
        items: [entry],
        sourceIds: [entry.entryId],
        projectedItems: [entry],
        mandatory: true,
        groupId: null,
        complete: true,
      })
      continue
    }
    if (entry.kind === 'message' && entry.payload.role === 'user') {
      flushResponse()
      activeGroupId = `turn:${entry.entryId}`
      drafts.push({
        kind: 'user_message',
        items: [entry],
        sourceIds: [entry.entryId],
        projectedItems: [entry],
        mandatory: false,
        groupId: activeGroupId,
        complete: true,
      })
      continue
    }
    if (!activeGroupId) activeGroupId = `protocol:${entry.entryId}`
    responseEntries.push(entry)
  }
  flushResponse()
  return drafts.map(materializeUnit)
}

export function selectContextCompactionSlice<T>(
  units: readonly ContextUnit<T>[],
  preserveRecentTurns: number,
): ContextCompactionSlice<T> {
  const protectedGroups = protectedContextGroups(units, preserveRecentTurns)
  let sourceStart = 0
  while (
    sourceStart < units.length
    && units[sourceStart]?.mandatory
    && units[sourceStart]?.groupId === null
  ) {
    sourceStart += 1
  }

  let sourceEnd = units.length
  for (let index = sourceStart; index < units.length; index += 1) {
    const unit = units[index]
    if (!unit) continue
    if (protectedGroups.has(contextGroupKey(unit))) {
      sourceEnd = index
      break
    }
  }
  const leadingUnits = [...units.slice(0, sourceStart)]
  const sourceUnits = [...units.slice(sourceStart, sourceEnd)]
  const preservedUnits = [...units.slice(sourceEnd)]
  const sourceEntryIds = sourceUnits.flatMap(unit => unit.sourceEntryIds)
  return {
    leadingUnits,
    sourceUnits,
    preservedUnits,
    sourceDigest: sourceUnits.length ? contextUnitSourceDigest(sourceUnits) : null,
    sourceEntryIds,
  }
}

export function dropOldestCompactableTranscriptGroup(
  entries: readonly TranscriptEntry[],
  preserveRecentTurns: number,
): TranscriptEntry[] | null {
  const units = buildTranscriptContextUnits(entries, { protectCompactionSummary: true })
  const protectedGroups = protectedContextGroups(units, preserveRecentTurns)
  const removable = units.find(unit => !protectedGroups.has(contextGroupKey(unit)))
  if (!removable) return null
  const removeKey = contextGroupKey(removable)
  return units
    .filter(unit => contextGroupKey(unit) !== removeKey)
    .flatMap(unit => unit.items)
}

export function flattenContextUnits<T>(units: readonly ContextUnit<T>[]): T[] {
  return units.flatMap(unit => unit.items)
}

export function contextUnitSourceDigest<T>(units: readonly ContextUnit<T>[]): string {
  return sha256(stableJson(units.map(unit => ({
    unitId: unit.unitId,
    sourceEntryIds: unit.sourceEntryIds,
    objectHash: unit.objectHash,
    groupId: unit.groupId,
  }))))
}

function materializeUnit<T>(draft: ContextUnitDraft<T>): ContextUnit<T> {
  const objectHash = sha256(stableJson(draft.projectedItems))
  const unitId = `context_unit_${sha256(stableJson({
    kind: draft.kind,
    sourceEntryIds: draft.sourceIds,
    groupId: draft.groupId,
    objectHash,
  })).slice(0, 32)}`
  return {
    unitId,
    kind: draft.kind,
    sourceEntryIds: [...draft.sourceIds],
    estimatedTokens: estimateTextTokens(stableJson(draft.projectedItems)),
    mandatory: draft.mandatory,
    groupId: draft.groupId,
    objectHash,
    items: [...draft.items],
    complete: draft.complete,
  }
}

function protectedContextGroups<T>(
  units: readonly ContextUnit<T>[],
  preserveRecentTurns: number,
): Set<string> {
  const protectedGroups = new Set<string>()
  for (const unit of units) {
    if (unit.mandatory || !unit.complete) protectedGroups.add(contextGroupKey(unit))
  }
  const userGroups = units
    .filter(unit => unit.kind === 'user_message')
    .map(contextGroupKey)
  const keepCount = Math.max(1, Math.floor(preserveRecentTurns))
  for (const group of userGroups.slice(-keepCount)) protectedGroups.add(group)
  return protectedGroups
}

function contextGroupKey<T>(unit: ContextUnit<T>): string {
  return unit.groupId ?? unit.unitId
}

function responseUnitKind(items: readonly AgentInputItem[]): ContextUnitKind {
  if (items.some(item => item.type === 'compaction')) return 'compaction_summary'
  if (items.some(isApprovalProtocolItem)) return 'approval_exchange'
  return items.some(isAgentProtocolItem) ? 'tool_exchange' : 'assistant_message'
}

function transcriptResponseUnitKind(entries: readonly TranscriptEntry[]): ContextUnitKind {
  if (entries.some(entry => (
    entry.kind === 'checkpoint'
    && typeof entry.payload.type === 'string'
    && entry.payload.type.includes('approval')
  ))) return 'approval_exchange'
  return entries.some(entry => entry.kind === 'tool_call' || entry.kind === 'tool_result')
    ? 'tool_exchange'
    : 'assistant_message'
}

function correlateAgentProtocol(items: readonly AgentInputItem[]): ProtocolCorrelation {
  const calls = new Set<string>()
  const results = new Set<string>()
  let hasProtocolItem = false
  for (const item of items) {
    const role = agentProtocolRole(item)
    if (!role) continue
    hasProtocolItem = true
    if (role.type === 'call') calls.add(role.callId)
    else results.add(role.callId)
  }
  return { calls, results, hasProtocolItem }
}

function correlateTranscriptProtocol(entries: readonly TranscriptEntry[]): ProtocolCorrelation {
  const calls = new Set<string>()
  const results = new Set<string>()
  let hasProtocolItem = false
  for (const entry of entries) {
    if (entry.kind !== 'tool_call' && entry.kind !== 'tool_result') continue
    const callId = stringField(entry.payload.callId)
    if (!callId) continue
    hasProtocolItem = true
    if (entry.kind === 'tool_call') calls.add(callId)
    else results.add(callId)
  }
  return { calls, results, hasProtocolItem }
}

function protocolCorrelationComplete(correlation: ProtocolCorrelation): boolean {
  if (!correlation.hasProtocolItem) return true
  if (correlation.calls.size !== correlation.results.size) return false
  for (const callId of correlation.calls) {
    if (!correlation.results.has(callId)) return false
  }
  return true
}

function agentProtocolRole(
  item: AgentInputItem,
): { type: 'call' | 'result'; callId: string } | null {
  if (!('callId' in item) || typeof item.callId !== 'string' || !item.callId) return null
  if (AGENT_CALL_ITEM_TYPES.has(item.type)) return { type: 'call', callId: item.callId }
  if (AGENT_RESULT_ITEM_TYPES.has(item.type)) return { type: 'result', callId: item.callId }
  return null
}

const AGENT_CALL_ITEM_TYPES = new Set([
  'program',
  'function_call',
  'tool_search_call',
  'computer_call',
  'shell_call',
  'apply_patch_call',
])

const AGENT_RESULT_ITEM_TYPES = new Set([
  'program_output',
  'function_call_result',
  'tool_search_output',
  'computer_call_result',
  'shell_call_output',
  'apply_patch_call_output',
])

function isAgentProtocolItem(item: AgentInputItem): boolean {
  return (typeof item.type === 'string' && AGENT_CALL_ITEM_TYPES.has(item.type))
    || (typeof item.type === 'string' && AGENT_RESULT_ITEM_TYPES.has(item.type))
    || item.type === 'hosted_tool_call'
}

function isApprovalProtocolItem(item: AgentInputItem): boolean {
  if (!('providerData' in item) || !isRecord(item.providerData)) return false
  return typeof item.providerData.approval_request_id === 'string'
    || typeof item.providerData.approvalRequestId === 'string'
}

function isSystemMessage(
  item: AgentInputItem,
): item is AgentInputItem & { role: 'system'; content: unknown } {
  return 'role' in item && item.role === 'system'
}

function isUserMessage(
  item: AgentInputItem,
): item is AgentInputItem & { role: 'user'; content: unknown } {
  return 'role' in item && item.role === 'user'
}

function isAssistantMessage(
  item: AgentInputItem,
): item is AgentInputItem & { role: 'assistant'; content: unknown } {
  return 'role' in item && item.role === 'assistant'
}

function taggedSystemKind(item: AgentInputItem & { content: unknown }): ContextUnitKind {
  const text = typeof item.content === 'string' ? item.content : stableJson(item.content)
  if (text.includes('<run-history-summary') || text.includes('<conversation-summary')) {
    return 'compaction_summary'
  }
  if (text.includes('<geo-world-baseline') || text.includes('<geo-world-diff')) return 'world_diff'
  if (text.includes('<thread-memory')) return 'memory'
  if (text.includes('<thread-resources')) return 'resource'
  return 'system'
}

function objectiveInputSequence(item: AgentInputItem): number | null {
  if (!('providerData' in item) || !isRecord(item.providerData)) return null
  const marker = item.providerData.geoAgentRunInput
  if (!isRecord(marker)) return null
  return typeof marker.inputSequence === 'number' && Number.isInteger(marker.inputSequence)
    ? marker.inputSequence
    : null
}

function agentItemSourceId(item: AgentInputItem): string {
  if ('id' in item && typeof item.id === 'string' && item.id) return item.id
  if ('callId' in item && typeof item.callId === 'string' && item.callId) {
    return `${item.type}:${item.callId}`
  }
  const sequence = objectiveInputSequence(item)
  if (sequence !== null) return `objective_input:${sequence}`
  return `agent_item:${sha256(stableJson(item)).slice(0, 32)}`
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  )
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

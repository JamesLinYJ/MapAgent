// +-------------------------------------------------------------------------
//
//   地理智能平台 - ConversationItem 跨端展示投影
//
//   文件:       presentation.ts
//
//   日期:       2026年06月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-07-27):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 从 Web 展示层抽取为浏览器与本机 Agent CLI 共用的纯投影边界。
// --------------------------------------------------------------------------

import type { ConversationItem, ToolDescriptor } from '@geo-agent-platform/shared-types'
import { sameConversationItemVersion } from './projection.js'

export type LedgerEntryStatus = 'idle' | 'running' | 'completed' | 'failed' | 'blocked'
export type ConversationEntryKind = 'message' | 'command_batch' | 'approval' | 'artifact' | 'error' | 'system'

export interface ConversationCommand {
  id: string
  title: string
  status: LedgerEntryStatus
  body: string
  commandText?: string | null
  toolName?: string | null
  displayIdentifier?: string | null
  details?: Record<string, unknown> | null
}

export interface ConversationEntry {
  id: string
  kind: ConversationEntryKind
  timestamp: string
  title: string
  body: string
  status: LedgerEntryStatus
  role?: 'user' | 'assistant'
  badge?: string | null
  note?: string | null
  commands?: ConversationCommand[]
  artifactId?: string | null
  approvalId?: string | null
  recoveryNote?: string | null
  details?: Record<string, unknown> | null
}

type ConversationPresentationListener = () => void

export interface ConversationPresentationStats {
  entryUpdates: number
  materializations: number
}

/**
 * ConversationItem 到展示条目的增量投影。
 *
 * 正文增量只重算对应消息，工具调用或结果只重算同 callId 条目；
 * 未变的 ConversationEntry 保留对象身份，让虚拟列表不重新渲染历史正文。
 */
export class ConversationPresentationIndex {
  private itemsById = new Map<string, ConversationItem>()
  private orderedIds: string[] = []
  private toolLabels = new Map<string, string>()
  private readonly entriesById = new Map<string, ConversationEntry>()
  private readonly listeners = new Set<ConversationPresentationListener>()
  private snapshot: ConversationEntry[] = []
  private readonly stats: ConversationPresentationStats = {
    entryUpdates: 0,
    materializations: 0,
  }

  constructor(
    items: ReadonlyArray<ConversationItem> = [],
    tools: ReadonlyArray<ToolDescriptor> = [],
  ) {
    this.replaceItems(items, tools)
  }

  getSnapshot = (): ConversationEntry[] => this.snapshot

  subscribe = (listener: ConversationPresentationListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getStats(): ConversationPresentationStats {
    return { ...this.stats }
  }

  replaceItems(
    items: ReadonlyArray<ConversationItem>,
    tools: ReadonlyArray<ToolDescriptor> = [],
  ): void {
    const stableItems = items.map(item => {
      const previous = this.itemsById.get(item.itemId)
      return previous && sameConversationItemVersion(previous, item) ? previous : item
    })
    const nextItemsById = new Map(stableItems.map(item => [item.itemId, item]))
    const nextToolLabels = new Map(tools.map(tool => [tool.name, tool.label]))
    const affectedEntries = new Set<string>()

    for (const [itemId, previous] of this.itemsById) {
      const next = nextItemsById.get(itemId)
      if (next === previous) continue
      affectedEntries.add(presentationEntryId(previous))
      if (next) affectedEntries.add(presentationEntryId(next))
    }
    for (const item of stableItems) {
      if (this.itemsById.has(item.itemId)) continue
      affectedEntries.add(presentationEntryId(item))
    }
    if (!sameStringMap(this.toolLabels, nextToolLabels)) {
      for (const item of stableItems) {
        if (isToolItem(item)) affectedEntries.add(presentationEntryId(item))
      }
    }

    this.itemsById = nextItemsById
    this.orderedIds = stableItems.map(item => item.itemId)
    this.toolLabels = nextToolLabels

    for (const entryId of affectedEntries) {
      if (entryId.startsWith('tool:')) {
        this.rebuildToolEntry(entryId.slice('tool:'.length))
      } else {
        this.rebuildStandaloneEntry(entryId, tools)
      }
    }

    const seen = new Set<string>()
    const nextSnapshot: ConversationEntry[] = []
    for (const itemId of this.orderedIds) {
      const item = this.itemsById.get(itemId)
      if (!item) continue
      const entryId = presentationEntryId(item)
      if (seen.has(entryId)) continue
      seen.add(entryId)
      const entry = this.entriesById.get(entryId)
      if (entry) nextSnapshot.push(entry)
    }
    if (sameEntrySnapshot(this.snapshot, nextSnapshot)) return
    this.snapshot = nextSnapshot
    this.stats.materializations += 1
    for (const listener of this.listeners) listener()
  }

  private rebuildStandaloneEntry(itemId: string, tools: ReadonlyArray<ToolDescriptor>): void {
    const item = this.itemsById.get(itemId)
    const entry = item && !isToolItem(item)
      ? deriveEntriesFromItems([item], undefined, tools)[0]
      : undefined
    if (entry) this.entriesById.set(itemId, entry)
    else this.entriesById.delete(itemId)
    this.stats.entryUpdates += 1
  }

  private rebuildToolEntry(callId: string): void {
    let call: ConversationItem | undefined
    let output: ConversationItem | undefined
    for (const itemId of this.orderedIds) {
      const item = this.itemsById.get(itemId)
      if (!item || item.callId !== callId) continue
      if (item.itemType === 'function_call') call = item
      else if (item.itemType === 'function_call_output') output = item
    }
    const entryId = `tool:${callId}`
    if (call || output) this.entriesById.set(entryId, buildToolEntry(call, output, this.toolLabels))
    else this.entriesById.delete(entryId)
    this.stats.entryUpdates += 1
  }
}

/**
 * ConversationItem 是两种聊天界面的唯一输入。这里负责消息分类、工具配对、
 * 用户可见名称与结果摘要；DOM 与终端只能决定布局和最终 Markdown 样式。
 */
export function deriveEntriesFromItems(
  items: ReadonlyArray<ConversationItem>,
  _runStatus?: string,
  tools: ReadonlyArray<ToolDescriptor> = [],
): ConversationEntry[] {
  const toolLabels = new Map(tools.map(tool => [tool.name, tool.label]))
  const entries: ConversationEntry[] = []
  const toolCalls = new Map<string, ConversationItem>()
  const toolOutputs = new Map<string, ConversationItem>()

  for (const item of items) {
    if (item.itemType === 'function_call' && item.callId) toolCalls.set(item.callId, item)
    if (item.itemType === 'function_call_output' && item.callId) toolOutputs.set(item.callId, item)
  }

  for (const item of items) {
    if (item.itemType === 'message') {
      const body = itemText(item).trim()
      if (!body) continue
      const isAssistantCommentary = item.role === 'assistant' && item.metadata.messageKind === 'commentary'
      entries.push({
        id: item.itemId,
        kind: 'message',
        role: item.role === 'user' ? 'user' : 'assistant',
        timestamp: item.timestamp,
        title: item.role === 'user' ? '用户' : isAssistantCommentary ? '过程说明' : '回答',
        body,
        status: itemStatus(item),
        badge: isAssistantCommentary ? 'commentary' : null,
        details: item.metadata,
      })
      continue
    }

    if (item.itemType === 'reasoning') {
      const body = itemText(item)
      if (!body) continue
      entries.push({
        id: item.itemId,
        kind: 'message',
        role: 'assistant',
        timestamp: item.timestamp,
        title: '思考',
        body,
        status: itemStatus(item),
        badge: 'thinking',
      })
      continue
    }

    if (item.itemType === 'function_call') {
      if (!item.callId) continue
      upsertToolEntry(entries, buildToolEntry(item, toolOutputs.get(item.callId), toolLabels))
      continue
    }

    if (item.itemType === 'function_call_output') {
      if (!item.callId) continue
      upsertToolEntry(entries, buildToolEntry(toolCalls.get(item.callId), item, toolLabels))
      continue
    }

    if (item.itemType === 'error') {
      entries.push({
        id: item.itemId,
        kind: 'error',
        timestamp: item.timestamp,
        title: '运行出错',
        body: itemText(item) || '运行失败。',
        status: 'failed',
        details: item.metadata,
      })
      continue
    }

    if (item.itemType === 'result') {
      const terminalEntry = buildTerminalEntry(item)
      if (terminalEntry) entries.push(terminalEntry)
    }
  }

  return entries
}

function presentationEntryId(item: ConversationItem): string {
  return isToolItem(item) && item.callId ? `tool:${item.callId}` : item.itemId
}

function isToolItem(item: ConversationItem): boolean {
  return item.itemType === 'function_call' || item.itemType === 'function_call_output'
}

function sameStringMap(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) return false
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false
  }
  return true
}

function sameEntrySnapshot(
  left: ReadonlyArray<ConversationEntry>,
  right: ReadonlyArray<ConversationEntry>,
): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

export function pickConversationHeadline(items: ReadonlyArray<ConversationItem>, runStatus?: string): {
  title: string
  body: string
} {
  const entries = deriveEntriesFromItems(items, runStatus)
  const latest = [...entries].reverse()
    .find(entry => entry.kind === 'message' || entry.kind === 'command_batch' || entry.kind === 'error')
  if (!latest) {
    return {
      title: runStatus === 'running' ? '运行中' : '等待输入',
      body: runStatus === 'running' ? 'Agent 正在准备消息流。' : '提交问题后开始分析。',
    }
  }
  return { title: latest.title, body: latest.body || latest.commands?.at(-1)?.body || '' }
}

function buildToolEntry(
  call: ConversationItem | undefined,
  output: ConversationItem | undefined,
  toolLabels: ReadonlyMap<string, string>,
): ConversationEntry {
  const sourceItem = output ?? call
  if (!sourceItem) throw new Error('工具展示投影缺少调用或输出事实。')
  const callId = output?.callId ?? call?.callId
  if (!callId) throw new Error('工具展示投影缺少 callId。')
  const toolName = call?.name ?? output?.name ?? 'unknown_tool'
  const persistedLabel = toolDisplayLabel(call?.metadata) ?? toolDisplayLabel(output?.metadata)
  const registeredLabel = toolLabels.get(toolName)
  const title = persistedLabel ?? registeredLabel ?? '工具调用'
  const args = safeJsonParse(call?.arguments ?? '')
  const outputText = output?.output ?? output?.body ?? ''
  const status = output ? itemStatus(output) : itemStatus(call)
  const outputParse = parseJsonOutput(outputText)
  const parsedOutput = outputParse.ok ? outputParse.value : {}
  const body = output
    ? readableToolOutput(toolName, outputParse, outputText, Boolean(output.isError))
    : status === 'failed'
      ? itemText(call) || '工具执行失败，未返回结果。'
      : '执行中，等待工具返回...'
  const metadata = output?.metadata ?? call?.metadata ?? {}
  const artifacts = Array.isArray(metadata.artifacts) ? metadata.artifacts.filter(isRecord) : []
  const artifactId = typeof metadata.artifactId === 'string'
    ? metadata.artifactId
    : typeof artifacts[0]?.artifactId === 'string' ? artifacts[0].artifactId : null
  const displayIdentifier = registeredLabel ? toolName : null

  return {
    id: `tool:${callId}`,
    kind: 'command_batch',
    timestamp: sourceItem.timestamp,
    title,
    body,
    status,
    commands: [{
      id: callId,
      title,
      status,
      body,
      toolName,
      displayIdentifier,
      commandText: call?.arguments ?? '',
      details: {
        args,
        result: parsedOutput,
        resultId: metadata.resultId ?? null,
        source: metadata.source ?? null,
        artifactId,
        artifacts,
        valueRefs: metadata.valueRefs ?? [],
      },
    }],
    artifactId,
    details: metadata,
  }
}

function toolDisplayLabel(metadata: Record<string, unknown> | null | undefined): string | null {
  const label = metadata?.toolLabel
  return typeof label === 'string' && label.trim() ? label.trim() : null
}

function buildTerminalEntry(item: ConversationItem): ConversationEntry | undefined {
  const resultType = String(item.metadata.resultType ?? '')
  if (!resultType || resultType === 'success' || resultType === 'completed') return undefined
  if (resultType === 'waiting_approval') return buildApprovalEntry(item)
  const isFailure = resultType === 'failed'
  const body = itemText(item) || (isFailure ? terminalFailureMessage(item.metadata) : '运行已暂停，等待下一步。')
  return {
    id: item.itemId,
    kind: isFailure ? 'error' : 'system',
    timestamp: item.timestamp,
    title: formatResultTitle(resultType, item.metadata),
    body,
    status: isFailure ? 'failed' : 'blocked',
    details: item.metadata,
  }
}

function buildApprovalEntry(item: ConversationItem): ConversationEntry {
  const metadata = item.metadata
  const approvalId = typeof metadata.approvalId === 'string' && metadata.approvalId.trim()
    ? metadata.approvalId.trim()
    : null
  const title = typeof metadata.title === 'string' && metadata.title.trim()
    ? metadata.title.trim()
    : '需要你的确认'
  const description = typeof metadata.description === 'string' && metadata.description.trim()
    ? metadata.description.trim()
    : '本次运行暂停，等待你批准后继续。'
  return {
    id: item.itemId,
    kind: 'approval',
    timestamp: item.timestamp,
    title,
    body: description,
    status: 'blocked',
    approvalId,
    details: metadata,
  }
}

function nowcastAnswerText(toolName: string, output: unknown): string {
  if (toolName !== 'answer_nowcast_question' || !isRecord(output)) return ''
  const directAnswer = firstString(output.answer)
  if (directAnswer) return directAnswer
  const payload = isRecord(output.payload) ? output.payload : null
  return payload ? firstString(payload.answer) : ''
}

interface JsonParseResult {
  ok: boolean
  value: unknown
}

function readableToolOutput(toolName: string, outputParse: JsonParseResult, rawOutput: string, isError: boolean): string {
  const textOutput = rawOutput.trim()
  if (!outputParse.ok) return textOutput || (isError ? '工具执行失败。' : '工具执行完成。')

  const parsedOutput = outputParse.value
  const nowcastAnswer = nowcastAnswerText(toolName, parsedOutput)
  if (nowcastAnswer) return nowcastAnswer
  if (typeof parsedOutput === 'string' && parsedOutput.trim()) return parsedOutput.trim()
  if (!isRecord(parsedOutput)) return isError ? '工具执行失败。' : '工具执行完成。'

  const payload = isRecord(parsedOutput.payload) ? parsedOutput.payload : null
  const payloadText = payload
    ? firstString(payload.answer, payload.summary, payload.text, payload.forecastText)
    : ''
  if (payloadText) return payloadText

  const directText = firstString(parsedOutput.answer, parsedOutput.summary, parsedOutput.text)
  if (directText) return directText
  if (isError) return firstString(parsedOutput.error, parsedOutput.detail) || '工具执行失败。'

  const artifacts = Array.isArray(parsedOutput.artifacts) ? parsedOutput.artifacts : []
  if (artifacts.length > 0) return `工具执行完成，生成了 ${artifacts.length} 个结果。`
  return '工具执行完成。'
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function terminalFailureMessage(metadata: Record<string, unknown>): string {
  const message = typeof metadata.message === 'string' ? metadata.message.trim() : ''
  const firstError = Array.isArray(metadata.errors)
    ? metadata.errors.find((error): error is string => typeof error === 'string' && Boolean(error.trim()))?.trim() ?? ''
    : ''
  const detail = message || firstError
  if (!detail) return '运行失败，服务端没有提供具体原因。'
  if (detail.toLowerCase() === 'terminated') {
    return '模型连接被上游中断。请重新提交；若持续发生，请检查模型服务与网络连接。'
  }
  return detail
}

function upsertToolEntry(entries: ConversationEntry[], entry: ConversationEntry): void {
  const index = entries.findIndex(candidate => candidate.id === entry.id)
  if (index >= 0) entries[index] = entry
  else entries.push(entry)
}

function itemText(item: ConversationItem | undefined): string {
  return item?.body ?? item?.output ?? ''
}

function itemStatus(item?: ConversationItem): LedgerEntryStatus {
  if (!item) return 'running'
  if (item.isError || item.status === 'failed') return 'failed'
  if (item.status === 'blocked') return 'blocked'
  if (item.status === 'running') return 'running'
  return 'completed'
}

function formatResultTitle(resultType: string, metadata?: Record<string, unknown>): string {
  if (resultType === 'failed') return failureTitle(metadata?.failure)
  if (resultType === 'waiting_approval') return '等待审批'
  if (resultType === 'waiting_clarification' || resultType === 'clarification_needed') return '需要澄清'
  if (resultType === 'cancelled') return '已中断'
  return '运行状态'
}

function failureTitle(value: unknown): string {
  if (!isRecord(value)) return '运行出错'
  return ({
    model: '模型调用失败',
    tool: '工具执行失败',
    data: '数据条件不满足',
    database: '数据库处理失败',
    transport: '连接与传输失败',
    platform: '平台运行失败',
  } as Record<string, string>)[String(value.source)] ?? '运行出错'
}

function safeJsonParse(value: string): unknown {
  if (!value.trim()) return {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function parseJsonOutput(value: string): JsonParseResult {
  if (!value.trim()) return { ok: false, value: {} }
  try {
    return { ok: true, value: JSON.parse(value) }
  } catch {
    return { ok: false, value: {} }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 终端时间线投影
//
//   文件:       localAgentTimeline.ts
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5
// --------------------------------------------------------------------------

import {
  ConversationPresentationIndex,
  type ConversationEntry,
} from '@geo-agent-platform/conversation-presentation'
import type { ConversationItem, ToolDescriptor } from '@geo-agent-platform/shared-types'

import {
  buildConversationEntryLines,
  type AgentDisplayLine,
} from './localAgentView.js'

export interface LocalAgentTimelineStats {
  entryLayouts: number
  presentationUpdates: number
}

/**
 * 共享增量投影保留未变条目身份，本类再以条目身份、终端宽度和
 * 工具展开状态缓存最终物理行，流式正文不再重排全部历史。
 */
export class LocalAgentTimelineProjection {
  private readonly presentation: ConversationPresentationIndex
  private readonly lineCache = new WeakMap<ConversationEntry, Map<string, AgentDisplayLine[]>>()
  private entryLayouts = 0

  constructor(
    items: readonly ConversationItem[] = [],
    tools: readonly ToolDescriptor[] = [],
  ) {
    this.presentation = new ConversationPresentationIndex(items, tools)
  }

  replaceItems(items: readonly ConversationItem[], tools: readonly ToolDescriptor[]): void {
    this.presentation.replaceItems(items, tools)
  }

  getToolIds(): string[] {
    return this.presentation.getSnapshot()
      .filter(entry => entry.kind === 'command_batch')
      .map(entry => entry.id)
  }

  getLines(width: number, expandedToolIds: ReadonlySet<string>): AgentDisplayLine[] {
    const lines: AgentDisplayLine[] = []
    for (const entry of this.presentation.getSnapshot()) {
      if (lines.length && entry.kind !== 'command_batch') {
        lines.push({ key: `${entry.id}:space`, text: '', tone: 'muted' })
      }
      lines.push(...this.linesForEntry(entry, width, expandedToolIds.has(entry.id)))
    }
    if (!lines.length) {
      return [{
        key: 'empty',
        text: '输入自然语言问题开始分析；Agent 会在需要时请求澄清或审批。',
        tone: 'muted',
      }]
    }
    return lines
  }

  getStats(): LocalAgentTimelineStats {
    return {
      entryLayouts: this.entryLayouts,
      presentationUpdates: this.presentation.getStats().entryUpdates,
    }
  }

  private linesForEntry(
    entry: ConversationEntry,
    width: number,
    expanded: boolean,
  ): AgentDisplayLine[] {
    const cacheKey = `${Math.max(16, width)}:${expanded ? 'expanded' : 'collapsed'}`
    const cachedByLayout = this.lineCache.get(entry)
    const cached = cachedByLayout?.get(cacheKey)
    if (cached) return cached
    const expandedEntries = expanded ? new Set([entry.id]) : new Set<string>()
    const rendered = buildConversationEntryLines([entry], width, expandedEntries)
    const nextCache = cachedByLayout ?? new Map<string, AgentDisplayLine[]>()
    nextCache.set(cacheKey, rendered)
    this.lineCache.set(entry, nextCache)
    this.entryLayouts += 1
    return rendered
  }
}

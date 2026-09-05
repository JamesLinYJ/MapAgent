// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 对话终端投影
//
//   文件:       localAgentView.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  type ConversationCommand,
  type ConversationEntry,
} from '@geo-agent-platform/conversation-presentation'
import type { ConversationItem, RunStatus } from '@geo-agent-platform/shared-types'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

import {
  renderTerminalMarkdown,
  renderTerminalPlainText,
  terminalPlainLine,
  type TerminalMarkdownLine,
} from './terminalMarkdown.js'

export type AgentLineTone =
  | 'text'
  | 'muted'
  | 'focus'
  | 'info'
  | 'accent'
  | 'reasoning'
  | 'healthy'
  | 'warning'
  | 'danger'

export interface AgentDisplayLine {
  key: string
  text: string
  rendered?: string
  tone: AgentLineTone
  bold?: boolean
  user?: boolean
  toolId?: string
  toolHeader?: boolean
}

export interface AgentRunPresentation {
  symbol: string
  label: string
  tone: AgentLineTone
}

/** 终端只渲染共享展示投影；增量索引可以按条目调用并缓存本函数的结果。 */
export function buildConversationEntryLines(
  entries: readonly ConversationEntry[],
  width: number,
  expandedToolIds: ReadonlySet<string> = new Set(),
): AgentDisplayLine[] {
  const safeWidth = Math.max(16, width)
  const lines: AgentDisplayLine[] = []

  for (const entry of entries) {
    if (entry.kind === 'message') {
      appendMessageEntry(lines, entry, safeWidth)
      continue
    }
    if (entry.kind === 'command_batch') {
      appendToolEntry(lines, entry, safeWidth, expandedToolIds.has(entry.id))
      continue
    }
    if (entry.kind === 'approval') {
      appendEntry(lines, {
        key: entry.id,
        title: `! ${entry.title || '需要你的确认'}`,
        bodyLines: renderTerminalMarkdown(entry.body, safeWidth - 2),
        titleTone: 'warning',
        bodyTone: 'text',
      })
      continue
    }
    if (entry.kind === 'error') {
      appendEntry(lines, {
        key: entry.id,
        title: `✕ ${entry.title || '运行出错'}`,
        bodyLines: renderTerminalMarkdown(entry.body || '服务端没有返回具体原因。', safeWidth - 2),
        titleTone: 'danger',
        bodyTone: 'danger',
      })
      continue
    }
    if (entry.kind === 'system') {
      appendEntry(lines, {
        key: entry.id,
        title: `◆ ${entry.title || '需要操作'}`,
        bodyLines: renderTerminalMarkdown(entry.body, safeWidth - 2),
        titleTone: 'warning',
        bodyTone: 'text',
      })
    }
  }

  if (!lines.length) {
    lines.push({
      key: 'empty',
      text: '输入自然语言问题开始分析；Agent 会在需要时请求澄清或审批。',
      tone: 'muted',
    })
  }
  return lines
}

export function runPresentation(status: RunStatus | null | undefined): AgentRunPresentation {
  if (!status) return { symbol: '○', label: '等待输入', tone: 'muted' }
  const presentations: Record<RunStatus, AgentRunPresentation> = {
    queued: { symbol: '◌', label: '排队中', tone: 'muted' },
    running: { symbol: '◐', label: '正在运行', tone: 'warning' },
    clarification_needed: { symbol: '?', label: '等待澄清', tone: 'warning' },
    waiting_approval: { symbol: '!', label: '等待批准', tone: 'warning' },
    completed: { symbol: '✓', label: '已完成', tone: 'healthy' },
    failed: { symbol: '✕', label: '失败', tone: 'danger' },
    cancelled: { symbol: '○', label: '已取消', tone: 'muted' },
    interrupted: { symbol: '▲', label: '已中断，可恢复', tone: 'warning' },
    requires_action: { symbol: '◆', label: '需要操作', tone: 'warning' },
  }
  return presentations[status]
}

export function latestAssistantAnswer(items: ConversationItem[]): string {
  return [...items].reverse()
    .find(item => item.itemType === 'message'
      && item.role === 'assistant'
      && item.metadata.messageKind !== 'commentary'
      && Boolean(item.body?.trim()))?.body?.trim() ?? ''
}

function appendMessageEntry(
  lines: AgentDisplayLine[],
  entry: ConversationEntry,
  width: number,
): void {
  const user = entry.role === 'user'
  const reasoning = entry.badge === 'thinking'
  const commentary = entry.badge === 'commentary'
  const title = user
    ? '▌ 你'
    : reasoning
      ? entry.status === 'running' ? '◈ 正在思考' : '◇ 思考过程'
      : commentary
        ? '· 过程说明'
        : `◆ ${PRODUCT_CODENAME} 结论`
  const titleTone: AgentLineTone = user
    ? 'info'
    : reasoning || commentary
      ? reasoning ? 'reasoning' : 'accent'
      : 'focus'
  const bodyTone: AgentLineTone = user
    ? 'text'
    : reasoning ? 'reasoning'
      : commentary ? 'muted'
        : 'text'
  const bodyLines = user
    ? renderTerminalPlainText(entry.body, width - 2)
    : renderTerminalMarkdown(entry.body, width - 2)

  appendEntry(lines, {
    key: entry.id,
    title,
    bodyLines,
    titleTone,
    bodyTone,
    user,
  })
}

function appendToolEntry(
  lines: AgentDisplayLine[],
  entry: ConversationEntry,
  width: number,
  expanded: boolean,
): void {
  const commands = entry.commands ?? []
  for (const [index, command] of commands.entries()) {
    const status = toolStatusPresentation(command)
    const identifier = command.displayIdentifier ? ` [${command.displayIdentifier}]` : ''
    const title = `${status.symbol} ${status.label} · ${command.title || '工具调用'}${identifier}`
    const bodyLines: TerminalMarkdownLine[] = []
    const showDetails = expanded || command.status === 'failed' || command.status === 'blocked'
    if (showDetails) {
      const input = summarizeArguments(command.commandText)
      if (input) {
        bodyLines.push(...prefixLines(
          renderTerminalPlainText(input, width - 8),
          '输入  ',
          '      ',
        ))
      }
      const output = command.body.trim()
      if (output) {
        bodyLines.push(...prefixLines(
          renderTerminalPlainText(output, width - 8),
          '输出  ',
          '      ',
        ))
      }
    }

    appendEntry(lines, {
      key: `${entry.id}:${command.id}:${index}`,
      title,
      bodyLines,
      titleTone: status.tone,
      bodyTone: command.status === 'failed' ? 'danger' : 'muted',
      compact: true,
      toolId: entry.id,
    })
  }
}

function toolStatusPresentation(command: ConversationCommand): {
  symbol: string
  label: string
  tone: AgentLineTone
} {
  if (command.status === 'running') return { symbol: '↳', label: '正在调用工具', tone: 'warning' }
  if (command.status === 'failed') return { symbol: '✕', label: '工具调用失败', tone: 'danger' }
  if (command.status === 'blocked') return { symbol: '!', label: '工具等待批准', tone: 'warning' }
  return { symbol: '✓', label: '已调用工具', tone: 'healthy' }
}

function prefixLines(
  lines: readonly TerminalMarkdownLine[],
  firstPrefix: string,
  continuationPrefix: string,
): TerminalMarkdownLine[] {
  return lines.map((line, index) => {
    const prefix = index === 0 ? firstPrefix : continuationPrefix
    return {
      text: `${prefix}${line.text}`,
      rendered: `${prefix}${line.rendered}`,
    }
  })
}

function appendEntry(
  lines: AgentDisplayLine[],
  input: {
    key: string
    title: string
    bodyLines: readonly TerminalMarkdownLine[]
    titleTone: AgentLineTone
    bodyTone: AgentLineTone
    user?: boolean
    compact?: boolean
    toolId?: string
  },
): void {
  if (lines.length && !input.compact) {
    lines.push({ key: `${input.key}:space`, text: '', tone: 'muted' })
  }
  const titleLine = terminalPlainLine(input.title)
  lines.push({
    key: `${input.key}:title`,
    text: titleLine.text,
    rendered: titleLine.rendered,
    tone: input.titleTone,
    bold: true,
    ...(input.user ? { user: true } : {}),
    ...(input.toolId ? { toolId: input.toolId, toolHeader: true } : {}),
  })
  for (const [index, line] of input.bodyLines.entries()) {
    lines.push({
      key: `${input.key}:body:${index}`,
      text: `  ${line.text}`,
      rendered: `  ${line.rendered}`,
      tone: input.bodyTone,
      ...(input.user ? { user: true } : {}),
      ...(input.toolId ? { toolId: input.toolId } : {}),
    })
  }
}

function summarizeArguments(value: string | null | undefined): string {
  if (!value?.trim()) return ''
  const compact = value.replace(/\s+/gu, ' ').trim()
  return compact.length > 320 ? `${compact.slice(0, 317)}…` : compact
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 终端编辑器状态
//
//   文件:       localAgentEditor.ts
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5
// --------------------------------------------------------------------------

import { stripVTControlCharacters } from 'node:util'

import stringWidth from 'string-width'

export interface AgentInputEdit {
  value: string
  /** 光标是 grapheme 边界索引，不是 UTF-16 或 code point 索引。 */
  cursorIndex: number
}

export interface AgentInputHistoryState {
  index: number | null
  draft: string
}

export interface AgentInputViewport {
  before: string
  cursor: string
  after: string
  visibleRows: number
  clippedBefore: boolean
  clippedAfter: boolean
}

interface VisualRow {
  start: number
  end: number
}

const graphemeSegmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })

export function agentInputGraphemes(value: string): string[] {
  return [...graphemeSegmenter.segment(value)].map(part => part.segment)
}

export function agentInputLength(value: string): number {
  return agentInputGraphemes(value).length
}

/** 粘贴是原始终端输入；进入编辑器前统一清除控制序列并固定 Tab 宽度。 */
export function normalizeAgentPaste(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\u0000/gu, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\t/gu, '    ')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
}

export function insertAgentInput(
  current: AgentInputEdit,
  insertion: string,
  maximum: number,
): AgentInputEdit {
  const value = agentInputGraphemes(current.value)
  const inserted = agentInputGraphemes(insertion)
  const available = Math.max(0, maximum - value.length)
  const accepted = inserted.slice(0, available)
  const cursorIndex = clampCursor(current.cursorIndex, value.length)
  value.splice(cursorIndex, 0, ...accepted)
  return { value: value.join(''), cursorIndex: cursorIndex + accepted.length }
}

export function removeAgentInputBefore(current: AgentInputEdit): AgentInputEdit {
  const value = agentInputGraphemes(current.value)
  const cursorIndex = clampCursor(current.cursorIndex, value.length)
  if (cursorIndex > 0) value.splice(cursorIndex - 1, 1)
  return { value: value.join(''), cursorIndex: Math.max(0, cursorIndex - 1) }
}

export function removeAgentInputAt(current: AgentInputEdit): AgentInputEdit {
  const value = agentInputGraphemes(current.value)
  const cursorIndex = clampCursor(current.cursorIndex, value.length)
  if (cursorIndex < value.length) value.splice(cursorIndex, 1)
  return { value: value.join(''), cursorIndex }
}

export function moveAgentInputHorizontal(
  current: AgentInputEdit,
  direction: -1 | 1,
): AgentInputEdit {
  const length = agentInputLength(current.value)
  return {
    ...current,
    cursorIndex: clampCursor(current.cursorIndex + direction, length),
  }
}

export function moveAgentInputToLineBoundary(
  current: AgentInputEdit,
  boundary: 'start' | 'end',
): AgentInputEdit {
  const value = agentInputGraphemes(current.value)
  const cursorIndex = clampCursor(current.cursorIndex, value.length)
  if (boundary === 'start') {
    return { ...current, cursorIndex: value.lastIndexOf('\n', cursorIndex - 1) + 1 }
  }
  const next = value.indexOf('\n', cursorIndex)
  return { ...current, cursorIndex: next < 0 ? value.length : next }
}

/**
 * 按终端显示行上下移动光标。已在首/末行时返回 null，
 * 由调用方把该按键交给历史记录导航。
 */
export function moveAgentInputVertical(
  current: AgentInputEdit,
  direction: -1 | 1,
  width: number,
): AgentInputEdit | null {
  const graphemes = agentInputGraphemes(current.value)
  const rows = layoutVisualRows(graphemes, width)
  const cursorIndex = clampCursor(current.cursorIndex, graphemes.length)
  const currentRow = visualRowForCursor(rows, cursorIndex)
  const targetRowIndex = currentRow + direction
  const target = rows[targetRowIndex]
  const source = rows[currentRow]
  if (!target || !source) return null
  const column = displayWidth(graphemes.slice(source.start, cursorIndex))
  return {
    ...current,
    cursorIndex: cursorForColumn(graphemes, target, column),
  }
}

export function navigateAgentInputHistory(input: {
  edit: AgentInputEdit
  history: readonly string[]
  state: AgentInputHistoryState
  direction: -1 | 1
}): { edit: AgentInputEdit; state: AgentInputHistoryState } {
  if (!input.history.length) return { edit: input.edit, state: input.state }
  if (input.direction < 0) {
    const index = input.state.index === null
      ? input.history.length - 1
      : Math.max(0, input.state.index - 1)
    const value = input.history[index] ?? ''
    return {
      edit: { value, cursorIndex: agentInputLength(value) },
      state: {
        index,
        draft: input.state.index === null ? input.edit.value : input.state.draft,
      },
    }
  }
  if (input.state.index === null) return { edit: input.edit, state: input.state }
  const index = input.state.index + 1
  if (index >= input.history.length) {
    return {
      edit: {
        value: input.state.draft,
        cursorIndex: agentInputLength(input.state.draft),
      },
      state: { index: null, draft: '' },
    }
  }
  const value = input.history[index] ?? ''
  return {
    edit: { value, cursorIndex: agentInputLength(value) },
    state: { ...input.state, index },
  }
}

export function agentInputViewport(
  current: AgentInputEdit,
  width: number,
  maximumRows: number,
): AgentInputViewport {
  const graphemes = agentInputGraphemes(current.value)
  const rows = layoutVisualRows(graphemes, width)
  const cursorIndex = clampCursor(current.cursorIndex, graphemes.length)
  const cursorRow = visualRowForCursor(rows, cursorIndex)
  const rowCount = Math.max(1, maximumRows)
  const firstRow = Math.max(0, cursorRow - rowCount + 1)
  const lastRow = Math.min(rows.length - 1, firstRow + rowCount - 1)
  const start = rows[firstRow]?.start ?? 0
  const end = rows[lastRow]?.end ?? graphemes.length
  const cursorGrapheme = graphemes[cursorIndex]
  const cursorConsumesValue = cursorGrapheme !== undefined && cursorGrapheme !== '\n'
  return {
    before: `${start > 0 ? '…' : ''}${graphemes.slice(start, cursorIndex).join('')}`,
    cursor: cursorConsumesValue ? cursorGrapheme : ' ',
    after: graphemes.slice(cursorIndex + (cursorConsumesValue ? 1 : 0), end).join('')
      + (end < graphemes.length ? '…' : ''),
    visibleRows: Math.max(1, lastRow - firstRow + 1),
    clippedBefore: start > 0,
    clippedAfter: end < graphemes.length,
  }
}

function layoutVisualRows(graphemes: readonly string[], width: number): VisualRow[] {
  const safeWidth = Math.max(1, width)
  const rows: VisualRow[] = []
  let start = 0
  let column = 0
  for (let index = 0; index < graphemes.length; index += 1) {
    const grapheme = graphemes[index]
    if (grapheme === '\n') {
      rows.push({ start, end: index })
      start = index + 1
      column = 0
      continue
    }
    const widthAtIndex = Math.max(1, stringWidth(grapheme ?? ''))
    if (column > 0 && column + widthAtIndex > safeWidth) {
      rows.push({ start, end: index })
      start = index
      column = 0
    }
    column += widthAtIndex
  }
  rows.push({ start, end: graphemes.length })
  return rows
}

function visualRowForCursor(rows: readonly VisualRow[], cursorIndex: number): number {
  let selected = 0
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row || row.start > cursorIndex) break
    selected = index
  }
  return selected
}

function cursorForColumn(
  graphemes: readonly string[],
  row: VisualRow,
  requestedColumn: number,
): number {
  let column = 0
  let cursor = row.start
  while (cursor < row.end) {
    const nextWidth = Math.max(1, stringWidth(graphemes[cursor] ?? ''))
    if (column + nextWidth > requestedColumn) break
    column += nextWidth
    cursor += 1
  }
  return cursor
}

function displayWidth(graphemes: readonly string[]): number {
  return graphemes.reduce((total, grapheme) => total + Math.max(1, stringWidth(grapheme)), 0)
}

function clampCursor(index: number, length: number): number {
  return Math.max(0, Math.min(length, index))
}

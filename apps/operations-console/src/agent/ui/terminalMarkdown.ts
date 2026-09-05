// +-------------------------------------------------------------------------
//
//   地理智能平台 - 终端 Markdown 适配器
//
//   文件:       terminalMarkdown.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-09-03):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: Markdown 复用终端语义色，并遵循无色、16 色和 256 色降级。
// --------------------------------------------------------------------------

import { stripVTControlCharacters } from 'node:util'

import { render, type Theme } from 'markdansi'
import wrapAnsi from 'wrap-ansi'

import {
  createConsolePalette,
  terminalColorLevel,
  type TerminalColorLevel,
} from '../../localConsoleTheme.js'

export interface TerminalMarkdownLine {
  text: string
  rendered: string
}

/**
 * Markdown 的 GFM 解析、终端折行、表格、列表和代码框统一交给 markdansi。
 * 适配层只负责清除外来 VT 控制符、关闭 OSC-8 链接、投影共享语义色并
 * 拆成可滚动物理行。
 */
export function renderTerminalMarkdown(
  markdown: string,
  width: number,
  colorLevel: TerminalColorLevel = terminalColorLevel,
): TerminalMarkdownLine[] {
  const safeMarkdown = sanitizeExternalText(markdown).replace(/\r\n?/gu, '\n')
  if (!safeMarkdown.trim()) return []
  const rendered = render(safeMarkdown, {
    wrap: true,
    width: Math.max(8, width),
    color: colorLevel !== 'none',
    hyperlinks: false,
    theme: createTerminalMarkdownTheme(colorLevel),
    quotePrefix: '│ ',
    tableBorder: 'unicode',
    tableTruncate: true,
    codeBox: true,
    codeWrap: true,
  })
  return splitRenderedLines(rendered)
}

export function createTerminalMarkdownTheme(colorLevel: TerminalColorLevel): Theme {
  const palette = createConsolePalette(colorLevel)
  return {
    heading: { ...markdownColor(palette.focus), bold: true },
    strong: { bold: true },
    emph: { ...markdownColor(palette.muted), italic: true },
    inlineCode: markdownColor(palette.accent),
    blockCode: markdownColor(palette.text),
    link: { ...markdownColor(palette.focus), underline: true },
    quote: { ...markdownColor(palette.muted), italic: true },
    hr: markdownColor(palette.borderStrong),
    listMarker: markdownColor(palette.accent),
    tableHeader: { ...markdownColor(palette.info), bold: true },
    tableCell: markdownColor(palette.text),
  }
}

export function terminalPlainLine(text: string): TerminalMarkdownLine {
  const safeText = sanitizeExternalText(text)
  return { text: safeText, rendered: safeText }
}

export function renderTerminalPlainText(text: string, width: number): TerminalMarkdownLine[] {
  const safeText = sanitizeExternalText(text).replace(/\r\n?/gu, '\n')
  if (!safeText) return []
  const wrapped = wrapAnsi(safeText, Math.max(1, width), {
    hard: true,
    trim: false,
    wordWrap: true,
  })
  return wrapped.split('\n').map(line => ({ text: line, rendered: line }))
}

function splitRenderedLines(value: string): TerminalMarkdownLine[] {
  const renderedLines = value.replace(/\r\n?/gu, '\n').split('\n')
  const lines = renderedLines.map(rendered => ({
    rendered,
    text: stripVTControlCharacters(rendered),
  }))
  while (lines[0]?.text === '') lines.shift()
  while (lines.at(-1)?.text === '') lines.pop()
  return lines
}

function sanitizeExternalText(value: string): string {
  return stripVTControlCharacters(value).replace(/\u0000/gu, '')
}

type MarkdownStyle = NonNullable<Theme['heading']>
type MarkdownNamedColor = 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'gray'

function markdownColor(color: string): MarkdownStyle {
  if (!color) return {}
  const ansi256 = /^ansi256\((\d{1,3})\)$/u.exec(color)
  const indexedColor = ansi256?.[1]
  if (indexedColor && isMarkdownNumericColor(indexedColor)) return { color: indexedColor }
  if (isMarkdownHexColor(color) || isMarkdownNamedColor(color)) return { color }
  return {}
}

function isMarkdownNumericColor(color: string): color is `${number}` {
  return /^\d{1,3}$/u.test(color)
}

function isMarkdownHexColor(color: string): color is `#${string}` {
  return /^#[0-9A-F]{6}$/u.test(color)
}

function isMarkdownNamedColor(color: string): color is MarkdownNamedColor {
  return ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray'].includes(color)
}

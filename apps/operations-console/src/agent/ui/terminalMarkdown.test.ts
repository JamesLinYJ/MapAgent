// +-------------------------------------------------------------------------
//
//   地理智能平台 - 终端 Markdown 适配器测试
//
//   文件:       terminalMarkdown.test.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { createConsolePalette } from '../../localConsoleTheme.js'
import {
  createTerminalMarkdownTheme,
  renderTerminalMarkdown,
} from './terminalMarkdown.js'

describe('terminal Markdown adapter', () => {
  it('delegates headings, lists, emphasis, links and fenced code to markdansi', () => {
    const lines = renderTerminalMarkdown([
      '# 杭州天气',
      '',
      '- **结论**：有阵雨，查看[数据源](https://example.com/weather)。',
      '',
      '```ts',
      'const rain = true',
      '```',
    ].join('\n'), 72, 'truecolor')
    const text = lines.map(line => line.text).join('\n')

    expect(text).toContain('杭州天气')
    expect(text).toContain('- 结论：有阵雨，查看数据源 (https://example.com/weather)。')
    expect(text).toContain('const rain = true')
    expect(text).not.toContain('**')
    expect(text).not.toContain('```')
    expect(lines.some(line => line.rendered.includes('\u001B['))).toBe(true)
  })

  it('uses the shared terminal palette instead of a second Markdown palette', () => {
    const palette = createConsolePalette('truecolor')
    const theme = createTerminalMarkdownTheme('truecolor')

    expect(theme.heading.color).toBe(palette.focus)
    expect(theme.link.color).toBe(palette.focus)
    expect(theme.listMarker.color).toBe(palette.accent)
    expect(theme.tableHeader.color).toBe(palette.info)
  })

  it('emits plain text without color controls when color is disabled', () => {
    const lines = renderTerminalMarkdown('# 结论\n\n- **杭州**：有阵雨', 40, 'none')
    const rendered = lines.map(line => line.rendered).join('\n')

    expect(rendered).toContain('结论')
    expect(rendered).toContain('杭州')
    expect(rendered).not.toContain('\u001B[')
  })

  it('does not emit true-color controls for 16-color and 256-color terminals', () => {
    const ansi16 = renderTerminalMarkdown('# 杭州\n\n- 风险', 40, 'ansi16')
      .map(line => line.rendered).join('\n')
    const ansi256 = renderTerminalMarkdown('# 杭州\n\n- 风险', 40, 'ansi256')
      .map(line => line.rendered).join('\n')

    expect(ansi16).toContain('\u001B[')
    expect(ansi16).not.toMatch(/\u001B\[(?:38|48);(?:2|5);/u)
    expect(ansi256).toMatch(/\u001B\[38;5;\d+m/u)
    expect(ansi256).not.toMatch(/\u001B\[(?:38|48);2;/u)
  })

  it('renders GFM tables in a bounded terminal grid', () => {
    const lines = renderTerminalMarkdown([
      '| 地点 | 风险 |',
      '| --- | --- |',
      '| 杭州 | 暴雨 |',
    ].join('\n'), 32)
    const text = lines.map(line => line.text).join('\n')

    expect(text).toContain('┌')
    expect(text).toContain('地点')
    expect(text).toContain('杭州')
    expect(Math.max(...lines.map(line => displayWidth(line.text)))).toBeLessThanOrEqual(32)
  })

  it('removes external terminal control sequences before rendering', () => {
    const [line] = renderTerminalMarkdown('\u001B[31m**安全文本**\u001B[0m', 40)

    expect(line?.text).toBe('安全文本')
    expect(line?.rendered).not.toContain('[31m')
  })
})

function displayWidth(value: string): number {
  let width = 0
  for (const character of value) {
    width += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60]/u.test(character) ? 2 : 1
  }
  return width
}

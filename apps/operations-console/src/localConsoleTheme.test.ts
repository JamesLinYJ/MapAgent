// +-------------------------------------------------------------------------
//
//   地理智能平台 - 终端色彩能力与主题测试
//
//   文件:       localConsoleTheme.test.ts
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  createConsolePalette,
  resolveTerminalColorLevel,
  type TerminalColorStream,
} from './localConsoleTheme.js'

describe('terminal color capability', () => {
  it('gives explicit no-color requests priority over forced color', () => {
    expect(resolveTerminalColorLevel(
      { NO_COLOR: '', FORCE_COLOR: '3', TERM: 'xterm-256color' },
      tty(24),
    )).toBe('none')
    expect(resolveTerminalColorLevel(
      { FORCE_COLOR: '3', TERM: 'dumb' },
      tty(24),
    )).toBe('none')
  })

  it.each([
    ['0', 'none'],
    ['false', 'none'],
    ['', 'ansi16'],
    ['true', 'ansi16'],
    ['1', 'ansi16'],
    ['2', 'ansi256'],
    ['3', 'truecolor'],
  ] as const)('maps FORCE_COLOR=%s to %s', (value, expected) => {
    expect(resolveTerminalColorLevel(
      { FORCE_COLOR: value, TERM: 'xterm' },
      { isTTY: false },
    )).toBe(expected)
  })

  it.each([
    [1, 'none'],
    [4, 'ansi16'],
    [8, 'ansi256'],
    [24, 'truecolor'],
  ] as const)('uses the output stream color depth %i', (depth, expected) => {
    expect(resolveTerminalColorLevel({ TERM: 'xterm' }, tty(depth))).toBe(expected)
  })

  it('falls back to fixed terminal hints when color-depth detection is unavailable', () => {
    expect(resolveTerminalColorLevel(
      { TERM: 'xterm', COLORTERM: 'truecolor' },
      { isTTY: true },
    )).toBe('truecolor')
    expect(resolveTerminalColorLevel(
      { TERM: 'screen-256color' },
      { isTTY: true, getColorDepth: () => { throw new Error('unsupported') } },
    )).toBe('ansi256')
    expect(resolveTerminalColorLevel(
      { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      { isTTY: false },
    )).toBe('none')
  })
})

describe('terminal semantic palette', () => {
  it('removes every foreground and background color in no-color mode', () => {
    expect(new Set(Object.values(createConsolePalette('none')))).toEqual(new Set(['']))
  })

  it('uses terminal-owned backgrounds in the 16-color fallback', () => {
    const palette = createConsolePalette('ansi16')
    expect([
      palette.canvas,
      palette.panel,
      palette.panelRaised,
      palette.panelSoft,
      palette.selected,
    ]).toEqual(['', '', '', '', ''])
    expect(Object.values(palette).every(color => !color.startsWith('#'))).toBe(true)
  })

  it('uses only indexed colors in the 256-color fallback', () => {
    const palette = createConsolePalette('ansi256')
    expect(Object.values(palette).every(color => (
      /^ansi256\(\d{1,3}\)$/u.test(color)
    ))).toBe(true)
    expect(palette).toMatchObject({
      canvas: 'ansi256(233)',
      panel: 'ansi256(234)',
      panelSoft: 'ansi256(235)',
      panelRaised: 'ansi256(236)',
      selected: 'ansi256(237)',
      border: 'ansi256(238)',
      borderStrong: 'ansi256(240)',
      muted: 'ansi256(246)',
      focus: 'ansi256(109)',
      info: 'ansi256(109)',
      accent: 'ansi256(109)',
      reasoning: 'ansi256(246)',
    })
  })

  it('keeps the true-color palette deliberately low-saturation', () => {
    const palette = createConsolePalette('truecolor')
    expect(Object.values(palette).every(color => /^#[0-9A-F]{6}$/u.test(color))).toBe(true)
    expect(Math.max(...[
      palette.canvas,
      palette.panel,
      palette.panelRaised,
      palette.panelSoft,
      palette.border,
      palette.borderStrong,
      palette.text,
      palette.muted,
      palette.focus,
      palette.info,
      palette.accent,
      palette.reasoning,
      palette.healthy,
      palette.selected,
    ].map(hexSaturation))).toBeLessThanOrEqual(0.201)
    expect(palette).toMatchObject({
      canvas: '#111418',
      panel: '#171B20',
      panelRaised: '#1E242B',
      border: '#343B44',
      text: '#D8DEE5',
      muted: '#8B949E',
      focus: '#7FA8A3',
      accent: '#7FA8A3',
      info: '#7FA8A3',
      reasoning: '#8B949E',
      healthy: '#82A98D',
      warning: '#C3A76A',
      danger: '#C78585',
      selected: '#283238',
    })
  })
})

function tty(depth: number): TerminalColorStream {
  return { isTTY: true, getColorDepth: () => depth }
}

function hexSaturation(color: string): number {
  const channels = [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16) / 255)
  const maximum = Math.max(...channels)
  const minimum = Math.min(...channels)
  if (maximum === minimum) return 0
  const lightness = (maximum + minimum) / 2
  return (maximum - minimum) / (1 - Math.abs(2 * lightness - 1))
}

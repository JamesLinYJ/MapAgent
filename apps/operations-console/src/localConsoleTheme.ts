// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本地运维台视觉主题
//
//   文件:       localConsoleTheme.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-07-27):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 增加 Agent 终端的信息层级色与活动指示器主题。
//
//   维护记录 (2026-09-03):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 将高饱和真彩收口为低饱和语义色，并按终端能力稳定降级。
// --------------------------------------------------------------------------

import { defaultTheme, extendTheme } from '@inkjs/ui'

export type TerminalColorLevel = 'none' | 'ansi16' | 'ansi256' | 'truecolor'

export interface ConsolePalette {
  readonly canvas: string
  readonly panel: string
  readonly panelRaised: string
  readonly panelSoft: string
  readonly border: string
  readonly borderStrong: string
  readonly text: string
  readonly muted: string
  readonly focus: string
  readonly info: string
  readonly accent: string
  readonly reasoning: string
  readonly healthy: string
  readonly warning: string
  readonly danger: string
  readonly selected: string
}

export interface TerminalColorStream {
  readonly isTTY?: boolean
  getColorDepth?: () => number
}

const noColorPalette: ConsolePalette = {
  canvas: '',
  panel: '',
  panelRaised: '',
  panelSoft: '',
  border: '',
  borderStrong: '',
  text: '',
  muted: '',
  focus: '',
  info: '',
  accent: '',
  reasoning: '',
  healthy: '',
  warning: '',
  danger: '',
  selected: '',
}

const ansi16Palette: ConsolePalette = {
  canvas: '',
  panel: '',
  panelRaised: '',
  panelSoft: '',
  border: 'gray',
  borderStrong: 'white',
  text: 'white',
  muted: 'gray',
  focus: 'cyan',
  info: 'cyan',
  accent: 'cyan',
  reasoning: 'gray',
  healthy: 'green',
  warning: 'yellow',
  danger: 'red',
  selected: '',
}

const ansi256Palette: ConsolePalette = {
  canvas: 'ansi256(233)',
  panel: 'ansi256(234)',
  panelRaised: 'ansi256(236)',
  panelSoft: 'ansi256(235)',
  border: 'ansi256(238)',
  borderStrong: 'ansi256(240)',
  text: 'ansi256(253)',
  muted: 'ansi256(246)',
  focus: 'ansi256(109)',
  info: 'ansi256(109)',
  accent: 'ansi256(109)',
  reasoning: 'ansi256(246)',
  healthy: 'ansi256(108)',
  warning: 'ansi256(143)',
  danger: 'ansi256(138)',
  selected: 'ansi256(237)',
}

const trueColorPalette: ConsolePalette = {
  canvas: '#111418',
  panel: '#171B20',
  panelRaised: '#1E242B',
  panelSoft: '#1A1F25',
  border: '#343B44',
  borderStrong: '#4B545F',
  text: '#D8DEE5',
  muted: '#8B949E',
  focus: '#7FA8A3',
  info: '#7FA8A3',
  accent: '#7FA8A3',
  reasoning: '#8B949E',
  healthy: '#82A98D',
  warning: '#C3A76A',
  danger: '#C78585',
  selected: '#283238',
}

/**
 * 终端色彩是输出设备能力，不是业务状态。只读取固定的非敏感
 * 终端字段；NO_COLOR 和 dumb 终端始终优先，避免下游库重新强制着色。
 */
export function resolveTerminalColorLevel(
  environment: Readonly<NodeJS.ProcessEnv>,
  stream: TerminalColorStream,
): TerminalColorLevel {
  if (environment.NO_COLOR !== undefined) return 'none'
  if (environment.TERM?.trim().toLowerCase() === 'dumb') return 'none'

  const forced = forcedColorLevel(environment.FORCE_COLOR)
  if (forced) return forced
  if (!stream.isTTY) return 'none'

  const reportedDepth = safeColorDepth(stream)
  if (reportedDepth !== null) {
    if (reportedDepth >= 24) return 'truecolor'
    if (reportedDepth >= 8) return 'ansi256'
    if (reportedDepth >= 4) return 'ansi16'
    return 'none'
  }

  const colorTerm = environment.COLORTERM?.trim().toLowerCase()
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 'truecolor'
  if (environment.TERM?.toLowerCase().includes('256color')) return 'ansi256'
  return 'ansi16'
}

export function createConsolePalette(level: TerminalColorLevel): ConsolePalette {
  if (level === 'truecolor') return trueColorPalette
  if (level === 'ansi256') return ansi256Palette
  if (level === 'ansi16') return ansi16Palette
  return noColorPalette
}

export const terminalColorLevel = resolveTerminalColorLevel(process.env, process.stdout)
export const consolePalette = createConsolePalette(terminalColorLevel)

export const platformConsoleTheme = extendTheme(defaultTheme, {
  components: {
    TextInput: {
      styles: { value: () => ({ color: consolePalette.focus, bold: true }) },
    },
    PasswordInput: {
      styles: { value: () => ({ color: consolePalette.focus, bold: true }) },
    },
    ConfirmInput: {
      styles: {
        container: () => ({ gap: 1 }),
        confirm: ({ isFocused }: { isFocused: boolean }) => ({
          color: isFocused ? consolePalette.healthy : consolePalette.muted,
          bold: isFocused,
        }),
        cancel: ({ isFocused }: { isFocused: boolean }) => ({
          color: isFocused ? consolePalette.danger : consolePalette.muted,
          bold: isFocused,
        }),
      },
    },
    Select: {
      styles: {
        selectedIndicator: () => ({ color: consolePalette.healthy }),
        focusIndicator: () => ({ color: consolePalette.focus }),
        label: ({ isFocused, isSelected }: { isFocused: boolean; isSelected: boolean }) => ({
          color: isFocused ? consolePalette.focus : isSelected ? consolePalette.healthy : consolePalette.text,
          bold: isFocused,
        }),
      },
    },
    Spinner: {
      styles: {
        container: () => ({ gap: 1 }),
        frame: () => ({ color: consolePalette.accent, bold: true }),
        label: () => ({ color: consolePalette.text, bold: true }),
      },
    },
  },
})

function forcedColorLevel(value: string | undefined): TerminalColorLevel | null {
  const normalized = value?.trim().toLowerCase()
  if (normalized === '0' || normalized === 'false') return 'none'
  if (normalized === '' || normalized === '1' || normalized === 'true') return 'ansi16'
  if (normalized === '2') return 'ansi256'
  if (normalized === '3') return 'truecolor'
  return null
}

function safeColorDepth(stream: TerminalColorStream): number | null {
  if (!stream.getColorDepth) return null
  try {
    const depth = stream.getColorDepth()
    return Number.isFinite(depth) ? depth : null
  } catch {
    return null
  }
}

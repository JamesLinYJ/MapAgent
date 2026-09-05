// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 活动指示器测试
//
//   文件:       localAgentActivity.test.tsx
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { stripVTControlCharacters } from 'node:util'

import { ThemeProvider } from '@inkjs/ui'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { platformConsoleTheme } from '../../localConsoleTheme.js'
import {
  AgentActivityIndicator,
  terminalMotionEnabled,
  type AgentActivityDescriptor,
} from './localAgentActivity.js'

afterEach(() => cleanup())

describe('AgentActivityIndicator', () => {
  it('animates only while terminal motion is enabled', async () => {
    const instance = render(
      <ThemeProvider theme={platformConsoleTheme}>
        <AgentActivityIndicator
          activity={activity()}
          animationsEnabled
          compact={false}
        />
      </ThemeProvider>,
    )

    await vi.waitFor(() => expect(instance.lastFrame()).toContain('正在推理'))
    const firstFrame = stripVTControlCharacters(instance.lastFrame() ?? '')
    await new Promise(resolve => setTimeout(resolve, 110))
    const secondFrame = stripVTControlCharacters(instance.lastFrame() ?? '')

    expect(secondFrame).not.toBe(firstFrame)
    expect(secondFrame).toContain('核验上下文、数据与工具证据')
  })

  it('keeps a stable labelled fallback when motion is reduced', async () => {
    const instance = render(
      <ThemeProvider theme={platformConsoleTheme}>
        <AgentActivityIndicator
          activity={activity()}
          animationsEnabled={false}
          compact={false}
        />
      </ThemeProvider>,
    )

    await vi.waitFor(() => expect(instance.lastFrame()).toContain('◐ 正在推理'))
    const firstFrame = stripVTControlCharacters(instance.lastFrame() ?? '')
    await new Promise(resolve => setTimeout(resolve, 110))
    expect(stripVTControlCharacters(instance.lastFrame() ?? '')).toBe(firstFrame)
  })

  it('honours CI, dumb terminals and the explicit reduced-motion switch', () => {
    expect(terminalMotionEnabled({ TERM: 'xterm-256color' })).toBe(true)
    expect(terminalMotionEnabled({ CI: 'true', TERM: 'xterm-256color' })).toBe(false)
    expect(terminalMotionEnabled({ TERM: 'dumb' })).toBe(false)
    expect(terminalMotionEnabled({
      GEO_AGENT_PLATFORM_REDUCED_MOTION: '1',
      TERM: 'xterm-256color',
    })).toBe(false)
  })
})

function activity(): AgentActivityDescriptor {
  return {
    key: 'reasoning:test',
    label: '正在推理',
    detail: '核验上下文、数据与工具证据',
    startedAt: new Date().toISOString(),
    color: '#DD8CFF',
  }
}

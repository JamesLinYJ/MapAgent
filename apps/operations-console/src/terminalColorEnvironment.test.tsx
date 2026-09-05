// +-------------------------------------------------------------------------
//
//   地理智能平台 - 终端无色环境准备测试
//
//   文件:       terminalColorEnvironment.test.tsx
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { stripVTControlCharacters } from 'node:util'

import type { LocalAgentSessionSnapshot } from './agent/application/localAgentSession.js'
import type {
  LocalAgentConsoleIdentity,
  LocalAgentConsoleSession,
} from './agent/ui/localAgentConsole.js'
import { describe, expect, it, vi } from 'vitest'

import { prepareTerminalColorEnvironment } from './terminalColorEnvironment.js'

describe('terminal no-color environment', () => {
  it.each([
    [{ NO_COLOR: '', FORCE_COLOR: '3', TERM: 'xterm-256color' }],
    [{ FORCE_COLOR: '3', TERM: 'dumb' }],
  ])('turns conflicting forced color off before Ink loads', environment => {
    prepareTerminalColorEnvironment(environment)
    expect(environment.FORCE_COLOR).toBe('0')
  })

  it('does not overwrite explicit color behavior for a capable terminal', () => {
    const environment = { FORCE_COLOR: '2', TERM: 'xterm-256color' }
    prepareTerminalColorEnvironment(environment)
    expect(environment.FORCE_COLOR).toBe('2')
  })

  it.each(['NO_COLOR', 'TERM=dumb'])('renders the complete Agent frame without ANSI for %s', async mode => {
    const previous = rememberColorEnvironment()
    let unmount: (() => void) | undefined
    try {
      process.env.FORCE_COLOR = '3'
      if (mode === 'NO_COLOR') {
        process.env.NO_COLOR = ''
        process.env.TERM = 'xterm-256color'
      } else {
        delete process.env.NO_COLOR
        process.env.TERM = 'dumb'
      }
      prepareTerminalColorEnvironment()
      expect(process.env.FORCE_COLOR).toBe('0')
      vi.resetModules()

      const React = await import('react')
      const { ThemeProvider } = await import('@inkjs/ui')
      const { render } = await import('ink-testing-library')
      const { LocalAgentConsoleApp } = await import('./agent/ui/localAgentConsole.js')
      const { platformConsoleTheme } = await import('./localConsoleTheme.js')
      const instance = render(React.createElement(
        ThemeProvider,
        { theme: platformConsoleTheme },
        React.createElement(LocalAgentConsoleApp, {
          session: noColorSession(),
          identity: noColorIdentity,
        }),
      ))
      unmount = instance.unmount
      resize(instance.stdout, 80, 24)

      await vi.waitFor(() => expect(instance.lastFrame()).toContain('智能体终端'))
      const frame = instance.lastFrame() ?? ''
      expect(frame).not.toContain('\u001b')
      expect(stripVTControlCharacters(frame)).toBe(frame)
    } finally {
      unmount?.()
      restoreColorEnvironment(previous)
      vi.resetModules()
    }
  })
})

function noColorSession(): LocalAgentConsoleSession {
  const current: LocalAgentSessionSnapshot = {
    connection: 'online',
    connectionMessage: '已连接',
    bootstrap: null,
    provider: null,
    model: null,
    executionMode: 'auto',
    reasoning: true,
    threadId: null,
    run: null,
    items: [],
    events: [],
    error: null,
  }
  const unavailable = async (): Promise<never> => {
    throw new Error('无色渲染测试不会调用服务端。')
  }
  return {
    snapshot: () => current,
    subscribe: () => () => undefined,
    close: () => undefined,
    submit: unavailable,
    respondDecision: unavailable,
    cancel: unavailable,
    resume: unavailable,
    setExecutionMode: () => undefined,
    setReasoning: () => undefined,
    newConversation: () => undefined,
    listThreads: async () => [],
    openThread: async () => undefined,
  }
}

interface ColorEnvironmentSnapshot {
  FORCE_COLOR: string | undefined
  NO_COLOR: string | undefined
  TERM: string | undefined
}

function rememberColorEnvironment(): ColorEnvironmentSnapshot {
  return {
    FORCE_COLOR: process.env.FORCE_COLOR,
    NO_COLOR: process.env.NO_COLOR,
    TERM: process.env.TERM,
  }
}

function restoreColorEnvironment(snapshot: ColorEnvironmentSnapshot): void {
  restoreEnvironmentValue('FORCE_COLOR', snapshot.FORCE_COLOR)
  restoreEnvironmentValue('NO_COLOR', snapshot.NO_COLOR)
  restoreEnvironmentValue('TERM', snapshot.TERM)
}

function restoreEnvironmentValue(name: keyof ColorEnvironmentSnapshot, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function resize(stdout: NodeJS.EventEmitter, columns: number, rows: number): void {
  Object.defineProperty(stdout, 'columns', { configurable: true, value: columns })
  Object.defineProperty(stdout, 'rows', { configurable: true, value: rows })
  stdout.emit('resize')
}

const noColorIdentity: LocalAgentConsoleIdentity = {
  version: '0.1.0',
  projectRoot: '/tmp/mapagents-no-color-test',
  osUser: 'tester',
  hostname: 'terminal',
  keyVersion: 'v1',
}

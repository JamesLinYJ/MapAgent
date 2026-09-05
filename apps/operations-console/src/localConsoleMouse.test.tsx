// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本地运维台鼠标命中测试
//
//   文件:       localConsoleMouse.test.tsx
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { EventEmitter } from 'node:events'

import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Text } from 'ink'

import { LocalConsoleMouseProvider, MouseRegion } from './localConsoleMouse.js'
import type { TerminalMouseEvent, TerminalMouseSource } from './terminalMouse.js'

afterEach(() => cleanup())

describe('LocalConsoleMouseProvider', () => {
  it('provides hover, click and wheel behavior for measured Ink boxes', async () => {
    const source = new TestMouseSource()
    const onClick = vi.fn()
    const onWheel = vi.fn()
    const instance = render(
      <LocalConsoleMouseProvider source={source}>
        <MouseRegion width={12} height={2} onWheel={onWheel}>
          <MouseRegion width={6} height={1} priority={10} onClick={onClick}>
            {state => <Text>{state.pressed ? '按下' : state.hovered ? '悬停' : '空闲'}</Text>}
          </MouseRegion>
        </MouseRegion>
      </LocalConsoleMouseProvider>,
    )

    source.emit(mouseEvent('move', 1, 1))
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('悬停'))
    source.emit(mouseEvent('press', 1, 1))
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('按下'))
    source.emit(mouseEvent('release', 1, 1))
    source.emit({ ...mouseEvent('wheel', 1, 1), button: 'none', deltaY: -1 })

    await vi.waitFor(() => expect(onClick).toHaveBeenCalledOnce())
    expect(onWheel).toHaveBeenCalledWith(-1, expect.objectContaining({ kind: 'wheel' }))
  })
})

class TestMouseSource implements TerminalMouseSource {
  readonly enabled = true
  private readonly events = new EventEmitter()

  subscribe(listener: (event: TerminalMouseEvent) => void): () => void {
    this.events.on('mouse', listener)
    return () => this.events.off('mouse', listener)
  }

  emit(event: TerminalMouseEvent): void {
    this.events.emit('mouse', event)
  }
}

function mouseEvent(kind: TerminalMouseEvent['kind'], column: number, row: number): TerminalMouseEvent {
  return { kind, column, row, button: 'left', deltaY: 0, shift: false, meta: false, ctrl: false }
}

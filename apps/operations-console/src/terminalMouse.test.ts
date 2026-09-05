// +-------------------------------------------------------------------------
//
//   地理智能平台 - 终端鼠标协议适配器测试
//
//   文件:       terminalMouse.test.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'

import { createTerminalMouseController, SgrMouseDecoder } from './terminalMouse.js'

describe('SgrMouseDecoder', () => {
  it('separates clicks from keyboard input without losing CJK text', () => {
    const decoder = new SgrMouseDecoder()
    const result = decoder.push(`杭州\u001B[<0;12;5M地图\u001B[<0;12;5m`)

    expect(result.keyboard).toBe('杭州地图')
    expect(result.events).toEqual([
      expect.objectContaining({ kind: 'press', button: 'left', column: 12, row: 5 }),
      expect.objectContaining({ kind: 'release', button: 'left', column: 12, row: 5 }),
    ])
  })

  it('decodes chunked wheel frames and modifiers', () => {
    const decoder = new SgrMouseDecoder()
    expect(decoder.push('\u001B[<84;20')).toEqual({ keyboard: '', events: [] })
    const result = decoder.push(';9M')

    expect(result.keyboard).toBe('')
    expect(result.events).toEqual([
      expect.objectContaining({ kind: 'wheel', deltaY: -1, column: 20, row: 9, ctrl: true }),
    ])
  })

  it('preserves non-mouse escape sequences for Ink', () => {
    const decoder = new SgrMouseDecoder()
    expect(decoder.push('\u001B[A')).toEqual({ keyboard: '\u001B[A', events: [] })
    expect(decoder.push('\u001B')).toEqual({ keyboard: '', events: [] })
    expect(decoder.flushPending()).toEqual({ keyboard: '\u001B', events: [] })
  })

  it('drops malformed mouse protocol bytes instead of injecting them as text', () => {
    const decoder = new SgrMouseDecoder()
    const result = decoder.push('a\u001B[<9999;1;1Mb')

    expect(result.keyboard).toBe('ab')
    expect(result.events).toEqual([])
  })

  it('proxies raw mode while filtering mouse bytes before Ink receives input', async () => {
    const source = new TestInputStream()
    const output = new TestOutputStream()
    const controller = createTerminalMouseController(
      source as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    )
    const keyboard: string[] = []
    const mouse = vi.fn()
    controller.stdin.setEncoding('utf8')
    controller.stdin.on('data', chunk => keyboard.push(String(chunk)))
    controller.subscribe(mouse)

    source.write('前')
    controller.activate()
    controller.stdin.setRawMode(true)
    source.write('a\u001B[<0;3;2M\u001B[<0;3;2mb')
    await new Promise(resolve => setImmediate(resolve))
    controller.stdin.setRawMode(false)
    controller.close()

    expect(keyboard.join('')).toBe('前ab')
    expect(mouse).toHaveBeenCalledTimes(2)
    expect(source.rawModes).toEqual([true, false])
    expect(output.content).toContain('\u001B[?1006h')
    expect(output.content).toContain('\u001B[?1006l')
  })

  it('keeps keyboard input available without enabling mouse mode on non-TTY streams', async () => {
    const source = new TestInputStream(false)
    const output = new TestOutputStream(false)
    const controller = createTerminalMouseController(
      source as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    )
    const keyboard: string[] = []
    controller.stdin.setEncoding('utf8')
    controller.stdin.on('data', chunk => keyboard.push(String(chunk)))

    controller.activate()
    source.write('键盘后备')
    await new Promise(resolve => setImmediate(resolve))
    controller.close()

    expect(controller.enabled).toBe(false)
    expect(keyboard.join('')).toBe('键盘后备')
    expect(output.content).toBe('')
  })
})

class TestInputStream extends PassThrough {
  readonly isTTY: boolean
  readonly rawModes: boolean[] = []
  isRaw = false

  constructor(isTTY = true) {
    super()
    this.isTTY = isTTY
  }

  setRawMode(value: boolean): this {
    this.isRaw = value
    this.rawModes.push(value)
    return this
  }

  ref(): this { return this }
  unref(): this { return this }
}

class TestOutputStream extends PassThrough {
  readonly isTTY: boolean
  content = ''

  constructor(isTTY = true) {
    super()
    this.isTTY = isTTY
    this.on('data', chunk => { this.content += String(chunk) })
  }
}

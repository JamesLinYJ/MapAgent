// +-------------------------------------------------------------------------
//
//   地理智能平台 - 终端鼠标协议适配器
//
//   文件:       terminalMouse.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

const MOUSE_PREFIX = '\u001B[<'
const COMPLETE_MOUSE_SEQUENCE = /^\u001B\[<(\d{1,3});(\d{1,5});(\d{1,5})([Mm])/u
const MAX_MOUSE_SEQUENCE_LENGTH = 48
const INPUT_FLUSH_DELAY_MS = 20
const ENABLE_MOUSE_CLICK_TRACKING = '\u001B[?1000h\u001B[?1006h'
const ENABLE_MOUSE_MOTION_TRACKING = '\u001B[?1000h\u001B[?1003h\u001B[?1006h'
const DISABLE_MOUSE_TRACKING = '\u001B[?1006l\u001B[?1003l\u001B[?1000l'

type TerminalMouseButton = 'left' | 'middle' | 'right' | 'none'

export interface TerminalMouseEvent {
  kind: 'press' | 'release' | 'move' | 'wheel'
  column: number
  row: number
  button: TerminalMouseButton
  deltaY: -1 | 0 | 1
  shift: boolean
  meta: boolean
  ctrl: boolean
}

export interface TerminalMouseSource {
  readonly enabled: boolean
  subscribe: (listener: (event: TerminalMouseEvent) => void) => () => void
}

export interface TerminalMouseController extends TerminalMouseSource {
  readonly stdin: NodeJS.ReadStream
  activate: () => void
  close: () => void
}

interface DecodedInput {
  keyboard: string
  events: TerminalMouseEvent[]
}

/**
 * 过滤标准 SGR 1006 鼠标帧，并把剩余输入原样交给 Ink。
 * 鼠标协议与键盘流在这里分离，避免坐标字节进入密码或文本输入框。
 */
export class SgrMouseDecoder {
  private readonly utf8 = new StringDecoder('utf8')
  private pending = ''

  push(chunk: string | Uint8Array): DecodedInput {
    this.pending += typeof chunk === 'string' ? chunk : this.utf8.write(Buffer.from(chunk))
    return this.drain(false)
  }

  flushPending(): DecodedInput {
    return this.drain(true)
  }

  end(): DecodedInput {
    this.pending += this.utf8.end()
    return this.drain(true)
  }

  hasPending(): boolean {
    return this.pending.length > 0
  }

  private drain(flush: boolean): DecodedInput {
    let keyboard = ''
    const events: TerminalMouseEvent[] = []

    while (this.pending.length > 0) {
      const markerIndex = this.pending.indexOf(MOUSE_PREFIX)
      if (markerIndex < 0) {
        const heldSuffixLength = flush ? 0 : mousePrefixSuffixLength(this.pending)
        const outputLength = this.pending.length - heldSuffixLength
        keyboard += this.pending.slice(0, outputLength)
        this.pending = this.pending.slice(outputLength)
        break
      }

      if (markerIndex > 0) {
        keyboard += this.pending.slice(0, markerIndex)
        this.pending = this.pending.slice(markerIndex)
      }

      const match = COMPLETE_MOUSE_SEQUENCE.exec(this.pending)
      if (match) {
        const sequence = match[0]
        const event = decodeMouseEvent(match)
        this.pending = this.pending.slice(sequence.length)
        if (event) events.push(event)
        continue
      }

      const malformedTerminator = this.pending.search(/[Mm]/u)
      if (malformedTerminator >= MOUSE_PREFIX.length) {
        // 非法坐标帧也属于终端协议，完整丢弃，绝不注入业务输入。
        this.pending = this.pending.slice(malformedTerminator + 1)
        continue
      }
      if (!flush && this.pending.length <= MAX_MOUSE_SEQUENCE_LENGTH) break

      // 超长或超时的协议前缀不可信；整段丢弃，避免污染密码与确认输入。
      this.pending = ''
    }

    return { keyboard, events }
  }
}

export function createTerminalMouseController(
  source: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
  options: { trackMotion?: boolean } = {},
): TerminalMouseController {
  const events = new EventEmitter()
  const decoder = new SgrMouseDecoder()
  let flushTimer: NodeJS.Timeout | null = null
  let active = false

  const forward = (result: DecodedInput, target: PassThrough): void => {
    if (result.keyboard) target.write(result.keyboard)
    for (const event of result.events) events.emit('mouse', event)
  }

  const input = new FilteredTerminalInput(source, chunk => {
    if (flushTimer) clearTimeout(flushTimer)
    forward(decoder.push(chunk), input)
    if (decoder.hasPending()) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        forward(decoder.flushPending(), input)
      }, INPUT_FLUSH_DELAY_MS)
      flushTimer.unref()
    }
  }, () => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    forward(decoder.end(), input)
    input.end()
  })

  const enabled = Boolean(source.isTTY && output.isTTY)
  return {
    enabled,
    // Node 的 ReadStream 类型带有 TTY 名义成员；适配器在运行时完整代理这些成员。
    stdin: input as unknown as NodeJS.ReadStream,
    subscribe(listener) {
      events.on('mouse', listener)
      return () => events.off('mouse', listener)
    },
    activate() {
      input.attach()
      if (!enabled || active) return
      active = true
      output.write(options.trackMotion === false ? ENABLE_MOUSE_CLICK_TRACKING : ENABLE_MOUSE_MOTION_TRACKING)
    },
    close() {
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = null
      if (active) output.write(DISABLE_MOUSE_TRACKING)
      active = false
      input.detach()
      events.removeAllListeners()
    },
  }
}

class FilteredTerminalInput extends PassThrough {
  private attached = false
  private detached = false

  constructor(
    private readonly source: NodeJS.ReadStream,
    private readonly onSourceData: (chunk: string | Buffer) => void,
    private readonly onSourceEnd: () => void,
  ) {
    super()
  }

  get isTTY(): boolean {
    return Boolean(this.source.isTTY)
  }

  get isRaw(): boolean {
    return Boolean(this.source.isRaw)
  }

  setRawMode(enabled: boolean): this {
    this.source.setRawMode(enabled)
    return this
  }

  ref(): this {
    this.source.ref()
    return this
  }

  unref(): this {
    this.source.unref()
    return this
  }

  attach(): void {
    if (this.attached || this.detached) return
    this.attached = true
    this.source.on('data', this.onSourceData)
    this.source.once('end', this.onSourceEnd)
    this.source.once('error', this.onSourceError)
  }

  detach(): void {
    if (this.detached) return
    this.detached = true
    if (this.attached) {
      this.source.off('data', this.onSourceData)
      this.source.off('end', this.onSourceEnd)
      this.source.off('error', this.onSourceError)
      this.attached = false
    }
    this.source.pause()
    this.end()
  }

  private readonly onSourceError = (error: Error): void => {
    this.destroy(error)
  }
}

function decodeMouseEvent(match: RegExpExecArray): TerminalMouseEvent | null {
  const code = Number(match[1])
  const column = Number(match[2])
  const row = Number(match[3])
  const terminator = match[4]
  if (!Number.isInteger(code) || code < 0 || code > 255 || column < 1 || row < 1) return null

  const buttonCode = code & 3
  const wheel = (code & 64) !== 0
  const motion = (code & 32) !== 0
  const released = terminator === 'm'
  const button: TerminalMouseButton = buttonCode === 0
    ? 'left'
    : buttonCode === 1
      ? 'middle'
      : buttonCode === 2
        ? 'right'
        : 'none'

  return {
    kind: wheel ? 'wheel' : released ? 'release' : motion ? 'move' : 'press',
    column,
    row,
    button: wheel ? 'none' : button,
    deltaY: wheel ? (buttonCode === 0 ? -1 : 1) : 0,
    shift: (code & 4) !== 0,
    meta: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  }
}

function mousePrefixSuffixLength(value: string): number {
  const maximum = Math.min(value.length, MOUSE_PREFIX.length - 1)
  for (let length = maximum; length > 0; length -= 1) {
    if (MOUSE_PREFIX.startsWith(value.slice(-length))) return length
  }
  return 0
}

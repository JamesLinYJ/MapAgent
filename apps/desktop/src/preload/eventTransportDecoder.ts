// +-------------------------------------------------------------------------
//
//   地理智能平台 - 沙箱桌面事件传输解码器
//
//   文件:       eventTransportDecoder.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  desktopEventPayloadSchema,
  desktopEventTransportSchema,
  type DesktopEvent,
} from '../contracts/desktopIpc.js'
import { decodeDesktopCompressedJson } from './compressedIpcPayloadDecoder.js'

type DesktopEventListener = (event: DesktopEvent) => void
type DesktopEventDecodeErrorListener = (error: unknown) => void

export async function decodeDesktopEvent(input: unknown): Promise<DesktopEvent> {
  const envelope = desktopEventTransportSchema.parse(input)
  if (!('encoding' in envelope)) return envelope
  return desktopEventPayloadSchema.parse(
    await decodeDesktopCompressedJson(envelope, '桌面事件'),
  )
}

/**
 * IPC 保证帧到达顺序，但压缩帧的异步解码速度不同。
 * 每个 Renderer 订阅独立串行解码，避免后到的直传帧超过先到的压缩帧。
 */
export function createOrderedDesktopEventDispatcher(
  listener: DesktopEventListener,
  onDecodeError: DesktopEventDecodeErrorListener,
): (input: unknown) => Promise<void> {
  let pending = Promise.resolve()

  return (input) => {
    pending = pending
      .then(async () => listener(await decodeDesktopEvent(input)))
      .catch(onDecodeError)
    return pending
  }
}

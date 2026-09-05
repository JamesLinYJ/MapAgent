// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面事件传输编码器
//
//   文件:       eventTransportEncoder.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  desktopCompressedEventSchema,
  desktopEventPayloadSchema,
  desktopEventSchema,
  type DesktopEvent,
  type DesktopEventTransport,
} from '../contracts/desktopIpc.js'
import { encodeDesktopCompressedJson } from './compressedIpcPayloadEncoder.js'

/**
 * 小事件保持直接帧；大型运行推送使用受限 Gzip envelope。
 * 业务事件本身仍按未压缩 schema 校验，压缩只是 Main/Preload 传输细节。
 */
export function encodeDesktopEvent(input: DesktopEvent): DesktopEventTransport {
  const event = desktopEventPayloadSchema.parse(input)
  const direct = desktopEventSchema.safeParse(event)
  if (direct.success) return direct.data

  return desktopCompressedEventSchema.parse({
    version: event.version,
    frame: 'event',
    encoding: 'gzip-base64',
    ...encodeDesktopCompressedJson(event, '桌面事件'),
  })
}

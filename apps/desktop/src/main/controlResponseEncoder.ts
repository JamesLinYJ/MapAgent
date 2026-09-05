// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面控制响应编码器
//
//   文件:       controlResponseEncoder.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  desktopCompressedControlResponseSchema,
  desktopControlResponsePayloadSchema,
  desktopControlResponseSchema,
  type DesktopControlResponse,
  type DesktopControlResponseTransport,
} from '../contracts/desktopIpc.js'
import { encodeDesktopCompressedJson } from './compressedIpcPayloadEncoder.js'

/**
 * Main 独占 Node 压缩能力。普通响应保持直接帧；大型只读快照使用受约束的
 * Gzip envelope，使沙箱 preload 不需要加载任何 Node 内置模块。
 */
export function encodeDesktopControlResponse(
  input: DesktopControlResponse,
): DesktopControlResponseTransport {
  const response = desktopControlResponsePayloadSchema.parse(input)
  const direct = desktopControlResponseSchema.safeParse(response)
  if (direct.success) return direct.data

  const compressed = encodeDesktopCompressedJson(response, '桌面控制响应')
  return desktopCompressedControlResponseSchema.parse({
    version: response.version,
    requestId: response.requestId,
    encoding: 'gzip-base64',
    ...compressed,
  })
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 沙箱控制响应解码器
//
//   文件:       controlResponseDecoder.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  desktopControlResponsePayloadSchema,
  desktopControlResponseTransportSchema,
  type DesktopControlResponse,
} from '../contracts/desktopIpc.js'
import { decodeDesktopCompressedJson } from './compressedIpcPayloadDecoder.js'

/**
 * 沙箱 preload 只使用 Chromium Web API。流式读取在分配完整结果前实施硬上限，
 * 避免压缩炸弹，也避免为了解压大型工作区快照而扩大 preload 的 Node 权限。
 */
export async function decodeDesktopControlResponse(
  input: unknown,
): Promise<DesktopControlResponse> {
  const envelope = desktopControlResponseTransportSchema.parse(input)
  if (!('encoding' in envelope)) return envelope

  return desktopControlResponsePayloadSchema.parse(
    await decodeDesktopCompressedJson(envelope, '桌面控制响应'),
  )
}

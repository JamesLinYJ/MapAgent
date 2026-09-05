// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面压缩 IPC 载荷编码器
//
//   文件:       compressedIpcPayloadEncoder.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { gzipSync } from 'node:zlib'

import { DESKTOP_CONTROL_DECOMPRESSED_MAX_BYTES } from '../contracts/desktopIpc.js'

export interface DesktopCompressedJson {
  uncompressedBytes: number
  payload: string
}

/** Main 独占 Node 压缩能力，并在压缩前限制真实 JSON 载荷大小。 */
export function encodeDesktopCompressedJson(
  value: unknown,
  label: string,
): DesktopCompressedJson {
  const serialized = Buffer.from(JSON.stringify(value), 'utf8')
  if (serialized.byteLength > DESKTOP_CONTROL_DECOMPRESSED_MAX_BYTES) {
    throw new Error(
      `${label}解压后不得超过 ${DESKTOP_CONTROL_DECOMPRESSED_MAX_BYTES} 字节，请改用分页或拆分事件。`,
    )
  }
  return {
    uncompressedBytes: serialized.byteLength,
    payload: gzipSync(serialized, { level: 6 }).toString('base64'),
  }
}

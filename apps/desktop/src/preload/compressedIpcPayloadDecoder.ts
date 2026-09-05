// +-------------------------------------------------------------------------
//
//   地理智能平台 - 沙箱压缩 IPC 载荷解码器
//
//   文件:       compressedIpcPayloadDecoder.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { DESKTOP_CONTROL_DECOMPRESSED_MAX_BYTES } from '../contracts/desktopIpc.js'

interface DesktopCompressedJsonEnvelope {
  encoding: 'gzip-base64'
  uncompressedBytes: number
  payload: string
}

/**
 * 沙箱 preload 只使用 Chromium Web API。流式读取在分配完整结果前实施硬上限，
 * 防止压缩炸弹，也不需要向 preload 开放 Node 内置模块。
 */
export async function decodeDesktopCompressedJson(
  envelope: DesktopCompressedJsonEnvelope,
  label: string,
): Promise<unknown> {
  const compressed = decodeBase64(envelope.payload)
  const compressedBuffer = new ArrayBuffer(compressed.byteLength)
  new Uint8Array(compressedBuffer).set(compressed)
  const stream = new Blob([compressedBuffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0

  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      byteLength += result.value.byteLength
      if (byteLength > DESKTOP_CONTROL_DECOMPRESSED_MAX_BYTES) {
        await reader.cancel(`${label}超过解压上限。`)
        throw new Error(
          `${label}解压后不得超过 ${DESKTOP_CONTROL_DECOMPRESSED_MAX_BYTES} 字节。`,
        )
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }

  if (byteLength !== envelope.uncompressedBytes) {
    throw new Error(`${label}解压长度与 envelope 声明不一致。`)
  }

  const bytes = concatenateChunks(chunks, byteLength)
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error(`${label}解压后不是有效 JSON。`)
  }
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return bytes
}

function concatenateChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 有界 JSONL 帧编解码
//
//   文件:       jsonl.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

export const OPERATIONS_MAX_FRAME_BYTES = 64 * 1024

export class JsonlFrameDecoder {
  private pending = Buffer.alloc(0)

  push(chunk: string | Uint8Array): string[] {
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)])
    const frames: string[] = []
    while (true) {
      const newline = this.pending.indexOf(0x0a)
      if (newline < 0) break
      if (newline + 1 > OPERATIONS_MAX_FRAME_BYTES) throw new FrameTooLargeError()
      const frame = this.pending.subarray(0, newline)
      this.pending = this.pending.subarray(newline + 1)
      if (frame.length === 0) continue
      frames.push(frame.toString('utf8'))
    }
    if (this.pending.length >= OPERATIONS_MAX_FRAME_BYTES) throw new FrameTooLargeError()
    return frames
  }
}

export function encodeJsonlFrame(value: unknown): Buffer {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  if (payload.length > OPERATIONS_MAX_FRAME_BYTES) throw new FrameTooLargeError()
  return payload
}

export class FrameTooLargeError extends Error {
  constructor() {
    super(`IPC 帧超过 ${OPERATIONS_MAX_FRAME_BYTES / 1024} KiB 上限。`)
    this.name = 'FrameTooLargeError'
  }
}

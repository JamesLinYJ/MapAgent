// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron multipart 请求体写入器
//
//   文件:       multipartRequestWriter.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { Writable, type Readable } from 'node:stream'

interface MultipartRequestTarget {
  write(chunk: Buffer, encoding: BufferEncoding, callback: () => void): void
}

/**
 * 用 Node 流管线把 form-data 输出写入 Electron ClientRequest。
 *
 * form-data 继承 Readable，但它的运行时实现不提供 AsyncIterator；通过标准
 * pipeline 保留流式背压与错误传播，避免把大型气象文件整体缓冲到内存。
 */
export async function writeMultipartRequestBody(
  form: Readable,
  request: MultipartRequestTarget,
): Promise<void> {
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        request.write(chunk, 'utf8', callback)
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    },
  })

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      form.removeListener('error', fail)
      sink.removeListener('error', fail)
    }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }
    form.once('error', fail)
    sink.once('error', fail)
    sink.once('finish', () => {
      cleanup()
      resolve()
    })
    // form-data 基于旧式 Stream 实现；其受支持入口是 pipe()，而不是
    // AsyncIterator 或 stream/promises.pipeline。
    form.pipe(sink)
  })
}

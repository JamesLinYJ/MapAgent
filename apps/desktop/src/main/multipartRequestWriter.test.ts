// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron multipart 请求体写入器测试
//
//   文件:       multipartRequestWriter.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import FormData from 'form-data'
import { describe, expect, it } from 'vitest'

import { writeMultipartRequestBody } from './multipartRequestWriter.js'

describe('writeMultipartRequestBody', () => {
  it('streams form-data without requiring a runtime AsyncIterator', async () => {
    const form = new FormData()
    form.append('threadId', 'thread_1')
    form.append('file', Buffer.from('NC-DEMO'), {
      filename: 'forecast.nc',
      contentType: 'application/x-netcdf',
    })
    const chunks: Buffer[] = []

    await writeMultipartRequestBody(form, {
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        queueMicrotask(callback)
      },
    })

    const body = Buffer.concat(chunks).toString('utf8')
    expect(body).toContain('name="threadId"')
    expect(body).toContain('thread_1')
    expect(body).toContain('filename="forecast.nc"')
    expect(body).toContain('NC-DEMO')
  })

  it('propagates a synchronous Electron request write failure', async () => {
    const form = new FormData()
    form.append('file', Buffer.from('broken'))

    await expect(writeMultipartRequestBody(form, {
      write() {
        throw new Error('request closed')
      },
    })).rejects.toThrow('request closed')
  })
})

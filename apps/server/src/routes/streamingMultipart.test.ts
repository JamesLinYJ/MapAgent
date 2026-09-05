// +-------------------------------------------------------------------------
//
//   地理智能平台 - 流式 Multipart 上传边界测试
//
//   文件:       streamingMultipart.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HttpClientError } from './errors.js'
import { parseStreamingMultipart } from './streamingMultipart.js'

describe('streaming multipart upload boundary', () => {
  it('accepts a chunked file at the exact byte limit without Content-Length', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-multipart-'))
    try {
      const body = multipartBody('exact-boundary', Buffer.from([1, 2, 3, 4]))
      const form = await parseStreamingMultipart(
        multipartRequest('exact-boundary', body, { chunkBytes: 3 }),
        root,
        4,
      )
      const file = form.requireFile('file')

      expect(file.sizeBytes).toBe(4)
      await expect(readFile(file.tempPath)).resolves.toEqual(Buffer.from([1, 2, 3, 4]))
      if (process.platform !== 'win32') {
        expect((await stat(file.tempPath)).mode & 0o777).toBe(0o600)
      }
      await form.dispose()
      await expect(stat(file.tempPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['missing Content-Length', undefined],
    ['understated Content-Length', '1'],
  ])('rejects actual file bytes over the limit with %s', async (_label, contentLength) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-multipart-'))
    try {
      const body = multipartBody('over-boundary', Buffer.from([1, 2, 3, 4, 5]))
      const request = multipartRequest('over-boundary', body, {
        chunkBytes: 2,
        ...(contentLength ? { contentLength } : {}),
      })

      const error = await parseStreamingMultipart(request, root, 4).catch(reason => reason)
      expect(error).toBeInstanceOf(HttpClientError)
      expect(error).toMatchObject({ status: 413 })
      await expect(requestDirectories(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an oversized declared request before consuming its body', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-multipart-'))
    try {
      const body = multipartBody('declared-boundary', Buffer.from([1]))
      const request = multipartRequest('declared-boundary', body, {
        contentLength: String(5 * 1024 * 1024),
      })

      const error = await parseStreamingMultipart(request, root, 4).catch(reason => reason)
      expect(error).toBeInstanceOf(HttpClientError)
      expect(error).toMatchObject({ status: 413 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function multipartBody(boundary: string, fileContent: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n`
      + 'Content-Disposition: form-data; name="threadId"\r\n\r\n'
      + 'thread_1\r\n'
      + `--${boundary}\r\n`
      + 'Content-Disposition: form-data; name="file"; filename="sample.nc"\r\n'
      + 'Content-Type: application/x-netcdf\r\n\r\n',
      'utf8',
    ),
    fileContent,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ])
}

function multipartRequest(
  boundary: string,
  body: Buffer,
  options: { chunkBytes?: number; contentLength?: string } = {},
): Request {
  const chunkBytes = options.chunkBytes ?? body.byteLength
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < body.byteLength; offset += chunkBytes) {
        controller.enqueue(body.subarray(offset, Math.min(offset + chunkBytes, body.byteLength)))
      }
      controller.close()
    },
  })
  const headers = new Headers({ 'content-type': `multipart/form-data; boundary=${boundary}` })
  if (options.contentLength) headers.set('content-length', options.contentLength)
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers,
    body: stream,
    duplex: 'half',
  }
  return new Request('http://localhost/upload', init)
}

async function requestDirectories(root: string): Promise<string[]> {
  const multipartRoot = path.join(root, 'uploads', '.multipart')
  try {
    return (await readdir(multipartRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

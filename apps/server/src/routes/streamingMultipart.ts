// +-------------------------------------------------------------------------
//
//   地理智能平台 - 流式 Multipart 上传边界
//
//   文件:       streamingMultipart.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import type { IncomingHttpHeaders } from 'node:http'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import busboy from 'busboy'
import { HttpClientError } from './errors.js'

const MAX_FIELDS = 32
const MAX_FIELD_BYTES = 64 * 1024
const MULTIPART_OVERHEAD_BYTES = 4 * 1024 * 1024

interface StagedUploadFile {
  fieldName: string
  name: string
  mediaType: string
  tempPath: string
  sizeBytes: number
  contentHash: string
}

export interface StreamingMultipartForm {
  field(name: string): string | null
  requireFile(name: string): StagedUploadFile
  dispose(): Promise<void>
}

export async function parseStreamingMultipart(
  request: Request,
  runtimeRoot: string,
  maxFileBytes: number,
): Promise<StreamingMultipartForm> {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error('Multipart 上传缺少有效的文件大小限制。')
  }
  if (!request.body) throw new HttpClientError('上传请求缺少请求体。')
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    throw new HttpClientError('上传请求必须使用 multipart/form-data。', 415)
  }

  const maxRequestBytes = maxFileBytes + MULTIPART_OVERHEAD_BYTES
  rejectOversizedContentLength(request.headers.get('content-length'), maxRequestBytes)
  const tempBase = path.resolve(runtimeRoot, 'uploads', '.multipart')
  await mkdir(tempBase, { recursive: true })
  const tempDirectory = await mkdtemp(path.join(tempBase, 'request-'))
  const fields = new Map<string, string>()
  const files = new Map<string, StagedUploadFile[]>()
  const writes: Promise<void>[] = []
  let boundaryError: HttpClientError | null = null

  try {
    const parser = busboy({
      headers: requestHeaders(request.headers),
      preservePath: false,
      limits: {
        fieldNameSize: 128,
        fieldSize: MAX_FIELD_BYTES,
        fields: MAX_FIELDS,
        files: 1,
        // Busboy 在恰好达到 fileSize 时也会标记 limit；多放行 1 字节后再按实际计数判断，
        // 才能保证“等于上限”成功、“超过上限”失败。
        fileSize: maxFileBytes + 1,
        parts: MAX_FIELDS + 1,
        headerPairs: 128,
      },
    })

    parser.on('field', (name, value, info) => {
      if (info.nameTruncated || info.valueTruncated) {
        boundaryError ??= new HttpClientError('上传表单字段超过限制。', 413)
        return
      }
      if (fields.has(name)) {
        boundaryError ??= new HttpClientError(`上传表单字段 '${name}' 重复。`)
        return
      }
      fields.set(name, value)
    })
    parser.on('file', (fieldName, stream, info) => {
      const destination = path.join(tempDirectory, `${randomUUID()}.upload`)
      const hash = createHash('sha256')
      let sizeBytes = 0
      let fileLimitExceeded = false
      stream.once('limit', () => {
        fileLimitExceeded = true
      })
      const hashing = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.byteLength
          hash.update(chunk)
          callback(null, chunk)
        },
      })
      writes.push(
        pipeline(stream, hashing, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
          .then(() => {
            if (fileLimitExceeded || stream.truncated || sizeBytes > maxFileBytes) {
              throw new HttpClientError(`上传文件过大，限制为 ${formatMegabytes(maxFileBytes)}。`, 413)
            }
            const staged: StagedUploadFile = {
              fieldName,
              name: info.filename,
              mediaType: info.mimeType || 'application/octet-stream',
              tempPath: destination,
              sizeBytes,
              contentHash: hash.digest('hex'),
            }
            const current = files.get(fieldName) ?? []
            current.push(staged)
            files.set(fieldName, current)
          }),
      )
    })
    parser.once('partsLimit', () => {
      boundaryError ??= new HttpClientError('上传表单分段数量超过限制。', 413)
    })
    parser.once('filesLimit', () => {
      boundaryError ??= new HttpClientError('一次请求只能上传一个文件。', 413)
    })
    parser.once('fieldsLimit', () => {
      boundaryError ??= new HttpClientError('上传表单字段数量超过限制。', 413)
    })

    const body = Readable.from(readRequestBody(request.body))
    await pipeline(body, new RequestByteLimit(maxRequestBytes), parser)
    await Promise.all(writes)
    if (boundaryError) throw boundaryError

    return {
      field: name => normalizedField(fields.get(name)),
      requireFile: name => {
        const matches = files.get(name) ?? []
        if (matches.length !== 1) throw new HttpClientError(`缺少上传文件字段 '${name}'。`)
        const file = matches[0]
        if (!file) throw new HttpClientError(`缺少上传文件字段 '${name}'。`)
        return file
      },
      dispose: () => rm(tempDirectory, { recursive: true, force: true }),
    }
  } catch (error) {
    await Promise.allSettled(writes)
    await rm(tempDirectory, { recursive: true, force: true })
    if (error instanceof HttpClientError) throw error
    throw new HttpClientError(`Multipart 上传解析失败：${errorMessage(error)}`)
  }
}

class RequestByteLimit extends Transform {
  private bytesRead = 0

  constructor(private readonly limit: number) {
    super()
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.bytesRead += chunk.byteLength
    if (this.bytesRead > this.limit) {
      callback(new HttpClientError(`上传请求体过大，限制为 ${formatMegabytes(this.limit)}。`, 413))
      return
    }
    callback(null, chunk)
  }
}

async function* readRequestBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) return
      yield result.value
    }
  } finally {
    reader.releaseLock()
  }
}

function requestHeaders(headers: Headers): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {}
  headers.forEach((value, name) => {
    result[name.toLowerCase()] = value
  })
  return result
}

function rejectOversizedContentLength(value: string | null, limit: number): void {
  if (!value) return
  const parsed = Number(value)
  if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed > limit) {
    throw new HttpClientError(`上传请求体过大，限制为 ${formatMegabytes(limit)}。`, 413)
  }
}

function normalizedField(value: string | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

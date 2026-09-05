// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron HTTP 数据面网关
//
//   文件:       apiGateway.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import FormData from 'form-data'
import type { ReadStream } from 'node:fs'
import { net } from 'electron'
import { basemapDescriptorSchema } from '@geo-agent-platform/shared-types'
import {
  PLATFORM_DESKTOP_APP_ORIGIN,
  PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME,
} from '@geo-agent-platform/shared-types/product-identity'
import { z } from 'zod'

import {
  DESKTOP_API_RESPONSE_MAX_BYTES,
  desktopApiOperationSchema,
  desktopApiResponseSchema,
  desktopUploadOperationSchema,
  type DesktopApiOperation,
  type DesktopApiResponse,
  type DesktopUploadOperation,
} from '../contracts/desktopIpc.js'
import type { DesktopAuthorizationContext } from './authGateway.js'
import { readBoundedResponseText } from './boundedResponseBody.js'
import type { FileHandleRegistry } from './fileHandleRegistry.js'
import { writeMultipartRequestBody } from './multipartRequestWriter.js'

export class DesktopApiGateway {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly auth: DesktopApiAuthorization,
  ) {}

  async request(input: DesktopApiOperation): Promise<DesktopApiResponse> {
    const operation = desktopApiOperationSchema.parse(input)
    const headers = new Headers(operation.headers)
    this.attachMainOwnedAuthorization(headers, operation.method)
    headers.set('accept', headers.get('accept') || 'application/json')
    const response = await net.fetch(new URL(operation.path, `${this.apiBaseUrl}/`).toString(), {
      method: operation.method,
      headers,
      ...(operation.body === null ? {} : { body: operation.body }),
    })
    if (response.status === 401) this.auth.invalidateAuthorizationContext()
    const responseHeaders: Record<string, string> = {}
    for (const [name, value] of response.headers.entries()) {
      if (isSafeResponseHeader(name)) responseHeaders[name] = value
    }
    const responseBody = await readBoundedResponseText(
      response,
      DESKTOP_API_RESPONSE_MAX_BYTES,
      '桌面 API 响应',
    )
    return desktopApiResponseSchema.parse({
      status: response.status,
      headers: responseHeaders,
      body: rewriteDesktopResourcePayload(operation.path, responseBody, response.headers),
    })
  }

  async upload(
    ownerWebContentsId: number,
    input: DesktopUploadOperation,
    files: FileHandleRegistry,
  ): Promise<DesktopApiResponse> {
    const operation = desktopUploadOperationSchema.parse(input)
    const form = new FormData()
    for (const field of operation.fields) form.append(field.name, field.value)
    const openedStreams: ReadStream[] = []
    try {
      for (const file of operation.files) {
        const opened = await files.openForUpload(
          ownerWebContentsId,
          file.handleId,
          file.fileName,
        )
        openedStreams.push(opened.stream)
        form.append(file.fieldName, opened.stream, {
          filename: file.fileName,
          contentType: file.mediaType || 'application/octet-stream',
          knownLength: opened.sizeBytes,
        })
      }
    } catch (error) {
      for (const stream of openedStreams) stream.destroy()
      throw error
    }
    const headers: Record<string, string> = {
      ...form.getHeaders(),
      accept: operation.headers.accept ?? 'application/json',
    }
    const protectedHeaders = new Headers(headers)
    this.attachMainOwnedAuthorization(protectedHeaders, 'POST')
    const request = net.request({
      method: 'POST',
      url: new URL(operation.path, `${this.apiBaseUrl}/`).toString(),
    })
    request.chunkedEncoding = true
    for (const [name, value] of protectedHeaders.entries()) request.setHeader(name, value)
    const responsePromise = new Promise<DesktopApiResponse>((resolve, reject) => {
      request.on('response', (response) => {
        if (response.statusCode === 401) this.auth.invalidateAuthorizationContext()
        const chunks: Buffer[] = []
        let totalBytes = 0
        response.on('data', (chunk: Buffer) => {
          totalBytes += chunk.byteLength
          if (totalBytes > 32 * 1024 * 1024) {
            request.abort()
            reject(new Error('上传响应超过 32 MiB 安全上限。'))
            return
          }
          chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          const responseHeaders: Record<string, string> = {}
          for (const [name, value] of Object.entries(response.headers)) {
            if (isSafeResponseHeader(name) && typeof value === 'string') responseHeaders[name] = value
          }
          resolve(desktopApiResponseSchema.parse({
            status: response.statusCode,
            headers: responseHeaders,
            body: Buffer.concat(chunks).toString('utf8'),
          }))
        })
      })
      request.on('error', reject)
      form.on('error', reject)
    })
    try {
      await writeMultipartRequestBody(form, request)
      request.end()
      return await responsePromise
    } catch (error) {
      request.abort()
      for (const stream of openedStreams) stream.destroy()
      throw error
    }
  }

  private attachMainOwnedAuthorization(
    headers: Headers,
    method: DesktopApiOperation['method'],
  ): void {
    headers.set('origin', PLATFORM_DESKTOP_APP_ORIGIN)
    const cookie = this.auth.cookieHeader()
    if (cookie) headers.set('cookie', cookie)
    if (method === 'GET') return
    headers.set(
      'x-geo-agent-platform-csrf',
      this.auth.requireAuthorizationContext().csrfToken,
    )
  }
}

export interface DesktopApiAuthorization {
  cookieHeader(): string
  requireAuthorizationContext(): DesktopAuthorizationContext
  invalidateAuthorizationContext(): void
}

function isSafeResponseHeader(name: string): boolean {
  return name === 'content-type'
    || name === 'content-length'
    || name === 'cache-control'
    || name === 'etag'
    || name === 'x-geo-agent-platform-trace-id'
}

function rewriteDesktopResourcePayload(pathname: string, body: string, headers: Headers): string {
  if (!headers.get('content-type')?.includes('application/json')) return body
  try {
    const payload: unknown = JSON.parse(body)
    if (pathname === '/api/v1/map/basemaps') {
      const basemaps = z.array(basemapDescriptorSchema).parse(payload)
      return JSON.stringify(basemaps.map(basemap => ({
        ...basemap,
        tileUrls: basemap.tileUrls.map(rewriteResourceUrl),
        labelTileUrls: basemap.labelTileUrls.map(rewriteResourceUrl),
      })))
    }
    return body
  } catch {
    return body
  }
}

function rewriteResourceUrl(value: string): string {
  if (/^\/api\/v1\/(?:map|results|artifacts)\//u.test(value)) {
    return `${PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME}://api${value}`
  }
  return value
}

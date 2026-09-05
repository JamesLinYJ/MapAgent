// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面受控资源协议
//
//   文件:       resourceProtocol.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { net, protocol } from 'electron'
import {
  PLATFORM_DESKTOP_APP_ORIGIN,
  PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME,
} from '@geo-agent-platform/shared-types/product-identity'

import type { DesktopAuthGateway } from './authGateway.js'
import {
  projectDesktopApiResourceRequest,
  projectMapTileJsonForDesktop,
} from './mapResourceProtocolProjection.js'

export async function installResourceProtocol(
  apiBaseUrl: string,
  auth: DesktopAuthGateway,
): Promise<void> {
  protocol.handle(PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME, async (request) => {
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
    const url = new URL(request.url)
    if (url.username || url.password || url.hash) {
      return new Response('Bad Request', { status: 400 })
    }
    if (url.hostname === 'api') return fetchAuthenticatedApiResource(url, apiBaseUrl, auth)
    return new Response('Not Found', { status: 404 })
  })
}

async function fetchAuthenticatedApiResource(
  url: URL,
  apiBaseUrl: string,
  auth: DesktopAuthGateway,
): Promise<Response> {
  const projection = projectDesktopApiResourceRequest(url)
  if (!projection) {
    return new Response('Forbidden', { status: 403 })
  }
  const headers = new Headers({
    accept: '*/*',
    origin: PLATFORM_DESKTOP_APP_ORIGIN,
  })
  const cookie = auth.cookieHeader()
  if (cookie) headers.set('cookie', cookie)
  const response = await net.fetch(
    new URL(projection.targetPath, `${apiBaseUrl}/`).toString(),
    { headers },
  )
  return projectAuthenticatedApiResponse(response)
}

function withResourceCors(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', '*')
  headers.set('x-content-type-options', 'nosniff')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function projectAuthenticatedApiResponse(response: Response): Promise<Response> {
  if (
    !response.ok
    || !response.headers.get('content-type')?.includes('application/json')
  ) {
    return withResourceCors(response)
  }
  try {
    const projected = projectMapTileJsonForDesktop(await response.clone().json())
    if (!projected) return withResourceCors(response)
    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete('content-length')
    responseHeaders.delete('content-encoding')
    responseHeaders.set('content-type', 'application/json; charset=utf-8')
    return withResourceCors(new Response(JSON.stringify(projected), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    }))
  } catch {
    return withResourceCors(response)
  }
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 应用资源协议
//
//   文件:       appProtocol.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { app, net, protocol } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PLATFORM_DESKTOP_PROTOCOL_SCHEME,
  PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME,
} from '@geo-agent-platform/shared-types/product-identity'

export function registerPrivilegedAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLATFORM_DESKTOP_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: true,
      },
    },
    {
      scheme: PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

export async function installAppProtocol(): Promise<void> {
  const rendererRoot = path.resolve(app.getAppPath(), 'out', 'renderer')
  protocol.handle(PLATFORM_DESKTOP_PROTOCOL_SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'app') return new Response('Not Found', { status: 404 })
    const relativePath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    if (
      relativePath.includes('\0')
      || relativePath.includes('\\')
      || /(^|\/)\.\.?($|\/)/u.test(relativePath)
    ) {
      return new Response('Bad Request', { status: 400 })
    }
    const absolutePath = path.resolve(rendererRoot, `.${relativePath}`)
    if (!isInside(rendererRoot, absolutePath)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(absolutePath).toString())
  })
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面导出认证边界测试
//
//   文件:       exportService.auth.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({
  destination: '',
  fetch: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: {
    showSaveDialog: vi.fn(async () => ({
      canceled: false,
      filePath: electronState.destination,
    })),
  },
  net: {
    fetch: electronState.fetch,
  },
}))

import {
  buildDesktopReportHtml,
  DesktopExportService,
  type DesktopExportAuthorization,
} from './exportService.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  electronState.fetch.mockReset()
  await Promise.all(temporaryDirectories.splice(0).map(
    directory => rm(directory, { recursive: true, force: true }),
  ))
})

describe('DesktopExportService authorization', () => {
  it('builds a CSP-locked A4 report document instead of serializing the workbench', () => {
    const html = buildDesktopReportHtml({
      ...exportSource(),
      title: '杭州</title><script>alert(1)</script>',
      conversationMarkdown: '# 结论\n\n<script>不应执行</script>',
    }, Buffer.from([137, 80, 78, 71]))
    expect(html).toContain('@page { size: A4;')
    expect(html).toContain('对话与结论')
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('workbench')
  })

  it('accepts no Renderer CSRF field and injects Main-owned CSRF for the audit write', async () => {
    const destination = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-export-auth-'))
    temporaryDirectories.push(destination)
    electronState.destination = path.join(destination, '认证边界测试.pdf')
    electronState.fetch.mockImplementation(async (url: string | URL) => {
      if (String(url).includes('/api/v1/desktop/exports/source?')) {
        return new Response(JSON.stringify(exportSource()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ recorded: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const authorization: DesktopExportAuthorization = {
      cookieHeader: () => 'better-auth.session_token=main-only-cookie',
      requireAuthorizationContext: () => ({
        userId: 'user_1',
        csrfToken: 'main-only-csrf',
        revision: 1,
      }),
      invalidateAuthorizationContext: vi.fn(),
    }
    const service = new DesktopExportService(
      'http://127.0.0.1:8000',
      authorization,
      async () => Buffer.from('%PDF-1.7\n'),
    )

    const result = await service.create(fakeWindow(), {
      workspaceId: 'workspace_1',
      sessionId: 'session_1',
      threadId: 'thread_1',
      title: '认证边界测试',
      formats: ['pdf'],
      artifactIds: [],
    })

    expect(result.canceled).toBe(false)
    const auditCall = electronState.fetch.mock.calls.find(
      call => String(call[0]).endsWith('/api/v1/desktop/exports/audit'),
    )
    expect(auditCall).toBeDefined()
    const headers = new Headers(auditCall?.[1]?.headers)
    expect(headers.get('cookie')).toBe('better-auth.session_token=main-only-cookie')
    expect(headers.get('x-geo-agent-platform-csrf')).toBe('main-only-csrf')
    expect(JSON.stringify(result)).not.toContain('main-only-csrf')
    expect(JSON.stringify(result)).not.toContain('main-only-cookie')
  })

  it('writes openable PDF, PNG and ZIP signatures with a verifiable artifact hash', async () => {
    const destination = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-export-package-'))
    temporaryDirectories.push(destination)
    electronState.destination = path.join(destination, '完整成果.zip')
    const artifactContent = Buffer.from('{"type":"FeatureCollection","features":[]}')
    electronState.fetch.mockImplementation(async (url: string | URL) => {
      const value = String(url)
      if (value.includes('/api/v1/desktop/exports/source?')) {
        return new Response(JSON.stringify(exportSource()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (value.endsWith('/api/v1/results/artifact_1/metadata')) {
        return new Response(JSON.stringify({
          artifactId: 'artifact_1',
          artifactType: 'geojson',
          name: '风险区划',
          uri: 'artifact://artifact_1',
          display: {
            surfaces: ['download'],
            primarySurface: 'download',
            map: null,
          },
          metadata: {},
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (value.endsWith('/api/v1/results/artifact_1/file')) {
        return new Response(artifactContent, {
          status: 200,
          headers: { 'content-type': 'application/geo+json' },
        })
      }
      return new Response(JSON.stringify({ recorded: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const authorization: DesktopExportAuthorization = {
      cookieHeader: () => 'better-auth.session_token=main-only-cookie',
      requireAuthorizationContext: () => ({
        userId: 'user_1',
        csrfToken: 'main-only-csrf',
        revision: 1,
      }),
      invalidateAuthorizationContext: vi.fn(),
    }
    const service = new DesktopExportService(
      'http://127.0.0.1:8000',
      authorization,
      async () => Buffer.from('%PDF-1.7\nProductFixture\n%%EOF\n'),
    )

    const result = await service.create(fakeWindow(), {
      workspaceId: 'workspace_1',
      sessionId: 'session_1',
      threadId: 'thread_1',
      title: '完整成果',
      formats: ['pdf', 'png', 'zip'],
      artifactIds: ['artifact_1'],
    })

    const pdf = await readFile(path.join(destination, '完整成果.pdf'))
    const png = await readFile(path.join(destination, '完整成果.png'))
    const zip = await readFile(path.join(destination, '完整成果.zip'))
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    expect(result.manifest?.files).toContainEqual(expect.objectContaining({
      name: 'artifacts/artifact_1-风险区划.geojson',
      sizeBytes: artifactContent.byteLength,
      sha256: createHash('sha256').update(artifactContent).digest('hex'),
    }))
  })
})

function exportSource() {
  return {
    workspaceId: 'workspace_1',
    sessionId: 'session_1',
    threadId: 'thread_1',
    title: '认证边界测试',
    conversationMarkdown: '# 认证边界测试\n',
    mapScene: {
      sceneId: 'scene_1',
      workspaceId: 'workspace_1',
      threadId: 'thread_1',
      version: 1,
      layers: [],
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
    },
  }
}

function fakeWindow(): BrowserWindow {
  return {
    getContentSize: () => [1200, 800],
    webContents: {
      executeJavaScript: async () => ({ x: 0, y: 0, width: 640, height: 480 }),
      capturePage: async () => ({
        toPNG: () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
      }),
    },
  } as unknown as BrowserWindow
}

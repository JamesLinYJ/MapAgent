// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面成果导出服务
//
//   文件:       exportService.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { ZipArchive } from 'archiver'
import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { BrowserWindow, dialog, net } from 'electron'
import { secureWebPreferences } from './secureWebPreferences.js'
import {
  artifactHttpMetadataSchema,
  desktopExportAuditRequestSchema,
  desktopExportAuditResultSchema,
  desktopExportSourceSchema,
  PLATFORM_DESKTOP_APP_ORIGIN,
  PRODUCT_CODENAME,
  type DesktopExportSource,
} from '@geo-agent-platform/shared-types'

import {
  desktopExportRequestSchema,
  desktopExportResultSchema,
  type DesktopExportManifest,
  type DesktopExportRequest,
  type DesktopExportResult,
} from '../contracts/desktopIpc.js'
import type { DesktopAuthorizationContext } from './authGateway.js'
import { readBoundedResponseText } from './boundedResponseBody.js'
import { buildDesktopExportManifest } from './exportManifest.js'
import { writeResponseBodyToFile } from './responseBodyWriter.js'

export class DesktopExportService {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly auth: DesktopExportAuthorization,
    private readonly printReport: DesktopReportPrinter = printDesktopReport,
  ) {}

  async create(window: BrowserWindow, input: DesktopExportRequest): Promise<DesktopExportResult> {
    const request = desktopExportRequestSchema.parse(input)
    const outputPaths = await chooseOutputPaths(window, request)
    if (!outputPaths) {
      return desktopExportResultSchema.parse({
        canceled: true,
        exportedFiles: [],
        manifest: null,
      })
    }
    const exportedFiles: DesktopExportResult['exportedFiles'] = []
    const createdOutputPaths: string[] = []
    const staging = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-export-'))
    try {
      const [source, mapImage] = await Promise.all([
        this.fetchExportSource(request),
        captureMap(window),
      ])
      const mapPreview = mapImage.toPNG()
      let manifest: DesktopExportManifest | null = null
      if (request.formats.includes('pdf')) {
        const pdfPath = requiredOutputPath(outputPaths, 'pdf')
        await writeFile(pdfPath, await this.printReport(source, mapPreview), { flag: 'wx' })
        createdOutputPaths.push(pdfPath)
        exportedFiles.push({ kind: 'pdf', displayName: path.basename(pdfPath) })
      }
      if (request.formats.includes('png')) {
        const pngPath = requiredOutputPath(outputPaths, 'png')
        await writeFile(pngPath, mapPreview, { flag: 'wx' })
        createdOutputPaths.push(pngPath)
        exportedFiles.push({ kind: 'png', displayName: path.basename(pngPath) })
      }
      if (request.formats.includes('zip')) {
        const sourceFiles = await this.createSourceFiles(
          request,
          source,
          staging,
          mapPreview,
        )
        manifest = await buildDesktopExportManifest(
          { ...request, title: source.title },
          staging,
          sourceFiles,
        )
        const manifestPath = path.join(staging, 'manifest.json')
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        const zipPath = requiredOutputPath(outputPaths, 'zip')
        await archiveDirectory(staging, zipPath)
        createdOutputPaths.push(zipPath)
        exportedFiles.push({ kind: 'zip', displayName: path.basename(zipPath) })
      }
      const result = desktopExportResultSchema.parse({
        canceled: false,
        exportedFiles,
        manifest,
      })
      await this.recordAudit(request, result)
      return result
    } catch (error) {
      await Promise.all(createdOutputPaths.map(file => rm(file, { force: true })))
      throw error
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  private async createSourceFiles(
    request: DesktopExportRequest,
    source: DesktopExportSource,
    staging: string,
    mapPreview: Buffer,
  ): Promise<string[]> {
    const markdownPath = path.join(staging, 'conversation.md')
    const scenePath = path.join(staging, 'map-scene.json')
    const previewPath = path.join(staging, 'map-preview.png')
    await Promise.all([
      writeFile(markdownPath, source.conversationMarkdown, 'utf8'),
      writeFile(scenePath, `${JSON.stringify(source.mapScene, null, 2)}\n`, 'utf8'),
      writeFile(previewPath, mapPreview),
    ])
    const artifactFiles = await this.downloadArtifacts(request, staging)
    return [markdownPath, scenePath, previewPath, ...artifactFiles]
  }

  private async fetchExportSource(
    request: DesktopExportRequest,
  ): Promise<DesktopExportSource> {
    const query = new URLSearchParams({
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      threadId: request.threadId,
    })
    const response = await this.fetchApi(`/api/v1/desktop/exports/source?${query}`)
    if (!response.ok) throw await responseError(response, '成果导出源读取失败')
    const source = desktopExportSourceSchema.parse(JSON.parse(
      await readBoundedResponseText(
        response,
        12 * 1024 * 1024,
        '成果导出源响应',
      ),
    ) as unknown)
    if (
      source.workspaceId !== request.workspaceId
      || source.sessionId !== request.sessionId
      || source.threadId !== request.threadId
    ) {
      throw new Error('成果导出源返回了不一致的资源身份。')
    }
    return source
  }

  private async downloadArtifacts(
    request: DesktopExportRequest,
    staging: string,
  ): Promise<string[]> {
    if (request.artifactIds.length === 0) return []
    const directory = path.join(staging, 'artifacts')
    await mkdir(directory, { recursive: true })
    const files: string[] = []
    for (const artifactId of request.artifactIds) {
      const metadataResponse = await this.fetchApi(
        `/api/v1/results/${encodeURIComponent(artifactId)}/metadata`,
      )
      if (!metadataResponse.ok) throw await responseError(metadataResponse, `Artifact '${artifactId}' 元数据读取失败`)
      const metadata = artifactHttpMetadataSchema.parse(JSON.parse(
        await readBoundedResponseText(
          metadataResponse,
          1024 * 1024,
          `Artifact '${artifactId}' 元数据响应`,
        ),
      ) as unknown)
      if (metadata.artifactId !== artifactId) {
        throw new Error(`Artifact '${artifactId}' 元数据身份不一致。`)
      }
      const fileName = artifactFileName(metadata.name, metadata.artifactType, artifactId)
      const filePath = await uniqueOutputPath(directory, fileName)
      const contentResponse = await this.fetchApi(
        `/api/v1/results/${encodeURIComponent(artifactId)}/file`,
      )
      if (!contentResponse.ok) throw await responseError(contentResponse, `Artifact '${artifactId}' 下载失败`)
      await writeResponseBodyToFile(contentResponse, filePath)
      files.push(filePath)
    }
    return files
  }

  private async recordAudit(
    request: DesktopExportRequest,
    result: DesktopExportResult,
  ): Promise<void> {
    const payload = desktopExportAuditRequestSchema.parse({
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      threadId: request.threadId,
      title: request.title,
      formats: request.formats,
      artifactIds: request.artifactIds,
      files: result.exportedFiles,
    })
    const response = await this.fetchApi('/api/v1/desktop/exports/audit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw await responseError(response, '成果导出审计写入失败')
    desktopExportAuditResultSchema.parse(JSON.parse(
      await readBoundedResponseText(
        response,
        64 * 1024,
        '成果导出审计响应',
      ),
    ) as unknown)
  }

  private async fetchApi(relativePath: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers)
    headers.set('origin', PLATFORM_DESKTOP_APP_ORIGIN)
    const cookie = this.auth.cookieHeader()
    if (cookie) headers.set('cookie', cookie)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      headers.set(
        'x-geo-agent-platform-csrf',
        this.auth.requireAuthorizationContext().csrfToken,
      )
    }
    const response = await net.fetch(new URL(relativePath, `${this.apiBaseUrl}/`).toString(), {
      ...init,
      cache: 'no-store',
      headers,
    })
    if (response.status === 401) this.auth.invalidateAuthorizationContext()
    return response
  }
}

export interface DesktopExportAuthorization {
  cookieHeader(): string
  requireAuthorizationContext(): DesktopAuthorizationContext
  invalidateAuthorizationContext(): void
}

export type DesktopReportPrinter = (
  source: DesktopExportSource,
  mapPreview: Buffer,
) => Promise<Buffer>

async function captureMap(window: BrowserWindow) {
  const rawViewport = await window.webContents.executeJavaScript(`
    (() => {
      const element = document.querySelector('[data-geo-agent-platform-export-map]')
      if (!(element instanceof HTMLElement)) return null
      const rectangle = element.getBoundingClientRect()
      if (rectangle.width < 2 || rectangle.height < 2) return null
      return {
        x: Math.max(0, Math.floor(rectangle.x)),
        y: Math.max(0, Math.floor(rectangle.y)),
        width: Math.ceil(rectangle.width),
        height: Math.ceil(rectangle.height),
      }
    })()
  `, true)
  const mapViewport = parseMapViewport(rawViewport)
  if (!mapViewport) {
    throw new Error('当前地图文档尚未完成布局，无法生成可核验的地图 PNG。请稍后重试。')
  }
  const contentSize = window.getContentSize()
  const contentWidth = contentSize[0]
  const contentHeight = contentSize[1]
  if (!contentWidth || !contentHeight) throw new Error('桌面窗口内容尺寸不可用。')
  const x = Math.min(mapViewport.x, Math.max(0, contentWidth - 1))
  const y = Math.min(mapViewport.y, Math.max(0, contentHeight - 1))
  const width = Math.min(mapViewport.width, contentWidth - x)
  const height = Math.min(mapViewport.height, contentHeight - y)
  if (width < 2 || height < 2) throw new Error('地图导出区域超出当前窗口内容边界。')
  return window.webContents.capturePage({ x, y, width, height })
}

function parseMapViewport(value: unknown): {
  x: number
  y: number
  width: number
  height: number
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const values = [record.x, record.y, record.width, record.height]
  if (!values.every(item => typeof item === 'number' && Number.isSafeInteger(item))) return null
  const x = record.x as number
  const y = record.y as number
  const width = record.width as number
  const height = record.height as number
  if (x < 0 || y < 0 || width < 2 || height < 2) return null
  if (x > 20_000 || y > 20_000 || width > 20_000 || height > 20_000) return null
  return { x, y, width, height }
}

async function printDesktopReport(
  source: DesktopExportSource,
  mapPreview: Buffer,
): Promise<Buffer> {
  const reportDirectory = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-report-'))
  const reportPath = path.join(reportDirectory, 'report.html')
  const reportWindow = new BrowserWindow({
    show: false,
    width: 794,
    height: 1_123,
    backgroundColor: '#ffffff',
    webPreferences: secureWebPreferences({
      javascript: false,
      spellcheck: false,
    }),
  })
  reportWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    await writeFile(
      reportPath,
      buildDesktopReportHtml(source, mapPreview),
      { encoding: 'utf8', flag: 'wx' },
    )
    await reportWindow.loadFile(reportPath)
    return await reportWindow.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margins: {
        top: 0.4,
        bottom: 0.4,
        left: 0.45,
        right: 0.45,
      },
    })
  } finally {
    if (!reportWindow.isDestroyed()) reportWindow.destroy()
    await rm(reportDirectory, { recursive: true, force: true })
  }
}

export function buildDesktopReportHtml(
  source: DesktopExportSource,
  mapPreview: Buffer,
): string {
  const title = escapeHtml(source.title)
  const transcript = escapeHtml(source.conversationMarkdown)
  const imageSource = `data:image/png;base64,${mapPreview.toString('base64')}`
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
  <title>${title}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #1f3037;
      font: 10.5pt/1.58 "Microsoft YaHei UI", "Segoe UI", sans-serif;
    }
    header {
      padding-bottom: 7mm;
      border-bottom: 1px solid #cbd8dc;
    }
    h1 { margin: 0 0 2mm; color: #123b47; font-size: 20pt; line-height: 1.25; }
    .meta { color: #60747b; font-size: 8.5pt; }
    section { margin-top: 7mm; break-inside: avoid; }
    h2 { margin: 0 0 3mm; color: #1c5968; font-size: 13pt; }
    img {
      display: block;
      width: 100%;
      max-height: 112mm;
      object-fit: contain;
      border: 1px solid #cbd8dc;
      background: #eef5f7;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: inherit;
    }
    footer { margin-top: 8mm; color: #71858c; font-size: 8pt; }
  </style>
</head>
<body>
  <header>
    <h1>${title}</h1>
    <div class="meta">${escapeHtml(PRODUCT_CODENAME)} 可核验分析报告 · 工作区 ${escapeHtml(source.workspaceId)} · 对话 ${escapeHtml(source.threadId)}</div>
  </header>
  <section>
    <h2>当前地图</h2>
    <img src="${imageSource}" alt="当前地图导出预览">
  </section>
  <section>
    <h2>对话与结论</h2>
    <pre>${transcript}</pre>
  </section>
  <footer>本报告由 ${escapeHtml(PRODUCT_CODENAME)} 桌面端从服务器权威对话与地图场景生成，不包含工作台界面或认证信息。</footer>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character)
}

async function uniqueOutputPath(directory: string, requestedName: string): Promise<string> {
  const parsed = path.parse(requestedName)
  for (let index = 0; index < 1_000; index += 1) {
    const suffix = index === 0 ? '' : ` (${index + 1})`
    const candidate = path.join(directory, `${parsed.name}${suffix}${parsed.ext}`)
    try {
      await access(candidate)
    } catch (error) {
      if (filesystemErrorCode(error) === 'ENOENT') return candidate
      throw error
    }
  }
  throw new Error(`导出目录中同名文件过多：${requestedName}`)
}

async function chooseOutputPaths(
  window: BrowserWindow,
  request: DesktopExportRequest,
): Promise<Map<DesktopExportResult['exportedFiles'][number]['kind'], string> | null> {
  const primaryKind = request.formats.includes('zip')
    ? 'zip'
    : request.formats[0]
  if (!primaryKind) throw new Error('没有可保存的成果格式。')
  const safeTitle = sanitizeFileName(request.title)
  const primaryExtension = extensionForKind(primaryKind)
  const choice = await dialog.showSaveDialog(window, {
    title: request.formats.length > 1
      ? `保存 ${PRODUCT_CODENAME} 成果（其他格式将保存到同一目录）`
      : `保存 ${PRODUCT_CODENAME} 成果`,
    defaultPath: `${safeTitle}${primaryExtension}`,
    filters: [{
      name: labelForKind(primaryKind),
      extensions: [primaryExtension.slice(1)],
    }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  })
  if (choice.canceled || !choice.filePath) return null

  const selectedPath = withRequiredExtension(choice.filePath, primaryExtension)
  const directory = path.dirname(selectedPath)
  const selectedBaseName = sanitizeFileName(path.basename(selectedPath, primaryExtension))
  const paths = new Map<DesktopExportResult['exportedFiles'][number]['kind'], string>()
  for (const kind of request.formats) {
    const extension = extensionForKind(kind)
    const requestedPath = kind === primaryKind
      ? selectedPath
      : path.join(directory, `${selectedBaseName}${extension}`)
    paths.set(kind, await uniqueOutputPath(path.dirname(requestedPath), path.basename(requestedPath)))
  }
  return paths
}

function requiredOutputPath(
  paths: ReadonlyMap<DesktopExportResult['exportedFiles'][number]['kind'], string>,
  kind: DesktopExportResult['exportedFiles'][number]['kind'],
): string {
  const outputPath = paths.get(kind)
  if (!outputPath) throw new Error(`导出格式 '${kind}' 缺少保存目标。`)
  return outputPath
}

function extensionForKind(
  kind: DesktopExportResult['exportedFiles'][number]['kind'],
): '.pdf' | '.png' | '.zip' {
  if (kind === 'pdf') return '.pdf'
  if (kind === 'png') return '.png'
  return '.zip'
}

function labelForKind(
  kind: DesktopExportResult['exportedFiles'][number]['kind'],
): string {
  if (kind === 'pdf') return 'PDF 文档'
  if (kind === 'png') return 'PNG 地图'
  return 'ZIP 数据包'
}

function withRequiredExtension(filePath: string, extension: string): string {
  const parsed = path.parse(filePath)
  return parsed.ext.toLowerCase() === extension
    ? filePath
    : path.join(parsed.dir, `${parsed.name}${extension}`)
}

function artifactFileName(name: string, artifactType: string, artifactId: string): string {
  const safeName = sanitizeFileName(name)
  const extension = artifactExtension(artifactType)
  const withExtension = extension && !safeName.toLowerCase().endsWith(extension)
    ? `${safeName}${extension}`
    : safeName
  return `${artifactId.slice(0, 24)}-${withExtension}`
}

function artifactExtension(artifactType: string): string {
  return ({
    geojson: '.geojson',
    raster_png: '.png',
    docx: '.docx',
    xlsx: '.xlsx',
    npz: '.npz',
    audio_mp3: '.mp3',
  } as Record<string, string>)[artifactType] ?? ''
}

async function responseError(response: Response, prefix: string): Promise<Error> {
  const body = (await readBoundedResponseText(
    response,
    64 * 1024,
    `${prefix}错误正文`,
  )).trim()
  let detail = body
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'detail' in parsed) {
      detail = typeof parsed.detail === 'string' ? parsed.detail : body
    }
  } catch {
    // 非 JSON 错误正文按纯文本保留。
  }
  return new Error(`${prefix}（HTTP ${response.status}）${detail ? `：${detail.slice(0, 500)}` : ''}`)
}

function filesystemErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

async function archiveDirectory(sourceDirectory: string, outputPath: string): Promise<void> {
  const output = createWriteStream(outputPath, { flags: 'wx' })
  const archive = new ZipArchive({ zlib: { level: 9 } })
  archive.on('warning', (error: Error & { code?: string }) => {
    output.destroy(error)
  })
  archive.on('error', (error: Error) => output.destroy(error))
  archive.pipe(output)
  try {
    archive.directory(sourceDirectory, false)
    await archive.finalize()
    await finished(output)
  } catch (error) {
    output.destroy()
    await rm(outputPath, { force: true })
    throw error
  }
}

function sanitizeFileName(value: string): string {
  const sanitized = Array.from(value, (character) => (
    character.charCodeAt(0) <= 0x1f || '<>:"/\\|?*'.includes(character)
      ? '-'
      : character
  )).join('')

  const normalized = sanitized
    .replace(/[.\s]+$/gu, '')
    .slice(0, 120)
    || `${PRODUCT_CODENAME}-成果`
  const stem = path.parse(normalized).name
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)
    ? `_${normalized}`
    : normalized
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact HTTP 数据面
//
//   文件:       artifacts.ts
//
//   日期:       2026年06月15日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { SecurityServices } from '../security/routes.js'
import { requireAuth } from '../security/routes.js'
import type { ArtifactReader, ArtifactRecord } from '../store/postgres/artifactRepository.js'

export function artifactRoutes(artifacts: ArtifactReader, runtimeRoot: string, security: SecurityServices) {
  const app = new Hono()

  app.get('/api/v1/results/:artifactId/metadata', async c => {
    const artifact = await artifacts.getArtifact(c.req.param('artifactId'))
    if (!artifact) return c.json({ detail: '产物不存在' }, 404)
    await authorizeArtifact(security, c, artifact, 'read')
    c.header('Cache-Control', 'private, no-store')
    c.header('Pragma', 'no-cache')
    return c.json({
      artifactId: artifact.artifactId,
      artifactType: artifact.artifactType,
      name: artifact.name,
      uri: artifact.uri,
      display: artifact.display,
      metadata: artifact.metadata,
    })
  })

  const sendFile = async (c: { req: { param(name: string): string }; get(key: string): unknown }, download: boolean) => {
    const artifactId = c.req.param('artifactId')
    const artifact = await artifacts.getArtifact(artifactId)
    if (!artifact) return new Response(JSON.stringify({ detail: '产物不存在' }), {
      status: 404,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, no-store',
        Pragma: 'no-cache',
      },
    })
    await authorizeArtifact(security, c, artifact, 'read')
    const filePath = resolveRuntimePath(runtimeRoot, artifact.relativePath)
    const bytes = await readFile(filePath)
    const headers: Record<string, string> = {
      'Content-Type': contentTypeFor(artifact.artifactType),
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
    }
    if (download) headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(artifact.name || artifactId)}"`
    return new Response(bytes, { headers })
  }

  app.get('/api/v1/results/:artifactId/geojson', c => sendFile(c, false))
  // 地图栅格和图表通过此地址内联读取；显式下载只走 artifacts/download。
  app.get('/api/v1/results/:artifactId/file', c => sendFile(c, false))
  app.get('/api/v1/artifacts/:artifactId/download', c => sendFile(c, true))
  return app
}

async function authorizeArtifact(
  security: SecurityServices,
  c: { get(key: string): unknown } | null,
  artifact: ArtifactRecord,
  action: 'read',
): Promise<void> {
  const auth = c ? requireAuth(c) : null
  if (!auth) throw new Error('未登录。')
  await security.authorization.assertResourceWorkspace(auth, 'artifact', action, {
    workspaceId: artifact.workspaceId,
    createdByUserId: artifact.createdByUserId,
    visibility: artifact.visibility,
    resourceId: artifact.artifactId,
  })
}

function resolveRuntimePath(runtimeRoot: string, relativePath: string): string {
  const rootPath = path.resolve(runtimeRoot)
  const filePath = path.resolve(rootPath, relativePath)
  if (filePath !== rootPath && !filePath.startsWith(rootPath + path.sep)) throw new Error('产物路径非法')
  return filePath
}

function contentTypeFor(artifactType: string): string {
  if (artifactType === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (artifactType === 'geojson') return 'application/geo+json'
  if (artifactType === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (artifactType === 'npz') return 'application/octet-stream'
  if (artifactType === 'raster_png') return 'image/png'
  if (artifactType === 'audio_mp3') return 'audio/mpeg'
  return 'application/octet-stream'
}

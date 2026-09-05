// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层 HTTP 数据面
//
//   文件:       layers.ts
//
//   日期:       2026年07月02日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import type { ManagedLayerService } from '../gis/managedLayers/managedLayerService.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import type { Env } from '../framework/env.js'
import type { SecurityServices } from '../security/routes.js'
import { requireAuth } from '../security/routes.js'
import { toFeatureCollection } from '../gis/geojson.js'
import { normalizeGeoJsonToCrs84, type CanonicalGeoJson } from '../gis/geojsonCrs.js'
import { HttpClientError, routeErrorResponse } from './errors.js'
import { parseStreamingMultipart, type StreamingMultipartForm } from './streamingMultipart.js'

interface ImportOptions {
  sourceType: string
  defaultCategory: string
  requireSession: boolean
  layerKey?: string | null
  defaultName?: string | null
  defaultDescription?: string | null
  defaultTags?: string[]
  sessionId?: string | null
  threadId?: string | null
  workspaceId?: string | null
  createdByUserId?: string | null
  visibility?: 'private' | 'workspace' | 'public'
}

export function layerRoutes(
  runtimeRoot: string,
  managedLayers: ManagedLayerService,
  store: PlatformPersistenceFacade,
  security: SecurityServices,
  env: Pick<Env, 'MAX_FILE_UPLOAD_BYTES' | 'MAX_GEOJSON_UPLOAD_BYTES' | 'MAX_GEOJSON_FEATURES' | 'MAX_GEOJSON_COORDINATES'>,
) {
  return new Hono()
    .post('/api/v1/layers/register', async (c) => {
      const auth = requireAuth(c)
      const result = await importLayerFromForm(c.req.raw, runtimeRoot, managedLayers, env, {
        sourceType: 'upload',
        defaultCategory: 'upload',
        requireSession: true,
      }, async sessionId => {
        const session = store.getSession(sessionId)
        await security.authorization.assertResourceWorkspace(auth, 'session', 'update', {
          workspaceId: session.workspaceId,
          createdByUserId: session.createdByUserId,
          visibility: session.visibility,
          resourceId: session.id,
        })
        await security.authorization.enforce(auth, 'layer', 'create', { workspaceId: session.workspaceId ?? auth.defaultWorkspaceId })
        return { workspaceId: session.workspaceId ?? auth.defaultWorkspaceId, createdByUserId: auth.userId }
      })
      if ('error' in result) return c.json({ detail: result.error }, { status: result.status as never })
      if (result.layer.sessionId) await store.updateSession(result.layer.sessionId, { latestUploadedLayerKey: result.layer.layerKey })
      return c.json(result.layer)
    })
    .post('/api/v1/layers/import', async (c) => {
      const auth = requireAuth(c)
      await security.authorization.enforce(auth, 'layer', 'create', { workspaceId: auth.defaultWorkspaceId })
      const result = await importLayerFromForm(c.req.raw, runtimeRoot, managedLayers, env, {
        sourceType: 'managed',
        defaultCategory: 'managed',
        requireSession: false,
        workspaceId: auth.defaultWorkspaceId,
        createdByUserId: auth.userId,
      })
      if ('error' in result) return c.json({ detail: result.error }, { status: result.status as never })
      return c.json(result.layer)
    })
    .post('/api/v1/layers/:layerKey/replace', async (c) => {
      const existing = await managedLayers.getLayer(c.req.param('layerKey'))
      if (!existing) return c.json({ detail: '图层不存在' }, { status: 404 })
      if (existing.readonly) return c.json({ detail: '系统图层为只读，不能替换。' }, { status: 403 })
      const auth = requireAuth(c)
      await security.authorization.assertResourceWorkspace(auth, 'layer', 'update', {
        workspaceId: existing.workspaceId,
        createdByUserId: existing.createdByUserId,
        visibility: existing.visibility,
        resourceId: existing.layerKey,
      })
      const result = await importLayerFromForm(c.req.raw, runtimeRoot, managedLayers, env, {
        layerKey: existing.layerKey,
        sourceType: existing.sourceType,
        defaultCategory: existing.category,
        defaultName: existing.name,
        defaultDescription: existing.description,
        defaultTags: existing.tags,
        sessionId: existing.sessionId,
        threadId: existing.threadId,
        workspaceId: existing.workspaceId,
        createdByUserId: auth.userId,
        visibility: normalizeVisibility(existing.visibility),
        requireSession: false,
      })
      if ('error' in result) return c.json({ detail: result.error }, { status: result.status as never })
      return c.json(result.layer)
    })
}

async function importLayerFromForm(
  request: Request,
  runtimeRoot: string,
  managedLayers: ManagedLayerService,
  env: Pick<Env, 'MAX_FILE_UPLOAD_BYTES' | 'MAX_GEOJSON_UPLOAD_BYTES' | 'MAX_GEOJSON_FEATURES' | 'MAX_GEOJSON_COORDINATES'>,
  opts: ImportOptions,
  resolveOwner?: (sessionId: string) => Promise<{ workspaceId: string; createdByUserId: string } | null>,
) {
  let form: StreamingMultipartForm | null = null
  try {
    form = await parseStreamingMultipart(request, runtimeRoot, env.MAX_GEOJSON_UPLOAD_BYTES)
    const file = form.requireFile('file')
    if (!isSupportedGeoJsonFilename(file.name)) {
      return { error: `当前导入器只支持 GeoJSON/JSON 文件：${file.name}`, status: 415 }
    }
    const sessionId = form.field('sessionId') ?? form.field('session_id') ?? opts.sessionId ?? null
    if (opts.requireSession && !sessionId) return { error: 'sessionId 不能为空。', status: 400 }
    const owner = sessionId && resolveOwner ? await resolveOwner(sessionId) : null
    const threadId = form.field('threadId') ?? form.field('thread_id') ?? opts.threadId ?? null
    const canonicalGeoJson = parseGeoJsonPayload(await parseJsonFile(file.tempPath), env, form.field('crs') ?? undefined)
    const layer = await managedLayers.importGeoJsonLayer({
      layerKey: opts.layerKey ?? null,
      name: form.field('name') ?? opts.defaultName ?? stripExtension(file.name),
      description: form.field('description') ?? opts.defaultDescription ?? '',
      sourceType: opts.sourceType,
      category: form.field('category') ?? opts.defaultCategory,
      status: form.field('status') ?? 'active',
      tags: parseTags(form.field('tags')) ?? opts.defaultTags ?? [],
      sessionId,
      threadId,
      sourceFilename: file.name,
      canonicalGeoJson,
      workspaceId: owner?.workspaceId ?? opts.workspaceId ?? null,
      createdByUserId: owner?.createdByUserId ?? opts.createdByUserId ?? null,
      visibility: opts.visibility ?? 'workspace',
    })
    return { layer }
  } catch (error) {
    const response = routeErrorResponse(error, 'GeoJSON 导入失败。')
    return { error: response.detail, status: response.status }
  } finally {
    await form?.dispose()
  }
}

function parseGeoJsonPayload(
  value: unknown,
  env: Pick<Env, 'MAX_GEOJSON_FEATURES' | 'MAX_GEOJSON_COORDINATES'>,
  declaredCrs?: string,
): CanonicalGeoJson {
  let canonical: CanonicalGeoJson
  try {
    canonical = normalizeGeoJsonToCrs84(value, 'GeoJSON', declaredCrs)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new HttpClientError(`GeoJSON 内容格式无效：${detail}`, 422)
  }
  const collection = toFeatureCollection(canonical.entity)
  const features = collection.features
  if (features.length > env.MAX_GEOJSON_FEATURES) {
    throw new HttpClientError(`GeoJSON feature 数量超过限制：${features.length}/${env.MAX_GEOJSON_FEATURES}`, 413)
  }
  const coordinateCount = features.reduce((sum, feature) => sum + countCoordinates(feature.geometry), 0)
  if (coordinateCount > env.MAX_GEOJSON_COORDINATES) {
    throw new HttpClientError(`GeoJSON 坐标数量超过限制：${coordinateCount}/${env.MAX_GEOJSON_COORDINATES}`, 413)
  }
  return canonical
}

async function parseJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    throw new HttpClientError('GeoJSON 文件不是有效 JSON。', 422)
  }
}

function countCoordinates(geometry: unknown): number {
  if (!isRecord(geometry)) return 0
  if (geometry.type === 'GeometryCollection') {
    return Array.isArray(geometry.geometries) ? geometry.geometries.reduce((sum, child) => sum + countCoordinates(child), 0) : 0
  }
  return countPositionArray(geometry.coordinates)
}

function countPositionArray(value: unknown): number {
  if (!Array.isArray(value)) return 0
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') return 1
  return value.reduce((sum, child) => sum + countPositionArray(child), 0)
}

function isSupportedGeoJsonFilename(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.geojson') || lower.endsWith('.json')
}

function normalizeVisibility(value: unknown): 'private' | 'workspace' | 'public' {
  return value === 'private' || value === 'public' ? value : 'workspace'
}

function parseTags(value: unknown): string[] | null {
  if (typeof value !== 'string') return null
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/u, '') || name
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

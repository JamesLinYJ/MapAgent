// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象数据 HTTP 数据面
//
//   文件:       meteorology.ts
//
//   日期:       2026年06月30日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 气象数据路由只索引当前 runtime 文件对象，不复制二进制数据。
// Agent 工具通过 datasetId / latest_upload 解析到同一条 fileRelativePath。

import { Hono } from 'hono'
import { METEOROLOGICAL_UPLOAD_SUFFIXES } from '@geo-agent-platform/shared-types/meteorology'
import type { Database } from '../db/connection.js'
import type {
MeteorologicalDatasetRecord,
MeteorologicalJobRecord,
} from '../schemas/types.js'
import type { FileLifecyclePort } from '../store/fileLifecycleService.js'
import type { StoredFileEntry } from '../store/fileStore.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import { makeId,nowUtc } from '../utils/ids.js'
import type { SecurityServices } from '../security/routes.js'
import { requireAuth } from '../security/routes.js'
import type { Env } from '../framework/env.js'
import { verifySchema } from '../security/database.js'
import { routeErrorResponse } from './errors.js'
import { parseStreamingMultipart,type StreamingMultipartForm } from './streamingMultipart.js'

const METEOROLOGICAL_TABLES: Record<string, string[]> = {
  platform_meteorological_datasets: [
    'dataset_id', 'workspace_id', 'created_by_user_id', 'visibility',
    'session_id', 'thread_id', 'filename', 'original_filename', 'file_id',
    'file_relative_path', 'size_bytes', 'content_hash', 'media_type', 'status',
    'metadata_json', 'created_at', 'updated_at',
  ],
  platform_meteorological_jobs: [
    'job_id', 'dataset_id', 'workspace_id', 'created_by_user_id',
    'session_id', 'thread_id', 'kind', 'status', 'message',
    'payload_json', 'created_at', 'updated_at', 'completed_at',
  ],
}

// ensureMeteorologicalTables 校验气象表及关键列存在；不再执行任何 DDL。
export async function ensureMeteorologicalTables(db: Database): Promise<void> {
  await verifySchema(db, METEOROLOGICAL_TABLES)
}

export function meteorologyRoutes(
  runtimeRoot: string,
  files: FileLifecyclePort,
  store: PlatformPersistenceFacade,
  security: SecurityServices,
  env: Pick<Env, 'MAX_METEOROLOGY_UPLOAD_BYTES'>,
) {
  const app = new Hono()

  app.get('/api/v1/meteorology/datasets', async c => {
    const auth = requireAuth(c)
    const sessionId = queryString(c.req.query('sessionId') ?? c.req.query('session_id'))
    const threadId = queryString(c.req.query('threadId') ?? c.req.query('thread_id'))
    const filename = queryString(c.req.query('filename'))
    await security.authorization.enforce(auth, 'dataset', 'read', { workspaceId: auth.defaultWorkspaceId })
    const rows = await store.meteorology.listMeteorologicalDatasets({ workspaceId: auth.defaultWorkspaceId, sessionId, threadId, filename })
    return c.json(rows)
  })

  app.post('/api/v1/meteorology/datasets', async c => {
    let form: StreamingMultipartForm | null = null
    try {
      const auth = requireAuth(c)
      form = await parseStreamingMultipart(c.req.raw, runtimeRoot, env.MAX_METEOROLOGY_UPLOAD_BYTES)
      const sessionId = form.field('sessionId') ?? form.field('session_id')
      if (!sessionId) return c.json({ detail: 'sessionId 不能为空。' }, 400)
      const session = store.getSession(sessionId)
      await security.authorization.assertResourceWorkspace(auth, 'session', 'update', {
        workspaceId: session.workspaceId,
        createdByUserId: session.createdByUserId,
        visibility: session.visibility,
        resourceId: session.id,
      })
      await security.authorization.enforce(auth, 'dataset', 'create', { workspaceId: session.workspaceId ?? auth.defaultWorkspaceId })
      const threadId = form.field('threadId') ?? form.field('thread_id')
      if (!threadId) return c.json({ detail: 'threadId 不能为空。' }, 400)
      const thread = store.getThread(threadId)
      if (thread.sessionId !== sessionId) {
        return c.json({ detail: 'threadId 不属于指定 session。' }, 409)
      }
      await security.authorization.assertResourceWorkspace(auth, 'thread', 'update', {
        workspaceId: thread.workspaceId,
        createdByUserId: thread.createdByUserId,
        visibility: thread.visibility,
        resourceId: thread.id,
      })
      const file = form.requireFile('file')
      if (!isSupportedMeteorologicalFilename(file.name)) {
        return c.json({ detail: `不支持的气象数据格式：${file.name}` }, 415)
      }

      const sourceRelativePath = form.field('sourceRelativePath') ?? form.field('relativePath')
      const stored: StoredFileEntry = await files.upload({
        file,
        requestId: form.field('requestId'),
        sourceRelativePath,
        workspaceId: session.workspaceId,
        sessionId,
        threadId,
        createdByUserId: auth.userId ?? thread.createdByUserId,
      })
      const now = nowUtc()
      const dataset: MeteorologicalDatasetRecord = {
        datasetId: makeId('meteorological_dataset'),
        workspaceId: session.workspaceId,
        createdByUserId: auth?.userId ?? session.createdByUserId,
        visibility: 'workspace',
        sessionId,
        threadId,
        filename: stored.name,
        originalFilename: file.name,
        fileId: stored.id,
        fileRelativePath: stored.relativePath,
        sizeBytes: stored.sizeBytes,
        contentHash: stored.contentHash,
        mediaType: stored.mediaType,
        status: 'ready',
        metadata: {
          source: 'upload',
          inputKind: inputKind(stored.name),
          ...(stored.sourceRelativePath ? { sourceRelativePath: stored.sourceRelativePath } : {}),
        },
        createdAt: now,
        updatedAt: now,
      }
      try {
        await store.createMeteorologicalDataset(dataset)
      } catch (error) {
        // Dataset 与会话最新指针在同一事务中提交。事务回滚后显式补偿已经
        // 发布的文件对象，避免留下无索引的 ready 上传。
        try {
          await files.delete(stored.id, threadId)
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            '气象数据索引失败，且上传文件的补偿删除也失败。',
          )
        }
        throw error
      }
      return c.json({ dataset, job: null })
    } catch (error) {
      const response = routeErrorResponse(error, '气象数据上传失败。')
      return c.json({ detail: response.detail }, response.status as never)
    } finally {
      await form?.dispose()
    }
  })

  app.get('/api/v1/meteorology/jobs/:jobId', async c => {
    const job = await store.meteorology.getMeteorologicalJob(c.req.param('jobId'))
    if (!job) return c.json({ detail: '气象处理任务不存在' }, 404)
    await security.authorization.assertResourceWorkspace(requireAuth(c), 'dataset', 'read', {
      workspaceId: job.workspaceId,
      createdByUserId: job.createdByUserId,
      resourceId: job.datasetId,
    })
    return c.json(job)
  })

  app.post('/api/v1/meteorology/datasets/:datasetId/report', async c => {
    const dataset = await store.meteorology.getMeteorologicalDataset(c.req.param('datasetId'))
    if (!dataset) return c.json({ detail: '气象数据集不存在' }, 404)
    const auth = requireAuth(c)
    await security.authorization.assertResourceWorkspace(auth, 'dataset', 'execute', {
      workspaceId: dataset.workspaceId,
      createdByUserId: dataset.createdByUserId,
      visibility: dataset.visibility,
      resourceId: dataset.datasetId,
    })
    const now = nowUtc()
    const payloadResult = await parseJsonObject(c.req.raw)
    if (!payloadResult.ok) return c.json({ detail: payloadResult.detail }, 400)
    const payload = payloadResult.value
    const job: MeteorologicalJobRecord = {
      jobId: makeId('meteorological_job'),
      datasetId: dataset.datasetId,
      workspaceId: dataset.workspaceId,
      createdByUserId: auth?.userId ?? dataset.createdByUserId,
      sessionId: dataset.sessionId,
      threadId: dataset.threadId,
      kind: 'report',
      status: 'queued',
      message: '气象报告任务已创建；报告正文必须由 meteorological_report 工具基于 interpretation_ref 生成。',
      payload,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    await store.meteorology.createMeteorologicalJob(job)
    return c.json(job, 202)
  })

  return app
}

function isSupportedMeteorologicalFilename(name: string): boolean {
  const lower = name.toLowerCase()
  return METEOROLOGICAL_UPLOAD_SUFFIXES.some(suffix => lower.endsWith(suffix))
}

function inputKind(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.bz2')) return 'radar'
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'raster'
  return 'dataset'
}

function queryString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function parseJsonObject(request: Request): Promise<
  { ok: true; value: Record<string, unknown> }
  | { ok: false; detail: string }
> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return { ok: false, detail: '请求体必须是有效的 JSON 对象。' }
  }
  return isRecord(parsed)
    ? { ok: true, value: parsed }
    : { ok: false, detail: '请求体 JSON 顶层必须是对象。' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

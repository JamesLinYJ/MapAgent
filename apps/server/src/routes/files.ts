// +-------------------------------------------------------------------------
//
//   地理智能平台 - 通用线程文件 HTTP 数据面
//
//   文件:       files.ts
//
//   日期:       2026年06月15日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import type { FileLifecyclePort } from '../store/fileLifecycleService.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import type { SecurityServices } from '../security/routes.js'
import { requireAuth } from '../security/routes.js'
import type { Env } from '../framework/env.js'
import { HttpClientError, routeErrorResponse } from './errors.js'
import { parseStreamingMultipart, type StreamingMultipartForm } from './streamingMultipart.js'

export function fileRoutes(
  runtimeRoot: string,
  files: FileLifecyclePort,
  store: PlatformPersistenceFacade,
  security: SecurityServices,
  env: Pick<Env, 'MAX_FILE_UPLOAD_BYTES'>,
) {
  return new Hono()
    .post('/api/v1/files/upload', async (c) => {
      let form: StreamingMultipartForm | null = null
      try {
        const auth = requireAuth(c)
        form = await parseStreamingMultipart(c.req.raw, runtimeRoot, env.MAX_FILE_UPLOAD_BYTES)
        const file = form.requireFile('file')
        const threadId = requireField(form, 'threadId')
        const requestId = form.field('requestId')
        const sourceRelativePath = form.field('sourceRelativePath') ?? form.field('relativePath')
        const thread = store.getThread(threadId)
        await security.authorization.assertResourceWorkspace(auth, 'thread', 'update', {
          workspaceId: thread.workspaceId,
          createdByUserId: thread.createdByUserId,
          visibility: thread.visibility,
          resourceId: thread.id,
        })
        const entry = await files.upload({
          file,
          requestId,
          sourceRelativePath,
          workspaceId: thread.workspaceId,
          sessionId: thread.sessionId,
          threadId: thread.id,
          createdByUserId: thread.createdByUserId,
        })
        return c.json(entry)
      } catch (error) {
        const response = routeErrorResponse(error, '文件上传失败。')
        return c.json({ detail: response.detail }, response.status as never)
      } finally {
        await form?.dispose()
      }
    })
}

function requireField(form: StreamingMultipartForm, name: string): string {
  const value = form.field(name)
  if (!value) throw new HttpClientError(`${name} 不能为空。`)
  return value
}

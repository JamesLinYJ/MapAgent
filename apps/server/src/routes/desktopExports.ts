// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面成果导出审计路由
//
//   文件:       desktopExports.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  desktopExportAuditRequestSchema,
  desktopExportSourceRequestSchema,
  desktopExportSourceSchema,
} from '@geo-agent-platform/shared-types/desktop'
import type {
  AgentThreadRecord,
  SessionRecord,
  TranscriptEntry,
} from '@geo-agent-platform/shared-types'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'

import type { SecurityServices } from '../security/routes.js'
import { requireAuth } from '../security/routes.js'
import type { MapStore } from '../store/postgres/mapStore.js'
import type { AuditStore } from '../store/postgres/auditStore.js'
import type { ArtifactReader } from '../store/postgres/artifactRepository.js'
import type { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'

export interface DesktopExportRouteDependencies {
  artifacts: Pick<ArtifactReader, 'getArtifact'>
  audit: Pick<AuditStore, 'recordEvent'>
  mapStore: Pick<MapStore, 'getScene'>
  security: SecurityServices
  store: Pick<
    PlatformPersistenceFacade,
    'activeTranscript' | 'getSession' | 'getThread'
  >
}

export function desktopExportRoutes(dependencies: DesktopExportRouteDependencies) {
  const {
    artifacts,
    audit,
    mapStore,
    security,
    store,
  } = dependencies
  const app = new Hono()

  app.get(
    '/api/v1/desktop/exports/source',
    zValidator('query', desktopExportSourceRequestSchema, (result, c) => {
      if (!result.success) return c.json({ detail: result.error.issues[0]?.message ?? '导出源参数无效。' }, 400)
    }),
    async c => {
      const payload = c.req.valid('query')
      const scope = await authorizeExportScope(store, security, requireAuth(c), payload)
      if (!scope.matchesRequest) {
        return c.json({ detail: '导出资源的工作区、会话或线程归属不一致。' }, 409)
      }
      const [entries, persistedMapScene] = await Promise.all([
        store.activeTranscript(payload.threadId),
        mapStore.getScene(payload.threadId),
      ])
      const mapScene = persistedMapScene ?? emptyExportMapScene(
        payload.workspaceId,
        scope.thread.id,
      )
      c.header('Cache-Control', 'private, no-store')
      c.header('Pragma', 'no-cache')
      return c.json(desktopExportSourceSchema.parse({
        ...payload,
        title: scope.thread.title,
        conversationMarkdown: renderTranscriptMarkdown(scope.thread.title, entries),
        mapScene,
      }))
    },
  )

  app.post(
    '/api/v1/desktop/exports/audit',
    zValidator('json', desktopExportAuditRequestSchema, (result, c) => {
      if (!result.success) return c.json({ detail: result.error.issues[0]?.message ?? '导出审计参数无效。' }, 400)
    }),
    async c => {
      const auth = requireAuth(c)
      security.auth.requireCsrf(c.req.raw, auth)
      const payload = c.req.valid('json')
      const scope = await authorizeExportScope(store, security, auth, payload)
      if (!scope.matchesRequest) {
        return c.json({ detail: '导出资源的工作区、会话或线程归属不一致。' }, 409)
      }
      for (const artifactId of payload.artifactIds) {
        const artifact = await artifacts.getArtifact(artifactId)
        if (!artifact) {
          return c.json({ detail: `导出成果 '${artifactId}' 不存在。` }, 404)
        }
        await security.authorization.assertResourceWorkspace(auth, 'artifact', 'read', {
          workspaceId: artifact.workspaceId,
          createdByUserId: artifact.createdByUserId,
          visibility: artifact.visibility,
          resourceId: artifact.artifactId,
        })
        if (
          artifact.workspaceId !== payload.workspaceId
          || artifact.threadId !== payload.threadId
        ) {
          return c.json({ detail: `导出成果 '${artifactId}' 不属于当前工作区与对话。` }, 409)
        }
      }
      await audit.recordEvent({
        actorUserId: auth.userId,
        workspaceId: payload.workspaceId,
        action: 'desktop.export',
        objectType: 'thread',
        objectId: payload.threadId,
        outcome: 'allowed',
        metadata: {
          sessionId: payload.sessionId,
          title: scope.thread.title,
          requestedFileTitle: payload.title,
          formats: payload.formats,
          artifactIds: payload.artifactIds,
          files: payload.files,
        },
      })
      return c.json({ recorded: true })
    },
  )
  return app
}

function emptyExportMapScene(workspaceId: string, threadId: string) {
  const now = new Date().toISOString()
  return {
    sceneId: `map_scene_${threadId}`,
    workspaceId,
    threadId,
    version: 1,
    layers: [],
    createdAt: now,
    updatedAt: now,
  }
}

async function authorizeExportScope(
  store: Pick<PlatformPersistenceFacade, 'getSession' | 'getThread'>,
  security: SecurityServices,
  auth: ReturnType<typeof requireAuth>,
  requested: {
    workspaceId: string
    sessionId: string
    threadId: string
  },
): Promise<{
  matchesRequest: boolean
  session: SessionRecord
  thread: AgentThreadRecord
}> {
  const thread = store.getThread(requested.threadId)
  await security.authorization.assertResourceWorkspace(auth, 'thread', 'read', {
    workspaceId: thread.workspaceId,
    createdByUserId: thread.createdByUserId,
    visibility: thread.visibility,
    resourceId: thread.id,
  })
  const session = store.getSession(thread.sessionId)
  return {
    matchesRequest: thread.sessionId === requested.sessionId
      && thread.workspaceId === requested.workspaceId
      && session.id === requested.sessionId
      && session.workspaceId === requested.workspaceId,
    session,
    thread,
  }
}

function renderTranscriptMarkdown(
  title: string,
  entries: readonly TranscriptEntry[],
): string {
  const normalizedTitle = title.replace(/\s+/gu, ' ').trim() || `${PRODUCT_CODENAME} 分析成果`
  const sections: string[] = [`# ${normalizedTitle}`]
  for (const entry of entries) {
    const section = transcriptEntryMarkdown(entry)
    if (section) sections.push(section)
  }
  return `${sections.join('\n\n').trimEnd()}\n`
}

function transcriptEntryMarkdown(entry: TranscriptEntry): string | null {
  if (entry.kind === 'message') {
    const content = textValue(entry.payload.content)
    if (!content) return null
    const role = entry.payload.role === 'user' ? '用户' : PRODUCT_CODENAME
    return `## ${role}\n\n${content}`
  }
  if (entry.kind === 'tool_call') {
    const label = textValue(entry.payload.label) || textValue(entry.payload.name) || '工具调用'
    const status = textValue(entry.payload.ledgerStatus)
    return `### 工具调用：${label}${status ? `（${status}）` : ''}`
  }
  if (entry.kind === 'tool_result') {
    const label = textValue(entry.payload.label) || textValue(entry.payload.name) || '工具'
    const content = textValue(entry.payload.summary) || textValue(entry.payload.content)
    return content ? `### 工具结果：${label}\n\n${content}` : null
  }
  if (entry.kind === 'compact_summary') {
    const summary = textValue(entry.payload.summary) || textValue(entry.payload.content)
    return summary ? `## 历史摘要\n\n${summary}` : null
  }
  return null
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

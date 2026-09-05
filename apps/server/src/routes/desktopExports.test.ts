// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面成果导出审计路由测试
//
//   文件:       desktopExports.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

import type { BetterAuthService } from '../security/authService.js'
import type { AuthorizationService } from '../security/authorizationService.js'
import type { SecurityAdminService } from '../security/adminService.js'
import type { SecurityServices } from '../security/routes.js'
import type { AuthContext } from '../security/types.js'
import { desktopExportRoutes } from './desktopExports.js'

describe('desktop export audit route', () => {
  it('serves canonical transcript and map source after resource authorization', async () => {
    const recordEvent = vi.fn()
    const assertResourceWorkspace = vi.fn().mockResolvedValue(undefined)
    const app = createTestApp(recordEvent, assertResourceWorkspace, vi.fn())

    const response = await app.request(
      '/api/v1/desktop/exports/source?workspaceId=workspace_1&sessionId=session_1&threadId=thread_1',
    )

    expect(response.status).toBe(200)
    const body = await response.json() as {
      conversationMarkdown: string
      mapScene: { sceneId: string }
    }
    expect(body.conversationMarkdown).toContain('## 用户\n\n杭州会下雨吗？')
    expect(body.conversationMarkdown).toContain('### 工具结果：天气查询')
    expect(body.mapScene.sceneId).toBe('scene_1')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(assertResourceWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      'thread',
      'read',
      expect.objectContaining({
        workspaceId: 'workspace_1',
        resourceId: 'thread_1',
      }),
    )
    expect(recordEvent).not.toHaveBeenCalled()
  })

  it('records only schema-valid exports after resource authorization', async () => {
    const recordEvent = vi.fn().mockResolvedValue(undefined)
    const assertResourceWorkspace = vi.fn().mockResolvedValue(undefined)
    const requireCsrf = vi.fn()
    const app = createTestApp(recordEvent, assertResourceWorkspace, requireCsrf)

    const response = await app.request('/api/v1/desktop/exports/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'workspace_1',
        sessionId: 'session_1',
        threadId: 'thread_1',
        title: '短时强降水分析',
        formats: ['pdf', 'png', 'zip'],
        artifactIds: ['artifact_1'],
        files: [
          { kind: 'pdf', displayName: '短时强降水分析.pdf' },
          { kind: 'png', displayName: '短时强降水分析.png' },
          { kind: 'zip', displayName: '短时强降水分析-数据包.zip' },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ recorded: true })
    expect(requireCsrf).toHaveBeenCalledOnce()
    expect(assertResourceWorkspace).toHaveBeenCalledTimes(2)
    expect(assertResourceWorkspace).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'artifact',
      'read',
      expect.objectContaining({ resourceId: 'artifact_1' }),
    )
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'desktop.export',
      objectId: 'thread_1',
      workspaceId: 'workspace_1',
      metadata: expect.objectContaining({
        title: '杭州天气',
        requestedFileTitle: '短时强降水分析',
      }),
    }))
  })

  it('rejects absolute paths and extra audit fields before writing', async () => {
    const recordEvent = vi.fn()
    const app = createTestApp(recordEvent, vi.fn(), vi.fn())
    const response = await app.request('/api/v1/desktop/exports/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'workspace_1',
        sessionId: 'session_1',
        threadId: 'thread_1',
        title: '成果',
        formats: ['zip'],
        artifactIds: [],
        files: [{ kind: 'zip', displayName: '成果.zip', absolutePath: 'C:\\secret\\成果.zip' }],
      }),
    })

    expect(response.status).toBe(400)
    expect(recordEvent).not.toHaveBeenCalled()
  })

  it('rejects a forged session or workspace projection after authorizing the real thread', async () => {
    const recordEvent = vi.fn()
    const assertResourceWorkspace = vi.fn().mockResolvedValue(undefined)
    const app = createTestApp(recordEvent, assertResourceWorkspace, vi.fn())

    const response = await app.request('/api/v1/desktop/exports/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'workspace_other',
        sessionId: 'session_1',
        threadId: 'thread_1',
        title: '伪造导出',
        formats: ['pdf'],
        artifactIds: [],
        files: [{ kind: 'pdf', displayName: '伪造导出.pdf' }],
      }),
    })

    expect(response.status).toBe(409)
    expect(assertResourceWorkspace).toHaveBeenCalledOnce()
    expect(recordEvent).not.toHaveBeenCalled()
  })
})

function createTestApp(
  recordEvent: ReturnType<typeof vi.fn>,
  assertResourceWorkspace: ReturnType<typeof vi.fn>,
  requireCsrf: ReturnType<typeof vi.fn>,
): Hono {
  const app = new Hono()
  const auth: AuthContext = {
    userId: 'user_1',
    subject: 'auth_user_1',
    email: 'admin@example.com',
    displayName: '管理员',
    authSessionId: 'auth_session_1',
    authSessionExpiresAt: null,
    csrfToken: 'csrf_1',
    defaultWorkspaceId: 'workspace_1',
    roles: [{ workspaceId: 'workspace_1', role: 'workspace_admin' }],
  }
  app.use('*', async (context, next) => {
    context.set('auth', auth)
    await next()
  })
  const security: SecurityServices = {
    auth: { requireCsrf } as unknown as BetterAuthService,
    authorization: { assertResourceWorkspace } as unknown as AuthorizationService,
    admin: {} as SecurityAdminService,
  }
  app.route('/', desktopExportRoutes({
    artifacts: {
      getArtifact: async artifactId => artifactId === 'artifact_1'
        ? {
          artifactId,
          runId: 'run_1',
          threadId: 'thread_1',
          runCreatedAt: '2026-07-29T00:00:00.000Z',
          workspaceId: 'workspace_1',
          createdByUserId: 'user_1',
          visibility: 'workspace',
          artifactType: 'geojson',
          name: '风险区划',
          uri: 'artifact://artifact_1',
          display: {},
          metadata: {},
          relativePath: 'artifacts/artifact_1.geojson',
          createdAt: '2026-07-29T00:00:00.000Z',
        }
        : null,
    },
    audit: { recordEvent },
    mapStore: {
      getScene: async () => ({
        sceneId: 'scene_1',
        workspaceId: 'workspace_1',
        threadId: 'thread_1',
        version: 1,
        layers: [],
        createdAt: '2026-07-29T00:00:00.000Z',
        updatedAt: '2026-07-29T00:00:00.000Z',
      }),
    },
    security,
    store: {
      getSession: () => ({
        id: 'session_1',
        workspaceId: 'workspace_1',
        createdByUserId: 'user_1',
        visibility: 'workspace',
        createdAt: '2026-07-29T00:00:00.000Z',
        status: 'active',
        latestThreadId: 'thread_1',
        latestRunId: null,
        latestUploadedLayerKey: null,
        latestMeteorologicalDatasetId: null,
      }),
      getThread: () => ({
        id: 'thread_1',
        sessionId: 'session_1',
        workspaceId: 'workspace_1',
        createdByUserId: 'user_1',
        visibility: 'workspace',
        title: '杭州天气',
        status: 'active',
        createdAt: '2026-07-29T00:00:00.000Z',
        updatedAt: '2026-07-29T00:00:00.000Z',
        latestRunId: null,
        latestUserQuery: null,
        latestAssistantSummary: null,
        latestRunStatus: null,
        latestArtifactId: null,
        latestArtifactName: null,
        historyPreview: null,
        runCount: 1,
        conversationPath: null,
      }),
      activeTranscript: async () => [
        transcriptEntry(1, 'message', { role: 'user', content: '杭州会下雨吗？' }),
        transcriptEntry(2, 'tool_result', {
          name: 'weather_lookup',
          label: '天气查询',
          summary: '预计有阵雨。',
        }),
      ],
    },
  }))
  return app
}

function transcriptEntry(
  seq: number,
  kind: 'message' | 'tool_result',
  payload: Record<string, unknown>,
) {
  return {
    schemaVersion: 2 as const,
    seq,
    entryId: `entry_${seq}`,
    parentEntryId: seq === 1 ? null : `entry_${seq - 1}`,
    logicalParentEntryId: null,
    threadId: 'thread_1',
    runId: 'run_1',
    turnId: 'turn_1',
    kind,
    timestamp: '2026-07-29T00:00:00.000Z',
    payload,
  }
}

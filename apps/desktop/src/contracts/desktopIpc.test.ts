// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面 IPC 信任边界测试
//
//   文件:       desktopIpc.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DESKTOP_API_RESPONSE_MAX_BYTES,
  DESKTOP_CLIPBOARD_TEXT_MAX_BYTES,
  desktopApiOperationSchema,
  desktopApiResponseSchema,
  desktopAuthBootstrapResultSchema,
  desktopAuthCommandSchema,
  desktopAuthProjectionSchema,
  desktopConfirmationRequestSchema,
  desktopClipboardWriteSchema,
  desktopControlRequestSchema,
  desktopControlResponseSchema,
  desktopDownloadRequestSchema,
  desktopExportRequestSchema,
  desktopFileHandleReleaseRequestSchema,
  desktopFileSelectionHandleSchema,
  desktopFileSelectionHandlesSchema,
  desktopFileSelectionRequestSchema,
  desktopImageBlobStageRequestSchema,
  desktopMicrophonePermissionRequestSchema,
  desktopMicrophonePermissionResultSchema,
  desktopMacosCliActionSchema,
  desktopMacosCliStatusSchema,
  desktopProductSetupConnectionSchema,
  desktopProductSetupStatusSchema,
  desktopRendererDiagnosticSchema,
  desktopSupervisorCommandSchema,
  desktopSupervisorLogsQuerySchema,
  desktopSupervisorLogsResponseSchema,
  desktopDiagnosticExportResultSchema,
  desktopTextFileReadRequestSchema,
  desktopTextFileReadResultSchema,
  desktopUploadOperationSchema,
  desktopWindowCommandSchema,
} from './desktopIpc.js'

describe('desktop IPC contracts', () => {
  it('keeps macOS command installation path-free and state capabilities consistent', () => {
    expect(desktopMacosCliActionSchema.safeParse('install').success).toBe(true)
    expect(desktopMacosCliActionSchema.safeParse({
      action: 'install',
      path: '/tmp/attacker',
    }).success).toBe(false)
    expect(desktopMacosCliStatusSchema.safeParse({
      state: 'not_installed',
      commandPath: '/usr/local/bin/geo-agent-platform',
      message: '尚未安装终端命令。',
      canInstall: true,
      canRepair: false,
      canRemove: false,
    }).success).toBe(true)
    expect(desktopMacosCliStatusSchema.safeParse({
      state: 'conflict',
      commandPath: '/tmp/other',
      message: '冲突。',
      canInstall: true,
      canRepair: true,
      canRemove: true,
      target: '/Applications/Other.app',
    }).success).toBe(false)
    expect(desktopMacosCliStatusSchema.safeParse({
      state: 'needs_repair',
      commandPath: '/usr/local/bin/geo-agent-platform',
      message: '需要修复。',
      canInstall: false,
      canRepair: true,
      canRemove: true,
    }).success).toBe(false)
  })

  it.each([
    'https://attacker.invalid/api/v1/auth/me',
    '/api/../secrets',
    '/api/%2e%2e/secrets',
    '/api/v1/files\\..\\secret',
    path.join(os.tmpdir(), 'geo-agent-platform-ipc-fixture', '.env'),
  ])('rejects untrusted API target %s', path => {
    expect(desktopApiOperationSchema.safeParse({
      method: 'GET',
      path,
      body: null,
      headers: {},
    }).success).toBe(false)
  })

  it('allows the public runtime capability handshake through the Main API deputy', () => {
    expect(desktopApiOperationSchema.safeParse({
      method: 'GET',
      path: '/health/capabilities',
      body: null,
      headers: {},
    }).success).toBe(true)
  })

  it('limits native downloads to explicit server-owned resource routes', () => {
    expect(desktopDownloadRequestSchema.safeParse({
      path: '/api/v1/results/artifact_1/file',
      suggestedName: '风险区划.geojson',
    }).success).toBe(true)
    expect(desktopDownloadRequestSchema.safeParse({
      path: '/api/v1/admin/users',
      suggestedName: 'users.json',
    }).success).toBe(false)
  })

  it('does not accept output paths in an export request', () => {
    const request = validExportRequest()
    expect(desktopExportRequestSchema.safeParse(request).success).toBe(true)
    expect(desktopExportRequestSchema.safeParse({
      ...request,
      outputPath: 'C:\\Users\\James\\Desktop\\result.zip',
    }).success).toBe(false)
  })

  it('keeps microphone IPC purpose-fixed and requires an explicit denial reason', () => {
    expect(desktopMicrophonePermissionRequestSchema.safeParse({
      purpose: 'speech-recognition',
    }).success).toBe(true)
    expect(desktopMicrophonePermissionRequestSchema.safeParse({
      purpose: 'camera',
    }).success).toBe(false)
    expect(desktopMicrophonePermissionRequestSchema.safeParse({
      purpose: 'speech-recognition',
      mediaTypes: ['video'],
    }).success).toBe(false)
    expect(desktopMicrophonePermissionResultSchema.safeParse({
      granted: false,
      message: null,
    }).success).toBe(false)
    expect(desktopMicrophonePermissionResultSchema.safeParse({
      granted: true,
      message: null,
    }).success).toBe(true)
  })

  it('keeps Renderer diagnostics narrow and bounded', () => {
    expect(desktopRendererDiagnosticSchema.safeParse({
      level: 'error',
      scope: 'MapErrorBoundary',
      message: '地图模块加载失败。',
      detail: '{"componentStack":"MapPanel"}',
    }).success).toBe(true)
    expect(desktopRendererDiagnosticSchema.safeParse({
      level: 'info',
      scope: 'renderer',
      message: '不允许自由日志级别。',
      detail: null,
    }).success).toBe(false)
    expect(desktopRendererDiagnosticSchema.safeParse({
      level: 'error',
      scope: 'renderer',
      message: '失败',
      detail: null,
      arbitrary: { command: 'shell' },
    }).success).toBe(false)
  })

  it('keeps export control frames small and accepts only canonical resource identities', () => {
    const request = validExportRequest()
    expect(desktopExportRequestSchema.safeParse({
      ...request,
      artifactIds: ['../../secret'],
    }).success).toBe(false)
    expect(desktopExportRequestSchema.safeParse({
      ...request,
      formats: ['zip', 'zip'],
    }).success).toBe(false)
    expect(desktopExportRequestSchema.safeParse({
      ...request,
      title: '大载荷',
      legacyConversationMarkdown: '测'.repeat(70_000),
    }).success).toBe(false)
    expect(desktopControlRequestSchema.safeParse({
      version: 1,
      requestId: crypto.randomUUID(),
      command: 'run:start',
      payload: { content: '测'.repeat(70_000) },
    }).success).toBe(false)
    expect(desktopControlResponseSchema.safeParse({
      version: 1,
      requestId: crypto.randomUUID(),
      ok: true,
      data: { content: '测'.repeat(70_000) },
    }).success).toBe(false)
  })

  it('caps aggregate upload metadata and file filter extensions', () => {
    expect(desktopUploadOperationSchema.safeParse({
      path: '/api/v1/files/upload',
      fields: [{ name: 'description', value: '测'.repeat(70_000) }],
      files: [{
        fieldName: 'file',
        handleId: crypto.randomUUID(),
        fileName: 'radar.bin',
        mediaType: 'application/octet-stream',
      }],
      headers: {},
    }).success).toBe(false)
    expect(desktopFileSelectionRequestSchema.safeParse({
      kind: 'files',
      multiple: true,
      filters: [{
        name: '伪造扩展名',
        extensions: ['a'.repeat(25)],
      }],
    }).success).toBe(false)
  })

  it('keeps native file handles opaque and text reads purpose-bound', () => {
    const handleId = crypto.randomUUID()
    expect(desktopFileSelectionHandleSchema.safeParse({
      handleId,
      name: 'radar.json',
      sizeBytes: 128,
      mediaType: 'application/json',
      relativePath: '演示数据/radar.json',
      modifiedAtMs: 100,
    }).success).toBe(true)
    expect(desktopFileSelectionHandleSchema.safeParse({
      handleId,
      name: 'radar.json',
      sizeBytes: 128,
      mediaType: 'application/json',
      relativePath: 'C:\\Users\\James\\radar.json',
      modifiedAtMs: 100,
    }).success).toBe(false)
    expect(desktopTextFileReadRequestSchema.safeParse({
      handleId,
      expectedName: 'radar.json',
      purpose: 'arbitrary-file-read',
    }).success).toBe(false)
    expect(desktopTextFileReadResultSchema.safeParse({
      name: 'radar.json',
      text: '测'.repeat(20_000),
    }).success).toBe(false)
  })

  it('validates bounded file data without reclassifying it as a control frame', () => {
    const handles = Array.from({ length: 200 }, (_, index) => ({
      handleId: crypto.randomUUID(),
      name: `radar-${index}.json`,
      sizeBytes: 128,
      mediaType: 'application/json',
      relativePath: `${'长目录/'.repeat(60)}radar-${index}.json`,
      modifiedAtMs: 100,
    }))
    expect(new TextEncoder().encode(JSON.stringify(handles)).byteLength).toBeGreaterThan(64 * 1024)
    expect(desktopFileSelectionHandlesSchema.safeParse(handles).success).toBe(true)

    const escapedText = '\\'.repeat(48 * 1024)
    expect(new TextEncoder().encode(escapedText).byteLength).toBe(48 * 1024)
    expect(new TextEncoder().encode(JSON.stringify({
      name: 'automation.json',
      text: escapedText,
    })).byteLength).toBeGreaterThan(64 * 1024)
    expect(desktopTextFileReadResultSchema.safeParse({
      name: 'automation.json',
      text: escapedText,
    }).success).toBe(true)
  })

  it('accepts bounded image ArrayBuffers but rejects Base64 strings and oversized blobs', () => {
    const bytes = new Uint8Array(70 * 1024).buffer
    expect(desktopImageBlobStageRequestSchema.safeParse({
      name: 'map.png',
      mediaType: 'image/png',
      bytes,
    }).success).toBe(true)
    expect(desktopImageBlobStageRequestSchema.safeParse({
      name: 'map.png',
      mediaType: 'image/png',
      bytes: 'data:image/png;base64,iVBORw0KGgo=',
    }).success).toBe(false)
    expect(desktopImageBlobStageRequestSchema.safeParse({
      name: 'map.png',
      mediaType: 'image/png',
      bytes: new ArrayBuffer(20 * 1024 * 1024 + 1),
    }).success).toBe(false)
    expect(desktopFileHandleReleaseRequestSchema.safeParse({
      handleId: crypto.randomUUID(),
    }).success).toBe(true)
    expect(desktopFileHandleReleaseRequestSchema.safeParse({
      handleId: crypto.randomUUID(),
      path: '/tmp/map.png',
    }).success).toBe(false)
  })

  it('caps UTF-8 API response bodies before they cross back into Renderer', () => {
    expect(desktopApiResponseSchema.safeParse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '测'.repeat(Math.floor(DESKTOP_API_RESPONSE_MAX_BYTES / 3) + 1),
    }).success).toBe(false)
  })

  it('allows only the three fixed background services', () => {
    expect(desktopSupervisorCommandSchema.safeParse({
      command: 'restart',
      payload: { target: 'api', operationId: crypto.randomUUID() },
    }).success).toBe(true)
    expect(desktopSupervisorCommandSchema.safeParse({
      command: 'restart',
      payload: { target: 'web', operationId: crypto.randomUUID() },
    }).success).toBe(false)
    expect(desktopSupervisorCommandSchema.safeParse({
      command: 'logs',
      payload: {},
    }).success).toBe(false)
  })

  it('keeps bulk logs and clipboard text out of the 64 KiB control-frame contract', () => {
    const logs = Array.from({ length: 1_000 }, (_, index) => ({
      sequence: index + 1,
      serviceId: 'api' as const,
      component: 'server',
      processId: 42,
      stream: 'stdout' as const,
      level: 'info' as const,
      event: 'request.http.completed',
      category: 'request' as const,
      retention: 'operational' as const,
      correlation: { requestId: `request_${index}` },
      message: `日志 ${index} ${'运行信息'.repeat(30)}`,
      errorStack: null,
      attributes: {},
      createdAt: '2026-07-30T08:00:00.000Z',
    }))
    const serializedLogs = JSON.stringify(logs)
    expect(new TextEncoder().encode(serializedLogs).byteLength).toBeGreaterThan(64 * 1024)
    expect(desktopSupervisorLogsQuerySchema.safeParse({
      services: ['infra', 'worker', 'api'],
      levels: [],
      streams: [],
      categories: [],
      events: [],
      retentions: [],
      correlationId: '',
      search: '',
      includeSupervisor: true,
      afterSequence: null,
      tail: 2_000,
    }).success).toBe(true)
    expect(desktopSupervisorLogsResponseSchema.safeParse({
      entries: logs,
      nextCursor: 1_000,
      hasMore: false,
    }).success).toBe(false)
    expect(desktopControlResponseSchema.safeParse({
      version: 1,
      requestId: crypto.randomUUID(),
      ok: true,
      data: logs,
    }).success).toBe(false)
    expect(desktopClipboardWriteSchema.safeParse({ text: serializedLogs }).success).toBe(true)
    expect(desktopClipboardWriteSchema.safeParse({
      text: '测'.repeat(Math.floor(DESKTOP_CLIPBOARD_TEXT_MAX_BYTES / 3) + 1),
    }).success).toBe(false)
  })

  it('returns only a display name after native diagnostic export', () => {
    expect(desktopDiagnosticExportResultSchema.safeParse({
      canceled: false,
      displayName: 'diagnostics.jsonl',
      entryCount: 12,
    }).success).toBe(true)
    expect(desktopDiagnosticExportResultSchema.safeParse({
      canceled: false,
      displayName: 'diagnostics.jsonl',
      entryCount: 12,
      filePath: 'C:\\private\\diagnostics.jsonl',
    }).success).toBe(false)
  })

  it('opens workspaces by structured identity rather than file path', () => {
    expect(desktopWindowCommandSchema.safeParse({
      action: 'open-workspace',
      workspace: {
        workspaceId: 'workspace_1',
        workspaceName: '气象分析',
        sessionId: null,
        threadId: null,
      },
    }).success).toBe(true)
    expect(desktopWindowCommandSchema.safeParse({
      action: 'open-workspace',
      workspace: {
        workspaceId: 'workspace_1',
        workspaceName: '气象分析',
        sessionId: null,
        threadId: null,
        projectFile: 'C:\\work\\demo.platform',
      },
    }).success).toBe(false)
  })

  it('limits native confirmation dialogs to a fixed two-action contract', () => {
    expect(desktopConfirmationRequestSchema.safeParse({
      title: '切换自动化流程',
      message: '当前更改尚未保存，是否继续？',
      detail: '未保存的更改将被丢弃。',
      confirmLabel: '继续切换',
      cancelLabel: '留在此处',
      tone: 'warning',
    }).success).toBe(true)
    expect(desktopConfirmationRequestSchema.safeParse({
      title: '任意按钮',
      message: '不允许 Renderer 注入任意 Electron 配置。',
      buttons: ['一', '二', '三'],
    }).success).toBe(false)
  })

  it('allows Renderer to request automatic auth without carrying credentials', () => {
    expect(desktopAuthCommandSchema.parse({
      command: 'bootstrap',
      payload: {},
    })).toEqual({ command: 'bootstrap', payload: {} })
    expect(desktopAuthCommandSchema.safeParse({
      command: 'bootstrap',
      payload: { email: 'admin@example.com', password: 'must-not-cross-ipc' },
    }).success).toBe(false)
    expect(desktopAuthBootstrapResultSchema.parse({
      mode: 'local_auto',
      status: 'authenticated',
      message: null,
    })).toEqual({
      mode: 'local_auto',
      status: 'authenticated',
      message: null,
    })
  })

  it('projects identity without accepting CSRF or session material', () => {
    const projection = validAuthProjection()
    expect(desktopAuthProjectionSchema.parse(projection)).toEqual(projection)
    expect(desktopAuthProjectionSchema.safeParse({
      ...projection,
      csrfToken: 'must-stay-in-main',
    }).success).toBe(false)
    expect(desktopAuthCommandSchema.safeParse({
      command: 'session',
      payload: {},
    }).success).toBe(false)
    expect(desktopAuthCommandSchema.safeParse({
      command: 'projection',
      payload: {},
    }).success).toBe(true)
  })

  it('projects only Tianditu configuration state and keeps replacement mutually exclusive with clearing', () => {
    expect(desktopProductSetupStatusSchema.safeParse({
      state: 'configured',
      deploymentMode: 'local_managed',
      apiBaseUrl: 'http://127.0.0.1:8000',
      productName: '本机地理工作台',
      canReset: false,
      canConfigureMapService: true,
      tiandituConfigured: true,
    }).success).toBe(true)
    expect(desktopProductSetupStatusSchema.safeParse({
      state: 'configured',
      deploymentMode: 'local_managed',
      apiBaseUrl: 'http://127.0.0.1:8000',
      productName: '本机地理工作台',
      canReset: false,
      canConfigureMapService: true,
      tiandituConfigured: true,
      tiandituApiKey: 'must-not-cross-ipc',
    }).success).toBe(false)
    expect(desktopProductSetupConnectionSchema.safeParse({
      apiBaseUrl: 'http://127.0.0.1:8000',
      productName: '本机地理工作台',
      tiandituApiKey: 'server-key-fixture-1234',
      clearTiandituApiKey: true,
    }).success).toBe(false)
    expect(desktopProductSetupConnectionSchema.safeParse({
      apiBaseUrl: 'http://127.0.0.1:8000',
      productName: '本机地理工作台',
      clearTiandituApiKey: true,
    }).success).toBe(true)
  })

  it('does not let Renderer address auth sessions or provide CSRF headers', () => {
    expect(desktopApiOperationSchema.safeParse({
      method: 'GET',
      path: '/api/v1/auth/me',
      body: null,
      headers: {},
    }).success).toBe(false)
    expect(desktopApiOperationSchema.safeParse({
      method: 'GET',
      path: '/api/auth/get-session',
      body: null,
      headers: {},
    }).success).toBe(false)
    expect(desktopApiOperationSchema.safeParse({
      method: 'POST',
      path: '/api/v1/admin/users/user_1',
      body: '{}',
      headers: { 'x-geo-agent-platform-csrf': 'renderer-controlled' },
    }).success).toBe(false)
  })

  it('keeps Main-only export and binary routes out of the generic JSON deputy', () => {
    for (const operation of [
      {
        method: 'GET',
        path: '/api/v1/desktop/exports/source?workspaceId=workspace_1&sessionId=session_1&threadId=thread_1',
        body: null,
        headers: {},
      },
      {
        method: 'POST',
        path: '/api/v1/desktop/exports/audit',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      },
      {
        method: 'GET',
        path: '/api/v1/results/artifact_1/file',
        body: null,
        headers: {},
      },
    ] as const) {
      expect(desktopApiOperationSchema.safeParse(operation).success).toBe(false)
    }
  })

  it('binds every generic write route to its method, content type and body schema', () => {
    const valid = {
      method: 'POST',
      path: '/api/v1/admin/workspaces',
      body: JSON.stringify({ name: '演示工作区', description: '短时强降水分析' }),
      headers: { 'content-type': 'application/json' },
    } as const
    expect(desktopApiOperationSchema.safeParse(valid).success).toBe(true)
    expect(desktopApiOperationSchema.safeParse({
      ...valid,
      method: 'GET',
    }).success).toBe(false)
    expect(desktopApiOperationSchema.safeParse({
      ...valid,
      headers: {},
    }).success).toBe(false)
    expect(desktopApiOperationSchema.safeParse({
      ...valid,
      body: JSON.stringify({ name: '', arbitrary: true }),
    }).success).toBe(false)
  })
})

function validExportRequest() {
  return {
    workspaceId: 'workspace_1',
    sessionId: 'session_1',
    threadId: 'thread_1',
    title: '杭州短时强降水分析',
    formats: ['pdf', 'png', 'zip'],
    artifactIds: ['artifact_1'],
  }
}

function validAuthProjection() {
  const now = '2026-07-29T00:00:00.000Z'
  return {
    user: {
      userId: 'user_1',
      subject: 'auth_1',
      email: 'admin@example.com',
      displayName: '管理员',
      status: 'active' as const,
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    },
    defaultWorkspace: {
      workspaceId: 'workspace_1',
      name: '默认工作区',
      description: '',
      status: 'active' as const,
      createdByUserId: 'user_1',
      createdAt: now,
      updatedAt: now,
    },
    memberships: [],
    platformRoles: ['platform_admin' as const],
    permissions: ['workspace:read'],
    requestProtection: 'main_managed' as const,
  }
}

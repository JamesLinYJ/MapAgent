// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面进程间通信契约
//
//   文件:       desktopIpc.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-07-29):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 本地文件边界收敛为 Main 原生选择器与一次性不透明句柄。
//
//   维护记录 (2026-07-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 区分命令控制帧与日志、剪贴板、文件结果等有界数据载荷。
// --------------------------------------------------------------------------

import { z } from 'zod'
import {
PLATFORM_IPC_CHANNEL_PREFIX,
} from '@geo-agent-platform/shared-types/product-identity'
import {
adminMembershipCreateSchema,
adminUserPatchSchema,
adminWorkspaceCreateSchema,
authMeSchema,
workspaceBootstrapSnapshotSchema,
} from '@geo-agent-platform/shared-types'
import {
operationsLogFilterSchema,
operationsLogPageSchema,
operationsLogQuerySchema,
} from '@geo-agent-platform/shared-types/operations'

const DESKTOP_IPC_VERSION = 1 as const
export const DESKTOP_CONTROL_FRAME_MAX_BYTES = 64 * 1024
export const DESKTOP_CONTROL_DECOMPRESSED_MAX_BYTES = 4 * 1024 * 1024
// Renderer 只能发送 64 KiB 的小型命令。Main 返回的只读快照先 gzip，
// 再受独立的压缩载荷上限约束；不得复用请求帧的 64 KiB 上限。
const DESKTOP_COMPRESSED_RESPONSE_MAX_BYTES = 6 * 1024 * 1024
export const DESKTOP_API_RESPONSE_MAX_BYTES = 16 * 1024 * 1024
export const DESKTOP_CLIPBOARD_TEXT_MAX_BYTES = 4 * 1024 * 1024
export const DESKTOP_TEXT_FILE_MAX_BYTES = 48 * 1024
export const DESKTOP_STAGED_IMAGE_MAX_BYTES = 20 * 1024 * 1024
export const DESKTOP_MACOS_CLI_COMMAND_PATH = '/usr/local/bin/geo-agent-platform' as const

export const desktopWorkspaceWindowDescriptorSchema = z.object({
  workspaceId: z.string().trim().min(1).max(160),
  workspaceName: z.string().trim().min(1).max(160),
  sessionId: z.string().trim().min(1).max(160).nullable().default(null),
  threadId: z.string().trim().min(1).max(160).nullable().default(null),
}).strict()

export const desktopMenuCommandSchema = z.enum([
  'new-analysis',
  'open-workspace',
  'focus-command',
  'open-map',
  'open-tools',
  'open-workflow',
  'open-results',
  'open-account',
  'open-security',
  'open-diagnostics',
  'open-system-logs',
  'open-connection-settings',
  'toggle-contents',
  'toggle-assistant',
  'export-results',
])

const desktopTaskbarProgressSchema = z.object({
  state: z.enum(['none', 'indeterminate', 'normal', 'paused', 'error']),
  value: z.number().min(0).max(1).nullable().default(null),
}).strict().superRefine((value, context) => {
  if (value.state === 'normal' && value.value === null) {
    context.addIssue({
      code: 'custom',
      path: ['value'],
      message: '普通任务栏进度必须提供 0 到 1 的进度值。',
    })
  }
})

export const desktopWindowCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('minimize') }).strict(),
  z.object({ action: z.literal('toggle-maximize') }).strict(),
  z.object({ action: z.literal('close') }).strict(),
  z.object({ action: z.literal('show-application-menu') }).strict(),
  z.object({
    action: z.literal('set-taskbar-progress'),
    progress: desktopTaskbarProgressSchema,
  }).strict(),
  z.object({ action: z.literal('open-workspace'), workspace: desktopWorkspaceWindowDescriptorSchema }).strict(),
  z.object({ action: z.literal('bind-workspace'), workspace: desktopWorkspaceWindowDescriptorSchema }).strict(),
  z.object({ action: z.literal('focus-workspace'), workspaceId: z.string().trim().min(1).max(160) }).strict(),
])

export const desktopClipboardWriteSchema = z.object({
  text: z.string().refine(
    value => new TextEncoder().encode(value).byteLength <= DESKTOP_CLIPBOARD_TEXT_MAX_BYTES,
    `桌面剪贴板文本不得超过 ${DESKTOP_CLIPBOARD_TEXT_MAX_BYTES} 字节。`,
  ),
}).strict()

export const desktopConfirmationRequestSchema = z.object({
  title: z.string().trim().min(1).max(80),
  message: z.string().trim().min(1).max(240),
  detail: z.string().trim().max(1_000).nullable().default(null),
  confirmLabel: z.string().trim().min(1).max(40).default('确定'),
  cancelLabel: z.string().trim().min(1).max(40).default('取消'),
  tone: z.enum(['question', 'warning', 'danger']).default('question'),
}).strict()

export const desktopRendererDiagnosticSchema = z.object({
  level: z.enum(['warn', 'error']),
  scope: z.string().trim().min(1).max(80),
  message: z.string().trim().min(1).max(2_000),
  detail: z.string().max(12_000).nullable().default(null),
}).strict().superRefine(enforceDesktopControlFrameSize)

export const desktopMicrophonePermissionRequestSchema = z.object({
  purpose: z.literal('speech-recognition'),
}).strict()

export const desktopMicrophonePermissionResultSchema = z.object({
  granted: z.boolean(),
  message: z.string().trim().min(1).max(500).nullable(),
}).strict().superRefine((value, context) => {
  if (value.granted && value.message !== null) {
    context.addIssue({ code: 'custom', path: ['message'], message: '授权成功时不能返回错误说明。' })
  }
  if (!value.granted && value.message === null) {
    context.addIssue({ code: 'custom', path: ['message'], message: '授权拒绝时必须返回中文原因。' })
  }
})

export const desktopMacosCliActionSchema = z.enum(['install', 'repair', 'remove'])

export const desktopMacosCliStatusSchema = z.object({
  state: z.enum(['unavailable', 'not_installed', 'installed', 'needs_repair', 'conflict']),
  commandPath: z.literal(DESKTOP_MACOS_CLI_COMMAND_PATH),
  message: z.string().trim().min(1).max(500),
  canInstall: z.boolean(),
  canRepair: z.boolean(),
  canRemove: z.boolean(),
}).strict().superRefine((value, context) => {
  const expected = {
    canInstall: value.state === 'not_installed',
    canRepair: value.state === 'needs_repair',
    canRemove: value.state === 'installed',
  }
  for (const field of ['canInstall', 'canRepair', 'canRemove'] as const) {
    if (value[field] !== expected[field]) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: '终端命令操作能力与当前状态不一致。',
      })
    }
  }
})

export const desktopAuthProjectionSchema = authMeSchema
  .omit({ csrfToken: true })
  .extend({
    requestProtection: z.literal('main_managed'),
  })
  .strict()

export const desktopWorkspaceBootstrapSnapshotSchema = workspaceBootstrapSnapshotSchema
  .omit({ auth: true })
  .extend({
    auth: desktopAuthProjectionSchema,
  })
  .strict()

export const desktopAuthBootstrapResultSchema = z.object({
  mode: z.enum(['interactive', 'local_auto']),
  status: z.enum(['ready', 'authenticated', 'failed']),
  message: z.string().trim().min(1).max(800).nullable(),
}).strict()

export const desktopProductSetupStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('required'),
    deploymentMode: z.enum(['local_managed', 'remote']),
    suggestedApiBaseUrl: z.string().url(),
    suggestedProductName: z.string().trim().min(1).max(80),
    canConfigureMapService: z.boolean(),
    tiandituConfigured: z.boolean().nullable(),
  }).strict(),
  z.object({
    state: z.literal('configured'),
    deploymentMode: z.enum(['local_managed', 'remote']),
    apiBaseUrl: z.string().url(),
    productName: z.string().trim().min(1).max(80),
    canReset: z.boolean(),
    canConfigureMapService: z.boolean(),
    tiandituConfigured: z.boolean().nullable(),
  }).strict(),
])

export const desktopProductSetupConnectionSchema = z.object({
  apiBaseUrl: z.string().trim().min(1).max(2_048),
  productName: z.string().trim().min(1).max(80),
  // 只允许 Renderer 向 Main 提交新值；状态响应永不回传凭据。
  tiandituApiKey: z.string().trim().min(16).max(256)
    .regex(/^[A-Za-z0-9_-]+$/u, '天地图 API KEY 格式无效。')
    .optional(),
  clearTiandituApiKey: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.tiandituApiKey && value.clearTiandituApiKey) {
    context.addIssue({
      code: 'custom',
      path: ['clearTiandituApiKey'],
      message: '新天地图 API KEY 与清除操作不能同时使用。',
    })
  }
  enforceDesktopControlFrameSize(value, context)
})

export const desktopProductSetupTestResultSchema = z.object({
  ok: z.boolean(),
  apiBaseUrl: z.string().url(),
  latencyMs: z.number().int().nonnegative(),
  releaseId: z.string().min(1).max(200).nullable(),
  databaseSchemaVersion: z.number().int().nonnegative().nullable(),
  message: z.string().trim().min(1).max(800),
}).strict().superRefine(enforceDesktopControlFrameSize)

export const desktopProductSetupRestartResultSchema = z.object({
  scheduled: z.literal(true),
}).strict()

const safeRelativeApiPathSchema = z.string().trim().min(1).max(2_048).superRefine((value, context) => {
  if (!value.startsWith('/api/') && value !== '/health' && value !== '/health/capabilities') {
    context.addIssue({ code: 'custom', message: '桌面 API 只允许访问 /api/*、/health 或 /health/capabilities。' })
  }
  if (
    value.includes('\\')
    || value.includes('\0')
    || /(^|\/)\.\.?($|\/)/u.test(value)
    || /%2e|%5c/iu.test(value)
    || /^[a-z][a-z0-9+.-]*:/iu.test(value)
  ) {
    context.addIssue({ code: 'custom', message: '桌面 API 路径包含不允许的路径或协议片段。' })
  }
})

export const desktopApiOperationSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: safeRelativeApiPathSchema.refine(
    value => !isPrivateAuthenticationPath(value),
    '认证会话只能通过桌面主进程的认证边界访问。',
  ),
  body: z.string().max(DESKTOP_CONTROL_FRAME_MAX_BYTES).nullable().default(null),
  headers: z.partialRecord(
    z.enum(['accept', 'content-type']),
    z.string().max(4_096),
  ).default({}),
}).strict()
  .superRefine(enforceDesktopApiOperation)
  .superRefine(enforceDesktopControlFrameSize)

export const desktopApiResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
  body: z.string().refine(
    value => new TextEncoder().encode(value).byteLength <= DESKTOP_API_RESPONSE_MAX_BYTES,
    `桌面 API 响应不得超过 ${DESKTOP_API_RESPONSE_MAX_BYTES} 字节。`,
  ),
}).strict()

export const desktopDownloadRequestSchema = z.object({
  path: safeRelativeApiPathSchema.refine(
    value => isAllowedDesktopDownloadPath(value),
    '下载只允许访问结果、Artifact 或地图图层资源。',
  ),
  suggestedName: z.string().trim().min(1).max(255),
}).strict()

export const desktopDownloadResultSchema = z.object({
  canceled: z.boolean(),
  displayName: z.string().trim().min(1).nullable(),
}).strict()

export const desktopUploadOperationSchema = z.object({
  path: safeRelativeApiPathSchema.refine(
    value => !isPrivateAuthenticationPath(value),
    '认证会话只能通过桌面主进程的认证边界访问。',
  ),
  fields: z.array(z.object({
    name: z.string().trim().min(1).max(160),
    value: z.string().max(DESKTOP_CONTROL_FRAME_MAX_BYTES),
  }).strict()).max(100),
  files: z.array(z.object({
    fieldName: z.string().trim().min(1).max(160),
    handleId: z.string().uuid(),
    fileName: z.string().trim().min(1).max(255),
    mediaType: z.string().trim().max(255),
  }).strict()).min(1).max(50),
  headers: z.partialRecord(
    z.enum(['accept']),
    z.string().max(4_096),
  ).default({}),
}).strict()
  .superRefine(enforceDesktopUploadOperation)
  .superRefine(enforceDesktopControlFrameSize)

export const desktopFileSelectionHandleSchema = z.object({
  handleId: z.string().uuid(),
  name: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  mediaType: z.string().trim().max(255),
  relativePath: z.string().trim().min(1).max(2_048).superRefine((value, context) => {
    if (
      value.startsWith('/')
      || value.includes('\\')
      || value.includes('\0')
      || /(^|\/)\.\.?($|\/)/u.test(value)
      || /^[a-z][a-z0-9+.-]*:/iu.test(value)
    ) {
      context.addIssue({
        code: 'custom',
        message: '文件句柄只能携带安全的相对显示路径。',
      })
    }
  }),
  modifiedAtMs: z.number().nonnegative(),
}).strict()

export const desktopFileSelectionHandlesSchema = z.array(
  desktopFileSelectionHandleSchema,
).max(200)

// Renderer 生成的粘贴图片与地图截图走独立的二进制数据 IPC；它不是
// 64 KiB 控制帧，也不允许以 Base64、data URL 或宿主路径的形式进入契约。
// Main 校验魔数并落入一次性临时文件后，只把标准不透明句柄返回 Renderer。
const desktopImageArrayBufferSchema = z.custom<ArrayBuffer>(value => (
  Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  && Number.isInteger((value as ArrayBuffer).byteLength)
  && (value as ArrayBuffer).byteLength > 0
  && (value as ArrayBuffer).byteLength <= DESKTOP_STAGED_IMAGE_MAX_BYTES
), `图片二进制不得为空或超过 ${DESKTOP_STAGED_IMAGE_MAX_BYTES} 字节。`)

export const desktopImageBlobStageRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: desktopImageArrayBufferSchema,
}).strict()

export const desktopFileHandleReleaseRequestSchema = z.object({
  handleId: z.string().uuid(),
}).strict().superRefine(enforceDesktopControlFrameSize)

export const desktopFileSelectionRequestSchema = z.object({
  kind: z.enum(['files', 'folder']),
  multiple: z.boolean().default(true),
  filters: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    extensions: z.array(
      z.string().min(1).max(24).regex(/^[a-z0-9]+$/iu),
    ).min(1).max(40),
  }).strict()).max(20).default([]),
}).strict().superRefine(enforceDesktopControlFrameSize)

export const desktopTextFileReadRequestSchema = z.object({
  handleId: z.string().uuid(),
  expectedName: z.string().trim().min(1).max(255),
  purpose: z.literal('automation-draft-import'),
}).strict().superRefine(enforceDesktopControlFrameSize)

export const desktopTextFileReadResultSchema = z.object({
  name: z.string().trim().min(1).max(255),
  text: z.string().refine(
    value => new TextEncoder().encode(value).byteLength <= DESKTOP_TEXT_FILE_MAX_BYTES,
    `本地文本文件不得超过 ${DESKTOP_TEXT_FILE_MAX_BYTES} 字节。`,
  ),
}).strict()

const desktopExportResourceIdSchema = z.string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u, '导出资源 ID 格式无效。')

export const desktopExportRequestSchema = z.object({
  workspaceId: desktopExportResourceIdSchema,
  sessionId: desktopExportResourceIdSchema,
  threadId: desktopExportResourceIdSchema,
  title: z.string().trim().min(1).max(180),
  formats: z.array(z.enum(['pdf', 'png', 'zip']))
    .min(1)
    .max(3)
    .refine(values => new Set(values).size === values.length, '导出格式不得重复。'),
  artifactIds: z.array(desktopExportResourceIdSchema)
    .max(200)
    .refine(values => new Set(values).size === values.length, 'Artifact ID 不得重复。')
    .default([]),
}).strict().superRefine(enforceDesktopControlFrameSize)

export const desktopExportManifestSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.string().datetime(),
  workspaceId: z.string(),
  sessionId: z.string(),
  threadId: z.string(),
  title: z.string(),
  files: z.array(z.object({
    name: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict()),
}).strict()

export const desktopExportResultSchema = z.object({
  canceled: z.boolean(),
  exportedFiles: z.array(z.object({
    kind: z.enum(['pdf', 'png', 'zip']),
    displayName: z.string(),
  }).strict()),
  manifest: desktopExportManifestSchema.nullable(),
}).strict()

export const desktopControlRequestSchema = z.object({
  version: z.literal(DESKTOP_IPC_VERSION),
  requestId: z.string().uuid(),
  command: z.string().trim().min(1).max(120),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine(enforceDesktopControlFrameSize)

export const desktopAuthCommandSchema = z.discriminatedUnion('command', [
  z.object({
    command: z.literal('bootstrap'),
    payload: z.object({}).strict(),
  }).strict(),
  z.object({
    command: z.literal('projection'),
    payload: z.object({}).strict(),
  }).strict(),
  z.object({
    command: z.literal('sign-in-email'),
    payload: z.object({
      email: z.string().email().max(320),
      password: z.string().min(1).max(1_024),
    }).strict(),
  }).strict(),
  z.object({
    command: z.literal('sign-up-email'),
    payload: z.object({
      name: z.string().trim().min(1).max(160),
      email: z.string().email().max(320),
      password: z.string().min(12).max(1_024),
    }).strict(),
  }).strict(),
  z.object({
    command: z.literal('sign-out'),
    payload: z.object({}).strict(),
  }).strict(),
])

const desktopOperationsTargetSchema = z.enum(['infra', 'worker', 'api', 'all'])

export const desktopSupervisorCommandSchema = z.discriminatedUnion('command', [
  z.object({
    command: z.literal('status'),
    payload: z.object({}).strict(),
  }).strict(),
  z.object({
    command: z.enum(['diagnostics_start', 'diagnostics_stop']),
    payload: z.object({}).strict(),
  }).strict(),
  z.object({
    command: z.enum(['start', 'stop', 'restart']),
    payload: z.object({
      target: desktopOperationsTargetSchema,
      operationId: z.string().uuid(),
      keepInfra: z.boolean().optional(),
    }).strict(),
  }).strict(),
])

export const desktopSupervisorLogsQuerySchema = operationsLogQuerySchema
export const desktopSupervisorLogsResponseSchema = operationsLogPageSchema
  .superRefine(enforceDesktopControlFrameSize)
export const desktopSupervisorLogSubscriptionSchema = z.object({
  active: z.boolean(),
  filter: operationsLogFilterSchema,
}).strict()
export const desktopDiagnosticExportRequestSchema = z.object({}).strict()
  .superRefine(enforceDesktopControlFrameSize)
export const desktopDiagnosticExportResultSchema = z.object({
  canceled: z.boolean(),
  displayName: z.string().min(1).max(260).nullable(),
  entryCount: z.number().int().nonnegative(),
}).strict().superRefine(enforceDesktopControlFrameSize)

export const desktopControlResponsePayloadSchema = z.object({
  version: z.literal(DESKTOP_IPC_VERSION),
  requestId: z.string().uuid(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).strict().optional(),
}).strict()

export const desktopControlResponseSchema = desktopControlResponsePayloadSchema
  .superRefine(enforceDesktopControlFrameSize)

export const desktopCompressedControlResponseSchema = z.object({
  version: z.literal(DESKTOP_IPC_VERSION),
  requestId: z.string().uuid(),
  encoding: z.literal('gzip-base64'),
  uncompressedBytes: z.number().int().min(1).max(DESKTOP_CONTROL_DECOMPRESSED_MAX_BYTES),
  payload: z.string().min(1).max(DESKTOP_COMPRESSED_RESPONSE_MAX_BYTES).regex(
    /^[A-Za-z0-9+/]+={0,2}$/u,
    '压缩控制响应必须是标准 Base64。',
  ),
}).strict()

export const desktopControlResponseTransportSchema = z.union([
  desktopControlResponseSchema,
  desktopCompressedControlResponseSchema,
])

export const desktopEventPayloadSchema = z.object({
  version: z.literal(DESKTOP_IPC_VERSION),
  event: z.enum([
    'window:maximized',
    'window:restored',
    'supervisor:snapshot',
    'supervisor:log',
    'supervisor:error',
    'transport:push',
    'transport:status',
    'auth:updated',
    'desktop:command',
  ]),
  payload: z.unknown(),
}).strict()

export const desktopEventSchema = desktopEventPayloadSchema
  .superRefine(enforceDesktopControlFrameSize)

export const desktopCompressedEventSchema = z.object({
  version: z.literal(DESKTOP_IPC_VERSION),
  frame: z.literal('event'),
  encoding: z.literal('gzip-base64'),
  uncompressedBytes: z.number().int().min(1).max(DESKTOP_CONTROL_DECOMPRESSED_MAX_BYTES),
  payload: z.string().min(1).max(DESKTOP_CONTROL_FRAME_MAX_BYTES).regex(
    /^[A-Za-z0-9+/]+={0,2}$/u,
    '压缩桌面事件必须是标准 Base64。',
  ),
}).strict().superRefine(enforceDesktopControlFrameSize)

export const desktopEventTransportSchema = z.union([
  desktopEventSchema,
  desktopCompressedEventSchema,
])

export const DESKTOP_IPC_CHANNELS = {
  apiRequest: `${PLATFORM_IPC_CHANNEL_PREFIX}:api:request`,
  apiUpload: `${PLATFORM_IPC_CHANNEL_PREFIX}:api:upload`,
  apiDownload: `${PLATFORM_IPC_CHANNEL_PREFIX}:api:download`,
  apiOpen: `${PLATFORM_IPC_CHANNEL_PREFIX}:api:open`,
  authRequest: `${PLATFORM_IPC_CHANNEL_PREFIX}:auth:request`,
  clipboardWrite: `${PLATFORM_IPC_CHANNEL_PREFIX}:clipboard:write`,
  controlRequest: `${PLATFORM_IPC_CHANNEL_PREFIX}:control:request`,
  diagnosticReport: `${PLATFORM_IPC_CHANNEL_PREFIX}:diagnostic:report`,
  dialogConfirm: `${PLATFORM_IPC_CHANNEL_PREFIX}:dialog:confirm`,
  exportRequest: `${PLATFORM_IPC_CHANNEL_PREFIX}:export:request`,
  fileSelect: `${PLATFORM_IPC_CHANNEL_PREFIX}:file:select`,
  fileStageImage: `${PLATFORM_IPC_CHANNEL_PREFIX}:file:stage-image`,
  fileRelease: `${PLATFORM_IPC_CHANNEL_PREFIX}:file:release`,
  fileReadText: `${PLATFORM_IPC_CHANNEL_PREFIX}:file:read-text`,
  microphonePermission: `${PLATFORM_IPC_CHANNEL_PREFIX}:microphone:permission`,
  macosCliStatus: `${PLATFORM_IPC_CHANNEL_PREFIX}:macos-cli:status`,
  macosCliAction: `${PLATFORM_IPC_CHANNEL_PREFIX}:macos-cli:action`,
  setupStatus: `${PLATFORM_IPC_CHANNEL_PREFIX}:setup:status`,
  setupTest: `${PLATFORM_IPC_CHANNEL_PREFIX}:setup:test`,
  setupSave: `${PLATFORM_IPC_CHANNEL_PREFIX}:setup:save`,
  setupReset: `${PLATFORM_IPC_CHANNEL_PREFIX}:setup:reset`,
  setupRestart: `${PLATFORM_IPC_CHANNEL_PREFIX}:setup:restart`,
  supervisorLogs: `${PLATFORM_IPC_CHANNEL_PREFIX}:supervisor:logs`,
  supervisorLogHistory: `${PLATFORM_IPC_CHANNEL_PREFIX}:supervisor:log-history`,
  supervisorLogSubscription: `${PLATFORM_IPC_CHANNEL_PREFIX}:supervisor:log-subscription`,
  supervisorDiagnosticExport: `${PLATFORM_IPC_CHANNEL_PREFIX}:supervisor:diagnostic-export`,
  supervisorRequest: `${PLATFORM_IPC_CHANNEL_PREFIX}:supervisor:request`,
  windowCommand: `${PLATFORM_IPC_CHANNEL_PREFIX}:window:command`,
  event: `${PLATFORM_IPC_CHANNEL_PREFIX}:event`,
} as const

export type DesktopApiOperation = z.infer<typeof desktopApiOperationSchema>
export type DesktopApiResponse = z.infer<typeof desktopApiResponseSchema>
export type DesktopDownloadRequest = z.infer<typeof desktopDownloadRequestSchema>
export type DesktopDownloadResult = z.infer<typeof desktopDownloadResultSchema>
export type DesktopUploadOperation = z.infer<typeof desktopUploadOperationSchema>
export type DesktopAuthCommand = z.infer<typeof desktopAuthCommandSchema>
export type DesktopAuthBootstrapResult = z.infer<typeof desktopAuthBootstrapResultSchema>
export type DesktopAuthProjection = z.infer<typeof desktopAuthProjectionSchema>
export type DesktopProductSetupStatus = z.infer<typeof desktopProductSetupStatusSchema>
export type DesktopProductSetupConnection = z.infer<typeof desktopProductSetupConnectionSchema>
export type DesktopProductSetupTestResult = z.infer<typeof desktopProductSetupTestResultSchema>
export type DesktopProductSetupRestartResult = z.infer<typeof desktopProductSetupRestartResultSchema>
export type DesktopWorkspaceBootstrapSnapshot = z.infer<typeof desktopWorkspaceBootstrapSnapshotSchema>
export type DesktopConfirmationRequest = z.infer<typeof desktopConfirmationRequestSchema>
export type DesktopRendererDiagnostic = z.infer<typeof desktopRendererDiagnosticSchema>
export type DesktopMicrophonePermissionResult = z.infer<
  typeof desktopMicrophonePermissionResultSchema
>
export type DesktopMacosCliAction = z.infer<typeof desktopMacosCliActionSchema>
export type DesktopMacosCliStatus = z.infer<typeof desktopMacosCliStatusSchema>
export type DesktopControlRequest = z.infer<typeof desktopControlRequestSchema>
export type DesktopControlResponse = z.infer<typeof desktopControlResponsePayloadSchema>
export type DesktopControlResponseTransport = z.infer<typeof desktopControlResponseTransportSchema>
export type DesktopEvent = z.infer<typeof desktopEventPayloadSchema>
export type DesktopEventTransport = z.infer<typeof desktopEventTransportSchema>
export type DesktopExportManifest = z.infer<typeof desktopExportManifestSchema>
export type DesktopExportRequest = z.infer<typeof desktopExportRequestSchema>
export type DesktopExportResult = z.infer<typeof desktopExportResultSchema>
export type DesktopDiagnosticExportResult = z.infer<typeof desktopDiagnosticExportResultSchema>
export type DesktopFileSelectionHandle = z.infer<typeof desktopFileSelectionHandleSchema>
export type DesktopFileSelectionRequest = z.infer<typeof desktopFileSelectionRequestSchema>
export type DesktopFileHandleReleaseRequest = z.infer<typeof desktopFileHandleReleaseRequestSchema>
export type DesktopImageBlobStageRequest = z.infer<typeof desktopImageBlobStageRequestSchema>
export type DesktopTextFileReadRequest = z.infer<typeof desktopTextFileReadRequestSchema>
export type DesktopTextFileReadResult = z.infer<typeof desktopTextFileReadResultSchema>
export type DesktopWindowCommand = z.infer<typeof desktopWindowCommandSchema>
export type DesktopMenuCommand = z.infer<typeof desktopMenuCommandSchema>
export type DesktopWorkspaceWindowDescriptor = z.infer<typeof desktopWorkspaceWindowDescriptorSchema>

function isPrivateAuthenticationPath(value: string): boolean {
  const pathname = value.split(/[?#]/u, 1)[0]?.toLowerCase() ?? ''
  return pathname === '/api/auth'
    || pathname.startsWith('/api/auth/')
    || pathname === '/api/v1/auth/me'
    || pathname.startsWith('/api/v1/auth/me/')
}

function enforceDesktopControlFrameSize(
  value: unknown,
  context: z.RefinementCtx,
): void {
  try {
    const serialized = JSON.stringify(value)
    if (
      serialized === undefined
      || new TextEncoder().encode(serialized).byteLength > DESKTOP_CONTROL_FRAME_MAX_BYTES
    ) {
      context.addIssue({
        code: 'custom',
        message: `桌面 IPC 控制帧不得超过 ${DESKTOP_CONTROL_FRAME_MAX_BYTES} 字节。`,
      })
    }
  } catch {
    context.addIssue({
      code: 'custom',
      message: '桌面 IPC 控制帧必须可以安全序列化。',
    })
  }
}

function enforceDesktopApiOperation(
  value: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    body: string | null
    headers: Partial<Record<'accept' | 'content-type', string>>
  },
  context: z.RefinementCtx,
): void {
  const url = parseDesktopApiUrl(value.path)
  const route = url ? matchDesktopJsonRoute(value.method, url) : null
  if (!route) {
    context.addIssue({
      code: 'custom',
      path: ['path'],
      message: '桌面 JSON 数据面只允许已注册的固定 API 操作。',
    })
    return
  }
  if (!route.bodySchema) {
    if (value.body !== null) {
      context.addIssue({
        code: 'custom',
        path: ['body'],
        message: '当前桌面 API 操作不接受请求体。',
      })
    }
    return
  }
  if (value.body === null) {
    context.addIssue({
      code: 'custom',
      path: ['body'],
      message: '当前桌面 API 操作必须提供 JSON 请求体。',
    })
    return
  }
  if (!/^application\/json(?:\s*;|$)/iu.test(value.headers['content-type'] ?? '')) {
    context.addIssue({
      code: 'custom',
      path: ['headers', 'content-type'],
      message: '桌面写操作必须显式使用 application/json。',
    })
    return
  }
  try {
    const parsedBody: unknown = JSON.parse(value.body)
    const parsed = route.bodySchema.safeParse(parsedBody)
    if (!parsed.success) {
      context.addIssue({
        code: 'custom',
        path: ['body'],
        message: parsed.error.issues[0]?.message ?? '桌面 API 请求体不符合操作契约。',
      })
    }
  } catch {
    context.addIssue({
      code: 'custom',
      path: ['body'],
      message: '桌面 API 请求体必须是有效 JSON。',
    })
  }
}

function enforceDesktopUploadOperation(
  value: {
    path: string
    fields: Array<{ name: string; value: string }>
    files: Array<{
      fieldName: string
      handleId: string
      fileName: string
      mediaType: string
    }>
  },
  context: z.RefinementCtx,
): void {
  const url = parseDesktopApiUrl(value.path)
  const allowedFields = url ? matchDesktopUploadRoute(url) : null
  if (!allowedFields) {
    context.addIssue({
      code: 'custom',
      path: ['path'],
      message: '桌面上传只允许已注册的固定 API 操作。',
    })
    return
  }
  const fieldNames = value.fields.map(field => field.name)
  if (
    new Set(fieldNames).size !== fieldNames.length
    || fieldNames.some(name => !allowedFields.has(name))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['fields'],
      message: '桌面上传包含重复或未注册的表单字段。',
    })
  }
  if (
    value.files.length !== 1
    || value.files[0]?.fieldName !== 'file'
    || value.files.some(file => (
      file.fileName.includes('/')
      || file.fileName.includes('\\')
      || file.fileName.includes('\0')
    ))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['files'],
      message: '桌面上传必须提供一个由不透明句柄引用的普通文件。',
    })
  }
}

function isAllowedDesktopDownloadPath(value: string): boolean {
  const url = parseDesktopApiUrl(value)
  if (!url || url.search || url.hash) return false
  return /^\/api\/v1\/results\/[A-Za-z0-9_-]+\/(?:file|geojson)$/u.test(url.pathname)
    || /^\/api\/v1\/artifacts\/[A-Za-z0-9_-]+\/download$/u.test(url.pathname)
    || /^\/api\/v1\/map\/layers\/[A-Za-z0-9_-]+\/download$/u.test(url.pathname)
}

function matchDesktopJsonRoute(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: URL,
): { bodySchema: z.ZodType | null } | null {
  if (url.hash) return null
  const path = url.pathname
  if (method === 'GET' && url.search === '' && (
    path === '/health'
    || path === '/health/capabilities'
    || path === '/api/v1/map/basemaps'
    || path === '/api/v1/admin/users'
    || path === '/api/v1/admin/workspaces'
    || path === '/api/v1/admin/roles'
    || path === '/api/v1/admin/audit-events'
    || /^\/api\/v1\/results\/[A-Za-z0-9_-]+\/(?:geojson|metadata)$/u.test(path)
    || /^\/api\/v1\/meteorology\/jobs\/[A-Za-z0-9_-]+$/u.test(path)
    || /^\/api\/v1\/map\/scenes\/[A-Za-z0-9_-]+$/u.test(path)
  )) {
    return { bodySchema: null }
  }
  if (
    method === 'GET'
    && path === '/api/v1/meteorology/datasets'
    && hasOnlyResourceIdQuery(url, ['sessionId', 'threadId'])
  ) {
    return { bodySchema: null }
  }
  if (
    method === 'GET'
    && path === '/api/v1/admin/memberships'
    && hasOnlyResourceIdQuery(url, ['workspaceId'])
  ) {
    return { bodySchema: null }
  }
  if (
    method === 'GET'
    && /^\/api\/v1\/map\/layers\/[A-Za-z0-9_-]+\/features$/u.test(path)
    && hasExactIntegerQuery(url, { offset: 0, limit: 1 })
  ) {
    return { bodySchema: null }
  }
  if (
    method === 'PATCH'
    && url.search === ''
    && /^\/api\/v1\/admin\/users\/[A-Za-z0-9_-]+$/u.test(path)
  ) {
    return { bodySchema: adminUserPatchSchema }
  }
  if (method === 'POST' && url.search === '' && path === '/api/v1/admin/workspaces') {
    return { bodySchema: adminWorkspaceCreateSchema }
  }
  if (method === 'POST' && url.search === '' && path === '/api/v1/admin/memberships') {
    return { bodySchema: adminMembershipCreateSchema }
  }
  if (
    method === 'DELETE'
    && url.search === ''
    && /^\/api\/v1\/admin\/memberships\/[A-Za-z0-9_-]+$/u.test(path)
  ) {
    return { bodySchema: null }
  }
  return null
}

function matchDesktopUploadRoute(url: URL): ReadonlySet<string> | null {
  if (url.search || url.hash) return null
  if (url.pathname === '/api/v1/layers/register') {
    return new Set(['session_id', 'threadId', 'sourceRelativePath'])
  }
  if (url.pathname === '/api/v1/meteorology/datasets') {
    return new Set(['sessionId', 'threadId', 'sourceRelativePath'])
  }
  if (url.pathname === '/api/v1/layers/import') {
    return new Set([
      'name',
      'description',
      'category',
      'tags',
      'status',
      'analysisCapabilities',
      'sourceConfigSummary',
    ])
  }
  if (/^\/api\/v1\/layers\/[A-Za-z0-9_-]+\/replace$/u.test(url.pathname)) {
    return new Set()
  }
  if (url.pathname === '/api/v1/files/upload') {
    return new Set(['threadId', 'requestId', 'sourceRelativePath'])
  }
  return null
}

function parseDesktopApiUrl(value: string): URL | null {
  try {
    const url = new URL(value, 'https://desktop.invalid')
    return url.origin === 'https://desktop.invalid' ? url : null
  } catch {
    return null
  }
}

function hasOnlyResourceIdQuery(
  url: URL,
  allowedNames: readonly string[],
): boolean {
  for (const name of new Set(url.searchParams.keys())) {
    if (!allowedNames.includes(name)) return false
    const values = url.searchParams.getAll(name)
    if (
      values.length !== 1
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u.test(values[0] ?? '')
    ) {
      return false
    }
  }
  return true
}

function hasExactIntegerQuery(
  url: URL,
  minima: Readonly<Record<string, number>>,
): boolean {
  const names = Array.from(url.searchParams.keys())
  if (
    names.length !== Object.keys(minima).length
    || new Set(names).size !== names.length
  ) {
    return false
  }
  return Object.entries(minima).every(([name, minimum]) => {
    const value = url.searchParams.get(name)
    return value !== null && /^\d+$/u.test(value) && Number(value) >= minimum
  })
}

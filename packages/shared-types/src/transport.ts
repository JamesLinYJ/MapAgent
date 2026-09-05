// +-------------------------------------------------------------------------
//
//   地理智能平台 - HTTP 与 WebSocket 传输协议
//
//   文件:       transport.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 平台 HTTP/WS 传输投影协议。
import { z } from 'zod'
import {
  agentRunProfileSchema,
  conversationItemSchema,
  runEventSchema,
  memoryFileRecordSchema,
  memorySearchResultSchema,
  runGoalInputSchema,
  subAgentStateSchema,
  runSteeringRecordSchema,
} from './core.js'
import {
  compactionRecordSchema,
  contextAssemblyReportSchema,
  threadManifestSchema,
  threadMemoryDocumentSchema,
  transcriptEntrySchema,
} from './conversation.js'
import {
  analysisRunSchema,
  agentThreadRecordSchema,
  authMeSchema,
  directToolRunResponseSchema,
  runSummarySchema,
  sessionRecordSchema,
} from './platform.js'
import { agentRuntimeConfigSchema, runtimeConfigDocumentSchema } from './runtime.js'
import { mapSceneSchema, mapSceneUpdateSchema } from './map.js'
import {
  automationDefinitionSchema,
  automationAgentInvocationSchema,
  automationGraphSchema,
  automationRunRecordSchema,
  automationValidationResultSchema,
  automationVersionRecordSchema,
  backgroundTaskInfoSchema,
  customProviderConfigSchema,
  customProviderRecordSchema,
  customProviderSaveResultSchema,
  customProviderTestModeSchema,
  customProviderTestResultSchema,
  layerDescriptorSchema,
  modelProviderDescriptorSchema,
  providerCredentialStageSchema,
  providerModelDiscoverySchema,
  runAttachmentsSchema,
  scheduledTaskSchema,
  skillCatalogSnapshotSchema,
  skillSearchResponseSchema,
  speechAuthorizationSchema,
  systemComponentsStatusSchema,
  tokenUsageSummarySchema,
  tokenUsageThreadSummarySchema,
  toolDescriptorSchema,
} from './resources.js'

export const runSummaryPageSchema = z.object({
  items: z.array(runSummarySchema),
  nextCursor: z.string().nullable(),
})

export const workspaceBootstrapSnapshotSchema = z.object({
  auth: authMeSchema,
  session: sessionRecordSchema,
  threads: z.array(agentThreadRecordSchema),
  providers: z.array(modelProviderDescriptorSchema),
  tools: z.array(toolDescriptorSchema),
})

export const threadHistoryPageSchema = z.object({
  entries: z.array(transcriptEntrySchema),
  nextCursor: z.string().nullable(),
})

export const threadDetailSnapshotSchema = z.object({
  thread: agentThreadRecordSchema,
  manifest: threadManifestSchema,
}).strict()

export const runItemCursorSchema = z.object({
  sequence: z.number().int().nonnegative(),
  utf16Offset: z.number().int().nonnegative(),
}).strict()

export const runItemSnapshotCursorSchema = runItemCursorSchema.extend({
  itemId: z.string().min(1),
}).strict()

export const runItemUpsertSchema = z.object({
  updateType: z.literal('item_upsert'),
  schemaVersion: z.literal(1),
  streamId: z.string().min(1),
  cursor: runItemCursorSchema,
  item: conversationItemSchema,
}).strict().superRefine((update, context) => {
  if (update.cursor.utf16Offset === (update.item.body ?? '').length) return
  context.addIssue({
    code: 'custom',
    path: ['cursor', 'utf16Offset'],
    message: '完整 item 游标必须等于 item.body 的 UTF-16 长度',
  })
})

export const runItemStreamSnapshotSchema = z.object({
  streamId: z.string().min(1),
  cursors: z.array(runItemSnapshotCursorSchema),
}).strict().superRefine((snapshot, context) => {
  const itemIds = new Set<string>()
  snapshot.cursors.forEach((cursor, index) => {
    if (!itemIds.has(cursor.itemId)) {
      itemIds.add(cursor.itemId)
      return
    }
    context.addIssue({
      code: 'custom',
      path: ['cursors', index, 'itemId'],
      message: `itemId '${cursor.itemId}' 的流游标重复`,
    })
  })
})

export const runSnapshotSchema = z.object({
  run: analysisRunSchema,
  items: z.array(conversationItemSchema),
  events: z.array(runEventSchema),
  itemStream: runItemStreamSnapshotSchema,
}).strict().superRefine((snapshot, context) => {
  const cursors = new Map(snapshot.itemStream.cursors.map(cursor => [cursor.itemId, cursor]))
  if (snapshot.items.length !== cursors.size) {
    context.addIssue({
      code: 'custom',
      path: ['itemStream', 'cursors'],
      message: '快照中的每个 item 必须且只能有一个游标',
    })
  }
  snapshot.items.forEach((item, index) => {
    const cursor = cursors.get(item.itemId)
    if (cursor && cursor.utf16Offset === (item.body ?? '').length) return
    context.addIssue({
      code: 'custom',
      path: ['items', index, 'body'],
      message: `item '${item.itemId}' 的正文与流游标不一致`,
    })
  })
})

/**
 * 运行中文本项的增量事实。`utf16Offset` 与 JavaScript 字符串索引语义一致，
 * 接收端必须在 offset 精确匹配时才追加；sequence 用于检测同一 item 的乱序
 * 或丢帧。完整 ConversationItem 仅用于 start/final 和快照重同步。
 */
export const conversationItemTextDeltaSchema = z.object({
  updateType: z.literal('text_delta'),
  schemaVersion: z.literal(1),
  streamId: z.string().min(1),
  runId: z.string().min(1),
  threadId: z.string().min(1).nullable(),
  itemId: z.string().min(1),
  sequence: z.number().int().positive(),
  utf16Offset: z.number().int().nonnegative(),
  text: z.string().min(1),
}).strict()

export type RunSummaryPage = z.infer<typeof runSummaryPageSchema>
export type WorkspaceBootstrapSnapshot = z.infer<typeof workspaceBootstrapSnapshotSchema>
export type ThreadHistoryPage = z.infer<typeof threadHistoryPageSchema>
export type ThreadDetailSnapshot = z.infer<typeof threadDetailSnapshotSchema>
export type RunSnapshot = z.infer<typeof runSnapshotSchema>
export type RunItemCursor = z.infer<typeof runItemCursorSchema>
export type RunItemSnapshotCursor = z.infer<typeof runItemSnapshotCursorSchema>
export type RunItemUpsert = z.infer<typeof runItemUpsertSchema>
export type RunItemStreamSnapshot = z.infer<typeof runItemStreamSnapshotSchema>
export type ConversationItemTextDelta = z.infer<typeof conversationItemTextDeltaSchema>
export type ConversationItemStreamUpdate = RunItemUpsert | ConversationItemTextDelta

// --- WebSocket control plane ---

export const wsControlCommands = [
  'workspace:bootstrap',
  'session:get-default', 'session:get',
  'thread:list', 'thread:get', 'thread:create', 'thread:update', 'thread:delete',
  'thread:history', 'thread:fork', 'thread:compact', 'thread:context',
  'thread:subscribe', 'thread:unsubscribe',
  'thread:memory:get', 'thread:memory:update', 'thread:memory:rebuild',
  'thread:trash:list', 'thread:trash:restore', 'thread:trash:purge',
  'run:list', 'run:start', 'run:get', 'run:cancel', 'run:resume', 'run:steer', 'run:respond-decision', 'run:subscribe', 'run:unsubscribe',
  'subagent:list', 'subagent:get', 'subagent:follow-up', 'subagent:cancel',
  'tool:list', 'tool:run',
  'tool-catalog:list', 'tool-catalog:upsert', 'tool-catalog:delete',
  'skill:list', 'skill:search',
  'runtime-config:get', 'runtime-config:update',
  'provider:list',
  'provider:custom:list', 'provider:credential:stage', 'provider:custom:discover-models',
  'provider:custom:test', 'provider:custom:upsert', 'provider:custom:delete',
  'system:get',
  'usage:summary', 'usage:thread-summary',
  'speech:authorization',
  'memory:list', 'memory:read', 'memory:write', 'memory:delete', 'memory:search',
  'memory:extract', 'memory:dream',
  'memory:session:get', 'memory:session:rebuild',
  'memory:instructions:list',
  'file:list', 'file:delete',
  'layer:list', 'layer:update', 'layer:delete',
  'map-scene:update',
  'automation:list', 'automation:validate', 'automation:create', 'automation:update',
  'automation:publish', 'automation:disable', 'automation:history',
  'automation:start', 'automation:cancel', 'automation:run:get', 'automation:respond-approval',
  'scheduled-task:list', 'scheduled-task:create', 'scheduled-task:update', 'scheduled-task:delete',
  'background-task:list', 'background-task:promote', 'background-task:cancel',
] as const

export const wsControlCommandSchema = z.enum(wsControlCommands)
export type WsControlCommand = z.infer<typeof wsControlCommandSchema>

// --- WebSocket command contracts ---
//
// Payload/response schemas are kept beside the protocol command list so the
// server registry and the desktop Renderer cannot silently grow independent
// interpretations of the same command.  The schemas intentionally preserve
// the existing payload openness (passthrough where legacy clients relied on
// it); tightening a field is a protocol change and must be explicit.

const wsEmptyPayloadSchema = z.object({}).passthrough()
const wsSessionPayloadSchema = z.object({ sessionId: z.string().min(1) }).passthrough()
const wsThreadIdPayloadSchema = z.object({ threadId: z.string().min(1) }).passthrough()
const wsRunIdPayloadSchema = z.object({ runId: z.string().min(1) }).passthrough()
const wsAutomationIdPayloadSchema = z.object({ automationId: z.string().min(1) }).strict()
const wsAutomationRunIdPayloadSchema = z.object({ automationRunId: z.string().min(1) }).strict()
const wsTaskIdPayloadSchema = z.object({ taskId: z.string().min(1) }).strict()

const wsWorkspaceBootstrapPayloadSchema = z.object({
  sessionId: z.string().min(1).nullable().optional(),
  workspaceId: z.string().min(1).nullable().optional(),
}).passthrough()
const wsSessionGetPayloadSchema = z.object({ sessionId: z.string().min(1) }).passthrough()
const wsFileListPayloadSchema = z.object({ threadId: z.string().min(1) }).strict()
const wsFileDeletePayloadSchema = z.object({
  fileId: z.string().min(1),
  threadId: z.string().min(1),
}).strict()
const wsLayerListPayloadSchema = z.object({
  sessionId: z.string().min(1).nullable().optional(),
  threadId: z.string().min(1).nullable().optional(),
}).passthrough()
const wsLayerUpdatePayloadSchema = z.object({
  layerKey: z.string().min(1),
  update: z.record(z.string(), z.unknown()),
}).passthrough()
const wsLayerDeletePayloadSchema = z.object({ layerKey: z.string().min(1) }).passthrough()
const wsRunListPayloadSchema = z.object({
  sessionId: z.string().min(1),
  threadId: z.string().min(1).nullable().optional(),
  cursor: z.string().min(1).nullable().optional(),
  limit: z.number().int().positive().optional(),
}).passthrough()
const wsRunStartPayloadSchema = z.object({
  query: z.string().min(1),
  sessionId: z.string().min(1).nullable().optional(),
  threadId: z.string().min(1).nullable().optional(),
  provider: z.string().min(1).nullable().optional(),
  modelProvider: z.string().min(1).nullable().optional(),
  modelName: z.string().min(1).nullable().optional(),
  executionMode: z.enum(['auto', 'plan']).optional(),
  runProfile: agentRunProfileSchema.optional(),
  goal: runGoalInputSchema.nullable().optional(),
  reasoning: z.boolean().optional(),
  attachments: runAttachmentsSchema.default([]),
}).passthrough()
const wsRunSteerPayloadSchema = z.object({
  runId: z.string().min(1),
  steeringId: z.string().min(1).max(160),
  content: z.string().trim().min(1).max(4000),
}).strict()
const wsSubAgentIdentityPayloadSchema = z.object({
  runId: z.string().min(1),
  agentId: z.string().min(1),
}).strict()
const wsSubAgentFollowUpPayloadSchema = wsSubAgentIdentityPayloadSchema.extend({
  followUpId: z.string().min(1).max(160),
  content: z.string().trim().min(1).max(4000),
}).strict()
const wsSubAgentCancelPayloadSchema = wsSubAgentIdentityPayloadSchema.extend({
  cancellationId: z.string().min(1).max(160),
  reason: z.string().trim().min(1).max(1000).optional(),
}).strict()
const wsProviderCredentialStagePayloadSchema = z.object({
  secret: z.string().min(1).max(8192),
}).strict()
const wsCustomProviderDiscoverModelsPayloadSchema = z.object({
  providerId: z.string().trim().min(1).max(64),
  baseUrl: z.string().trim().url().max(2_048),
  credentialHandle: z.string().min(1).max(200).nullable().optional(),
}).strict()
const wsCustomProviderUpsertPayloadSchema = z.object({
  config: customProviderConfigSchema,
  expectedRevision: z.number().int().positive().nullable(),
  credentialHandle: z.string().min(1).max(200).nullable().optional(),
  clearApiKey: z.boolean().optional(),
}).strict().superRefine((payload, context) => {
  if (payload.credentialHandle && payload.clearApiKey) {
    context.addIssue({
      code: 'custom',
      path: ['credentialHandle'],
      message: 'credentialHandle 与清除凭据操作不能同时使用',
    })
  }
})
const wsCustomProviderTestPayloadSchema = z.object({
  config: customProviderConfigSchema,
  mode: customProviderTestModeSchema,
  credentialHandle: z.string().min(1).max(200).nullable().optional(),
}).strict()
const wsCustomProviderDeletePayloadSchema = z.object({
  providerId: z.string().min(1).max(64),
  expectedRevision: z.number().int().positive(),
}).strict()
const wsRespondDecisionPayloadSchema = z.object({
  runId: z.string().min(1),
  decisionId: z.string().min(1),
  optionId: z.string().min(1).nullable().optional(),
  text: z.string().nullable().optional(),
}).passthrough()
const wsThreadCreatePayloadSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().min(1).nullable().optional(),
}).passthrough()
const wsThreadUpdatePayloadSchema = z.object({
  threadId: z.string().min(1),
  title: z.string().min(1),
}).passthrough()
const wsThreadHistoryPayloadSchema = z.object({
  threadId: z.string().min(1),
  cursor: z.string().min(1).nullable().optional(),
  limit: z.number().int().positive().optional(),
}).passthrough()
const wsThreadForkPayloadSchema = z.object({
  threadId: z.string().min(1),
  entryId: z.string().min(1),
  title: z.string().min(1).nullable().optional(),
}).passthrough()
const wsThreadCompactPayloadSchema = z.object({
  threadId: z.string().min(1),
  provider: z.string().min(1).nullable().optional(),
  modelName: z.string().min(1).nullable().optional(),
}).passthrough()
const wsThreadMemoryUpdatePayloadSchema = z.object({
  threadId: z.string().min(1),
  content: z.string(),
  expectedVersion: z.number().int().nonnegative().nullable().optional(),
}).passthrough()
const wsThreadMemoryRebuildPayloadSchema = z.object({
  threadId: z.string().min(1),
  provider: z.string().min(1).nullable().optional(),
  modelName: z.string().min(1).nullable().optional(),
}).passthrough()
const wsMemoryListPayloadSchema = z.object({ scope: z.string().min(1).nullable().optional() }).passthrough()
const wsMemoryReadDeletePayloadSchema = z.object({
  scope: z.string().min(1),
  relativePath: z.string().min(1),
}).passthrough()
const wsMemoryWritePayloadSchema = z.object({
  scope: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  content: z.string(),
  relativePath: z.string().min(1).nullable().optional(),
}).passthrough()
const wsMemorySearchPayloadSchema = z.object({
  query: z.string().min(1),
  provider: z.string().min(1).nullable().optional(),
  modelName: z.string().min(1).nullable().optional(),
}).passthrough()
const wsMemoryExtractPayloadSchema = z.object({
  threadId: z.string().min(1),
  runId: z.string().min(1).nullable().optional(),
  provider: z.string().min(1).nullable().optional(),
  modelName: z.string().min(1).nullable().optional(),
}).passthrough()
const wsMemoryDreamPayloadSchema = z.object({
  force: z.boolean().optional(),
  provider: z.string().min(1).nullable().optional(),
  modelName: z.string().min(1).nullable().optional(),
}).passthrough()
const wsToolCatalogUpsertPayloadSchema = z.object({
  toolKind: z.string().min(1),
  toolName: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  sortOrder: z.number().optional(),
}).passthrough()
const wsToolCatalogDeletePayloadSchema = z.object({
  toolKind: z.string().min(1),
  toolName: z.string().min(1),
}).passthrough()
const wsSkillSearchPayloadSchema = z.object({
  query: z.string().trim().min(1).max(4000),
}).strict()
const wsRuntimeConfigUpdatePayloadSchema = z.object({
  config: agentRuntimeConfigSchema,
  expectedRevision: z.number().int().nonnegative(),
}).strict()
const wsToolRunPayloadSchema = z.object({
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  runId: z.string().min(1).nullable().optional(),
  sessionId: z.string().min(1).nullable().optional(),
  threadId: z.string().min(1).nullable().optional(),
}).strict()
const wsAutomationDraftPayloadSchema = z.object({
  automationId: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  parametersSchema: z.record(z.string(), z.unknown()),
  defaultParameters: z.record(z.string(), z.unknown()),
  timeoutSeconds: z.number().int().positive().max(86_400),
  outputType: z.string().min(1),
  agentInvocation: automationAgentInvocationSchema.optional(),
  graph: automationGraphSchema,
}).strict()
const wsAutomationUpdatePayloadSchema = wsAutomationDraftPayloadSchema.extend({
  automationId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
}).strict()
const wsAutomationRevisionPayloadSchema = wsAutomationIdPayloadSchema.extend({ revision: z.number().int().positive() }).strict()
const wsAutomationStartPayloadSchema = z.object({
  automationId: z.string().min(1),
  prompt: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
}).strict()
const wsAutomationApprovalPayloadSchema = wsAutomationRunIdPayloadSchema.extend({
  approvalId: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
}).strict()
const wsScheduledTaskCreatePayloadSchema = z.object({
  targetKind: z.literal('automation'),
  targetId: z.string().min(1),
  title: z.string().nullable().optional(),
  prompt: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
  cron: z.string().min(1),
  timezone: z.string().min(1),
  recurring: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).strict()
const wsScheduledTaskUpdatePayloadSchema = wsScheduledTaskCreatePayloadSchema.partial().extend({
  taskId: z.string().min(1),
}).strict()

const wsUnknownRecordSchema = z.record(z.string(), z.unknown())
const wsMutationAckSchema = z.object({
  deleted: z.boolean().optional(),
  id: z.string().optional(),
  threadId: z.string().optional(),
  layerKey: z.string().optional(),
  purged: z.boolean().optional(),
  unsubscribed: z.boolean().optional(),
}).passthrough()
const wsFileEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.string(),
  sizeBytes: z.number().nonnegative(),
  uploadedAt: z.string(),
  status: z.string(),
  threadId: z.string().nullable().optional(),
  relativePath: z.string().optional(),
  sourceRelativePath: z.string().nullable().optional(),
}).passthrough()
const wsFileListResponseSchema = z.object({
  files: z.array(wsFileEntrySchema),
  total: z.number().int().nonnegative(),
}).strict()
const wsThreadTrashEntrySchema = z.object({
  thread: agentThreadRecordSchema,
  manifest: threadManifestSchema,
  deletedAt: z.string(),
  purgeAfter: z.string(),
}).strict()
const wsThreadSubscriptionResponseSchema = z.object({
  thread: agentThreadRecordSchema,
  manifest: threadManifestSchema,
}).strict()
const wsMemoryListResponseSchema = z.object({
  records: z.array(memoryFileRecordSchema),
  total: z.number().int().nonnegative(),
}).strict()
const wsMemorySearchResponseSchema = z.object({
  matches: z.array(memorySearchResultSchema),
  total: z.number().int().nonnegative(),
}).strict()
const wsDeletedMemorySchema = z.object({ deleted: z.boolean(), relativePath: z.string() }).strict()
const wsDreamMemoryResponseSchema = z.object({
  changed: z.boolean(),
  message: z.string(),
  records: z.array(memoryFileRecordSchema),
  summary: z.string().optional(),
  warnings: z.array(z.string()).optional(),
}).strict()
const wsInstructionMemoryResponseSchema = z.object({
  enabled: z.boolean(),
  entrypointName: z.string(),
  records: z.array(memoryFileRecordSchema),
}).strict()
const wsDesktopWorkspaceBootstrapAuthSchema = authMeSchema
  .omit({ csrfToken: true })
  .extend({ requestProtection: z.literal('main_managed') })
  .strict()
const wsWorkspaceBootstrapResponseSchema = workspaceBootstrapSnapshotSchema
  .extend({ auth: z.union([authMeSchema, wsDesktopWorkspaceBootstrapAuthSchema]) })
  .strict()
const wsAutomationListResponseSchema = z.object({
  definitions: z.array(automationDefinitionSchema),
  diagnostics: z.array(wsUnknownRecordSchema),
  validation: z.record(z.string(), automationValidationResultSchema),
}).strict()
const wsAutomationStartResponseSchema = z.object({
  automationRun: automationRunRecordSchema,
  jobId: z.string(),
}).strict()
const wsAutomationApprovalResponseSchema = z.object({
  automationRun: automationRunRecordSchema,
  jobId: z.string().nullable(),
}).strict()
const wsScheduledTaskListResponseSchema = z.object({
  tasks: z.array(scheduledTaskSchema),
  automationRuns: z.array(automationRunRecordSchema),
}).strict()
const wsBackgroundTaskListResponseSchema = z.object({
  tasks: z.array(backgroundTaskInfoSchema),
}).strict()
const wsSubAgentListResponseSchema = z.object({
  items: z.array(subAgentStateSchema),
}).strict()
const wsSubAgentDetailResponseSchema = z.object({
  agent: subAgentStateSchema,
  events: z.array(runEventSchema),
}).strict()

export type WsCommandCategory = 'read' | 'write' | 'admin'

export type WsCommandSemantic<TCategory extends WsCommandCategory = WsCommandCategory> = {
  auth: 'required' | 'optional'
  csrf: boolean
  category: TCategory
}

export type WsCommandContract<
  TPayload extends z.ZodTypeAny = z.ZodTypeAny,
  TResponse extends z.ZodTypeAny = z.ZodTypeAny,
  TCategory extends WsCommandCategory = WsCommandCategory,
> = WsCommandSemantic<TCategory> & {
  payload: TPayload
  response: TResponse
}

const readContract = <TPayload extends z.ZodTypeAny, TResponse extends z.ZodTypeAny>(
  payload: TPayload,
  response: TResponse,
  csrf = false,
): WsCommandContract<TPayload, TResponse, 'read'> => ({
  payload,
  response,
  auth: 'required',
  csrf,
  category: 'read',
})
const writeContract = <TPayload extends z.ZodTypeAny, TResponse extends z.ZodTypeAny>(
  payload: TPayload,
  response: TResponse,
  csrf = true,
): WsCommandContract<TPayload, TResponse, 'write'> => ({
  payload,
  response,
  auth: 'required',
  csrf,
  category: 'write',
})
const adminContract = <TPayload extends z.ZodTypeAny, TResponse extends z.ZodTypeAny>(
  payload: TPayload,
  response: TResponse,
  csrf = false,
): WsCommandContract<TPayload, TResponse, 'admin'> => ({
  payload,
  response,
  auth: 'required',
  csrf,
  category: 'admin',
})

// Every value in wsControlCommands has one entry.  Keeping this assertion
// adjacent to the protocol enum makes an omitted contract a compile error.
export const wsCommandContracts = {
  'workspace:bootstrap': adminContract(wsWorkspaceBootstrapPayloadSchema, wsWorkspaceBootstrapResponseSchema),
  'session:get-default': readContract(wsEmptyPayloadSchema, sessionRecordSchema),
  'session:get': readContract(wsSessionGetPayloadSchema, sessionRecordSchema),
  'thread:list': readContract(wsSessionPayloadSchema, z.array(agentThreadRecordSchema)),
  'thread:get': readContract(wsThreadIdPayloadSchema, threadDetailSnapshotSchema),
  'thread:create': writeContract(wsThreadCreatePayloadSchema, agentThreadRecordSchema),
  'thread:update': writeContract(wsThreadUpdatePayloadSchema, agentThreadRecordSchema),
  'thread:delete': writeContract(wsThreadIdPayloadSchema, z.object({ deleted: z.boolean(), threadId: z.string() }).strict()),
  'thread:history': readContract(wsThreadHistoryPayloadSchema, threadHistoryPageSchema),
  'thread:fork': writeContract(wsThreadForkPayloadSchema, agentThreadRecordSchema),
  'thread:compact': writeContract(wsThreadCompactPayloadSchema, compactionRecordSchema.nullable()),
  'thread:context': readContract(wsThreadIdPayloadSchema, contextAssemblyReportSchema),
  'thread:subscribe': readContract(wsThreadIdPayloadSchema, wsThreadSubscriptionResponseSchema),
  'thread:unsubscribe': readContract(wsThreadIdPayloadSchema, z.object({ unsubscribed: z.boolean(), threadId: z.string() }).strict()),
  'thread:memory:get': readContract(wsThreadIdPayloadSchema, threadMemoryDocumentSchema),
  'thread:memory:update': writeContract(wsThreadMemoryUpdatePayloadSchema, threadMemoryDocumentSchema),
  'thread:memory:rebuild': writeContract(wsThreadMemoryRebuildPayloadSchema, threadMemoryDocumentSchema),
  'thread:trash:list': readContract(wsSessionPayloadSchema, z.array(wsThreadTrashEntrySchema)),
  'thread:trash:restore': writeContract(wsThreadIdPayloadSchema, agentThreadRecordSchema),
  'thread:trash:purge': writeContract(wsThreadIdPayloadSchema, z.object({ purged: z.boolean(), threadId: z.string() }).strict()),
  'run:list': readContract(wsRunListPayloadSchema, runSummaryPageSchema),
  'run:start': writeContract(wsRunStartPayloadSchema, analysisRunSchema),
  'run:get': readContract(wsRunIdPayloadSchema, runSnapshotSchema),
  'run:cancel': writeContract(wsRunIdPayloadSchema, analysisRunSchema),
  'run:resume': writeContract(wsRunIdPayloadSchema, analysisRunSchema),
  'run:steer': writeContract(wsRunSteerPayloadSchema, runSteeringRecordSchema),
  'run:respond-decision': writeContract(wsRespondDecisionPayloadSchema, analysisRunSchema),
  'run:subscribe': readContract(wsRunIdPayloadSchema, runSnapshotSchema),
  'run:unsubscribe': readContract(wsRunIdPayloadSchema, z.object({ unsubscribed: z.boolean(), runId: z.string() }).strict()),
  'subagent:list': readContract(wsRunIdPayloadSchema, wsSubAgentListResponseSchema),
  'subagent:get': readContract(wsSubAgentIdentityPayloadSchema, wsSubAgentDetailResponseSchema),
  'subagent:follow-up': writeContract(wsSubAgentFollowUpPayloadSchema, subAgentStateSchema),
  'subagent:cancel': writeContract(wsSubAgentCancelPayloadSchema, subAgentStateSchema),
  'tool:list': readContract(wsEmptyPayloadSchema, z.array(toolDescriptorSchema)),
  'tool:run': writeContract(wsToolRunPayloadSchema, directToolRunResponseSchema),
  'tool-catalog:list': readContract(wsEmptyPayloadSchema, z.array(wsUnknownRecordSchema)),
  'tool-catalog:upsert': writeContract(wsToolCatalogUpsertPayloadSchema, wsUnknownRecordSchema),
  'tool-catalog:delete': writeContract(wsToolCatalogDeletePayloadSchema, wsMutationAckSchema),
  'skill:list': readContract(wsEmptyPayloadSchema, skillCatalogSnapshotSchema),
  'skill:search': readContract(wsSkillSearchPayloadSchema, skillSearchResponseSchema),
  'runtime-config:get': readContract(wsEmptyPayloadSchema, runtimeConfigDocumentSchema),
  'runtime-config:update': writeContract(wsRuntimeConfigUpdatePayloadSchema, runtimeConfigDocumentSchema),
  'provider:list': readContract(wsEmptyPayloadSchema, z.array(modelProviderDescriptorSchema)),
  'provider:custom:list': readContract(wsEmptyPayloadSchema, z.array(customProviderRecordSchema)),
  'provider:credential:stage': writeContract(wsProviderCredentialStagePayloadSchema, providerCredentialStageSchema),
  'provider:custom:discover-models': writeContract(
    wsCustomProviderDiscoverModelsPayloadSchema,
    providerModelDiscoverySchema,
  ),
  'provider:custom:test': writeContract(
    wsCustomProviderTestPayloadSchema,
    customProviderTestResultSchema,
  ),
  'provider:custom:upsert': writeContract(wsCustomProviderUpsertPayloadSchema, customProviderSaveResultSchema),
  'provider:custom:delete': writeContract(
    wsCustomProviderDeletePayloadSchema,
    z.object({ deleted: z.boolean(), providerId: z.string() }).strict(),
  ),
  'system:get': readContract(wsEmptyPayloadSchema, systemComponentsStatusSchema),
  'usage:summary': readContract(wsEmptyPayloadSchema, tokenUsageSummarySchema),
  'usage:thread-summary': readContract(wsThreadIdPayloadSchema, tokenUsageThreadSummarySchema),
  'speech:authorization': writeContract(wsEmptyPayloadSchema, speechAuthorizationSchema),
  'memory:list': readContract(wsMemoryListPayloadSchema, wsMemoryListResponseSchema),
  'memory:read': readContract(wsMemoryReadDeletePayloadSchema, memoryFileRecordSchema),
  'memory:write': writeContract(wsMemoryWritePayloadSchema, memoryFileRecordSchema),
  'memory:delete': writeContract(wsMemoryReadDeletePayloadSchema, wsDeletedMemorySchema),
  'memory:search': readContract(wsMemorySearchPayloadSchema, wsMemorySearchResponseSchema),
  'memory:extract': writeContract(wsMemoryExtractPayloadSchema, wsMemoryListResponseSchema),
  'memory:dream': writeContract(wsMemoryDreamPayloadSchema, wsDreamMemoryResponseSchema),
  'memory:session:get': readContract(wsThreadIdPayloadSchema, threadMemoryDocumentSchema),
  'memory:session:rebuild': writeContract(wsThreadMemoryRebuildPayloadSchema, threadMemoryDocumentSchema),
  'memory:instructions:list': readContract(wsEmptyPayloadSchema, wsInstructionMemoryResponseSchema),
  'file:list': readContract(wsFileListPayloadSchema, wsFileListResponseSchema),
  'file:delete': writeContract(wsFileDeletePayloadSchema, z.object({ deleted: z.boolean(), id: z.string() }).strict()),
  'layer:list': readContract(wsLayerListPayloadSchema, z.array(layerDescriptorSchema)),
  'layer:update': writeContract(wsLayerUpdatePayloadSchema, layerDescriptorSchema),
  'layer:delete': writeContract(wsLayerDeletePayloadSchema, z.object({ deleted: z.boolean(), layerKey: z.string() }).strict()),
  'map-scene:update': writeContract(mapSceneUpdateSchema, mapSceneSchema),
  'automation:list': readContract(wsEmptyPayloadSchema, wsAutomationListResponseSchema),
  'automation:validate': readContract(wsAutomationDraftPayloadSchema, automationValidationResultSchema),
  'automation:create': writeContract(wsAutomationDraftPayloadSchema, automationDefinitionSchema),
  'automation:update': writeContract(wsAutomationUpdatePayloadSchema, automationDefinitionSchema),
  'automation:publish': writeContract(wsAutomationRevisionPayloadSchema, automationDefinitionSchema),
  'automation:disable': writeContract(wsAutomationIdPayloadSchema, automationDefinitionSchema),
  'automation:history': readContract(wsAutomationIdPayloadSchema, z.array(automationVersionRecordSchema)),
  'automation:start': writeContract(wsAutomationStartPayloadSchema, wsAutomationStartResponseSchema),
  'automation:cancel': writeContract(wsAutomationRunIdPayloadSchema, automationRunRecordSchema),
  'automation:run:get': readContract(wsAutomationRunIdPayloadSchema, automationRunRecordSchema),
  'automation:respond-approval': writeContract(wsAutomationApprovalPayloadSchema, wsAutomationApprovalResponseSchema),
  'scheduled-task:list': readContract(wsEmptyPayloadSchema, wsScheduledTaskListResponseSchema),
  'scheduled-task:create': writeContract(wsScheduledTaskCreatePayloadSchema, scheduledTaskSchema),
  'scheduled-task:update': writeContract(wsScheduledTaskUpdatePayloadSchema, scheduledTaskSchema),
  'scheduled-task:delete': writeContract(wsTaskIdPayloadSchema, scheduledTaskSchema),
  'background-task:list': readContract(wsEmptyPayloadSchema, wsBackgroundTaskListResponseSchema),
  'background-task:promote': writeContract(wsTaskIdPayloadSchema, backgroundTaskInfoSchema),
  'background-task:cancel': writeContract(wsTaskIdPayloadSchema, backgroundTaskInfoSchema),
} satisfies Record<WsControlCommand, WsCommandContract>

export type WsCommandContractMap = typeof wsCommandContracts
export type WsCommandPayload<K extends WsControlCommand> = K extends WsControlCommand
  ? z.infer<WsCommandContractMap[K]['payload']>
  : never
export type WsCommandResponse<K extends WsControlCommand> = K extends WsControlCommand
  ? z.infer<WsCommandContractMap[K]['response']>
  : never

export type WsWriteCommand = {
  [K in WsControlCommand]: WsCommandContractMap[K]['category'] extends 'write' ? K : never
}[WsControlCommand]

export function wsCommandContract<K extends WsControlCommand>(type: K): WsCommandContractMap[K] {
  return wsCommandContracts[type]
}

export const wsControlRequestEnvelopeSchema = z.object({
  type: wsControlCommandSchema,
  id: z.string().min(1),
  payload: z.unknown().default({}),
  meta: z.object({
    csrfToken: z.string().min(1).optional(),
  }).strict().optional(),
}).strict()

export type WsControlRequestEnvelope = z.infer<typeof wsControlRequestEnvelopeSchema>

export type WsControlRequestByCommand<K extends WsControlCommand> = {
  type: K
  id: string
  payload: WsCommandPayload<K>
  meta?: {
    csrfToken?: string
  }
}

export type WsControlRequestUnion = {
  [K in WsControlCommand]: WsControlRequestByCommand<K>
}[WsControlCommand]

/**
 * 先校验稳定信封，再用同一份命令契约校验 payload。这样 Server、Main 和
 * Renderer 不会各自维护一套请求联合类型，也不会把未知 payload 带进授权层。
 */
export function parseWsControlRequest(input: unknown): WsControlRequestUnion {
  const envelope = wsControlRequestEnvelopeSchema.parse(input)
  const payload = wsCommandContract(envelope.type).payload.parse(envelope.payload)
  return {
    type: envelope.type,
    id: envelope.id,
    payload,
    ...(envelope.meta ? { meta: envelope.meta } : {}),
  } as WsControlRequestUnion
}

export const wsControlFailureCodeSchema = z.enum([
  'service_unavailable',
  'control_unavailable',
  'invalid_request',
  'unauthorized',
  'command_failed',
  'not_found',
  'forbidden',
  'overloaded',
  'version_conflict',
  'internal_error',
])

export type WsControlFailureCode = z.infer<typeof wsControlFailureCodeSchema>

export const wsControlResponseEnvelopeSchema = z.object({
  type: z.literal('response'),
  id: z.string().nullable(),
  payload: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
    z.object({
      ok: z.literal(false),
      error: z.object({
        code: wsControlFailureCodeSchema,
        message: z.string(),
      }).strict(),
    }).strict(),
  ]),
}).strict()

export type WsControlResponse = z.infer<typeof wsControlResponseEnvelopeSchema>

/**
 * 服务端出站消息的最小信封。消费者先用它保留未知扩展的前向兼容性，再用
 * response/push 的权威 Schema 校验已知消息，禁止各客户端复制信封结构。
 */
export const wsServerMessageEnvelopeSchema = z.object({
  type: z.string().min(1),
  id: z.string().nullable(),
  payload: z.unknown(),
}).strict()

export type WsServerMessageEnvelope = z.infer<typeof wsServerMessageEnvelopeSchema>

const wsPushEnvelope = <const TType extends string, TData extends z.ZodType>(
  type: TType,
  data: TData,
) => z.object({
  type: z.literal(type),
  id: z.null(),
  payload: z.object({ data }).strict(),
}).strict()

export const wsRunPushSchema = z.discriminatedUnion('type', [
  wsPushEnvelope('run.item', runItemUpsertSchema),
  wsPushEnvelope('run.item.delta', conversationItemTextDeltaSchema),
  wsPushEnvelope('run.event', runEventSchema),
  wsPushEnvelope('run.snapshot', runSnapshotSchema),
  wsPushEnvelope('thread.entry', transcriptEntrySchema),
  wsPushEnvelope('thread.updated', z.object({
    thread: agentThreadRecordSchema,
    manifest: threadManifestSchema,
  }).strict()),
  wsPushEnvelope('thread.compacted', compactionRecordSchema),
  wsPushEnvelope('thread.memory.updated', threadMemoryDocumentSchema),
  wsPushEnvelope('map.scene.updated', mapSceneSchema),
])

export type WsRunPush = z.infer<typeof wsRunPushSchema>

export const wsKeepalivePushSchema = wsPushEnvelope('keepalive', z.object({}).strict())

/** 所有服务端主动推送的唯一协议事实源。 */
export const wsServerPushSchema = z.union([
  wsRunPushSchema,
  wsKeepalivePushSchema,
])

export type WsServerPush = z.infer<typeof wsServerPushSchema>
export type WsServerPushType = WsServerPush['type']
export type WsServerPushData<K extends WsServerPushType> = Extract<
  WsServerPush,
  { type: K }
>['payload']['data']

export const wsServerPushTypeSchema = z.enum([
  'run.item',
  'run.item.delta',
  'run.event',
  'run.snapshot',
  'thread.entry',
  'thread.updated',
  'thread.compacted',
  'thread.memory.updated',
  'map.scene.updated',
  'keepalive',
])

/** 已知的服务端响应与推送；用于严格的 Main/服务端传输边界。 */
export const wsServerMessageSchema = z.union([
  wsControlResponseEnvelopeSchema,
  wsServerPushSchema,
])

export type WsServerMessage = z.infer<typeof wsServerMessageSchema>

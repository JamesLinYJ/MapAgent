// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机运维监督协议
//
//   文件:       operations.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

export const OPERATIONS_PROTOCOL_VERSION = 5 as const

export const operationsServiceIdSchema = z.enum(['infra', 'worker', 'api'])
export const operationsProfileSchema = z.enum(['development', 'production'])
export const operationsServiceStateSchema = z.enum([
  'stopped',
  'waiting_dependency',
  'starting',
  'healthy',
  'degraded',
  'stopping',
  'restart_wait',
  'failed',
  'conflict',
])

export const operationsMetricSchema = z.object({
  value: z.number().finite().nullable(),
  unavailableReason: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.value === null && !value.unavailableReason) {
    context.addIssue({
      code: 'custom',
      message: '不可用指标必须说明原因。',
      path: ['unavailableReason'],
    })
  }
  if (value.value !== null && value.unavailableReason) {
    context.addIssue({
      code: 'custom',
      message: '可用指标不能同时声明不可用原因。',
      path: ['unavailableReason'],
    })
  }
})

export const operationsServiceSnapshotSchema = z.object({
  serviceId: operationsServiceIdSchema,
  displayName: z.string().min(1),
  description: z.string().min(1),
  state: operationsServiceStateSchema,
  healthMessage: z.string().min(1),
  pid: z.number().int().positive().nullable(),
  cpuPercent: operationsMetricSchema,
  memoryBytes: operationsMetricSchema,
  startedAt: z.string().datetime().nullable(),
  uptimeSeconds: z.number().int().nonnegative().nullable(),
  restartCount: z.number().int().nonnegative(),
  lastExitCode: z.union([z.string(), z.number().int()]).nullable(),
  blockedBy: z.array(operationsServiceIdSchema),
}).strict()

export const operationsHostSnapshotSchema = z.object({
  hostname: z.string().min(1),
  platform: z.string().min(1),
  release: z.string().min(1),
  profile: operationsProfileSchema,
  supervisorPid: z.number().int().positive(),
  supervisorStartedAt: z.string().datetime(),
  cpuPercent: operationsMetricSchema,
  memoryUsedBytes: operationsMetricSchema,
  memoryTotalBytes: operationsMetricSchema,
  runtimeDiskUsedBytes: operationsMetricSchema,
  runtimeDiskTotalBytes: operationsMetricSchema,
  sampledAt: z.string().datetime(),
}).strict()

export const operationsSnapshotSchema = z.object({
  sequence: z.number().int().nonnegative(),
  host: operationsHostSnapshotSchema,
  services: z.array(operationsServiceSnapshotSchema).length(3),
  observability: z.object({
    diagnostics: z.object({
      enabled: z.boolean(),
      expiresAt: z.string().datetime().nullable(),
      retainedEntries: z.number().int().nonnegative(),
      retainedBytes: z.number().int().nonnegative(),
      maxBytes: z.number().int().positive(),
      oldestCreatedAt: z.string().datetime().nullable(),
    }).strict(),
    persistence: z.object({
      state: z.enum(['healthy', 'degraded', 'retrying']),
      message: z.string().min(1),
      lastSuccessAt: z.string().datetime().nullable(),
      lastErrorAt: z.string().datetime().nullable(),
    }).strict(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (new Set(value.services.map(service => service.serviceId)).size !== 3) {
    context.addIssue({ code: 'custom', message: '服务快照必须且只能包含三个固定后台服务。', path: ['services'] })
  }
})

export const operationsLogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'unknown'])
export const operationsLogStreamSchema = z.enum(['stdout', 'stderr', 'supervisor'])
export const operationsLogCategorySchema = z.enum([
  'lifecycle',
  'health',
  'request',
  'agent',
  'model',
  'tool',
  'storage',
  'security',
  'ui',
  'system',
])
export const operationsLogRetentionSchema = z.enum(['operational', 'diagnostic'])
export const operationsLogCorrelationSchema = z.object({
  traceId: z.string().min(1).max(160).optional(),
  runId: z.string().min(1).max(160).optional(),
  threadId: z.string().min(1).max(160).optional(),
  requestId: z.string().min(1).max(160).optional(),
  responseId: z.string().min(1).max(160).optional(),
}).strict()
export const operationsLogAttributeValueSchema = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
])
export const operationsLogEntrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  serviceId: operationsServiceIdSchema.nullable(),
  component: z.string().min(1).max(80).nullable(),
  processId: z.number().int().positive().nullable(),
  stream: operationsLogStreamSchema,
  level: operationsLogLevelSchema,
  event: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u).max(120),
  category: operationsLogCategorySchema,
  retention: operationsLogRetentionSchema,
  correlation: operationsLogCorrelationSchema,
  message: z.string(),
  errorStack: z.string().max(8_000).nullable(),
  attributes: z.record(
    z.string().min(1).max(80),
    operationsLogAttributeValueSchema,
  ).default({}),
  createdAt: z.string().datetime(),
}).strict()

export const operationsLogFilterSchema = z.object({
  services: z.array(operationsServiceIdSchema).min(1).max(3),
  levels: z.array(operationsLogLevelSchema).max(5).default([]),
  streams: z.array(operationsLogStreamSchema).max(3).default([]),
  categories: z.array(operationsLogCategorySchema).max(10).default([]),
  events: z.array(z.string().min(1).max(120)).max(50).default([]),
  retentions: z.array(operationsLogRetentionSchema).max(2).default([]),
  correlationId: z.string().trim().max(160).default(''),
  search: z.string().trim().max(200).default(''),
  includeSupervisor: z.boolean().default(false),
  afterSequence: z.number().int().nonnegative().nullable().default(null),
}).strict()

export const operationsLogQuerySchema = operationsLogFilterSchema.extend({
  tail: z.number().int().min(0).max(10_000),
}).strict()

export const operationsLogPageSchema = z.object({
  entries: z.array(operationsLogEntrySchema),
  nextCursor: z.number().int().nonnegative().nullable(),
  hasMore: z.boolean(),
}).strict()

export const operationsActionSchema = z.enum(['start', 'stop', 'restart', 'shutdown'])
export const operationsTargetSchema = z.union([operationsServiceIdSchema, z.literal('all')])
export const operationsOperationResultSchema = z.object({
  operationId: z.string().uuid(),
  action: operationsActionSchema,
  target: operationsTargetSchema,
  outcome: z.enum(['succeeded', 'failed', 'partial']),
  message: z.string().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
}).strict()

const requestBaseSchema = z.object({
  kind: z.literal('request'),
  requestId: z.string().uuid(),
})

export const operationsRequestSchema = z.discriminatedUnion('action', [
  requestBaseSchema.extend({ action: z.literal('status') }).strict(),
  requestBaseSchema.extend({
    action: z.literal('subscribe'),
    metrics: z.boolean(),
    logs: z.boolean(),
    logFilter: operationsLogFilterSchema.optional(),
  }).strict(),
  requestBaseSchema.extend({
    action: z.enum(['start', 'restart']),
    operationId: z.string().uuid(),
    target: operationsTargetSchema,
  }).strict(),
  requestBaseSchema.extend({
    action: z.literal('stop'),
    operationId: z.string().uuid(),
    target: operationsTargetSchema,
    keepInfra: z.boolean().optional(),
  }).strict(),
  requestBaseSchema.extend({
    action: z.literal('logs'),
    query: operationsLogQuerySchema,
  }).strict(),
  requestBaseSchema.extend({
    action: z.literal('history_logs'),
    query: operationsLogQuerySchema,
  }).strict(),
  requestBaseSchema.extend({
    action: z.literal('operation_result'),
    operationId: z.string().uuid(),
  }).strict(),
  requestBaseSchema.extend({ action: z.literal('diagnostics_start') }).strict(),
  requestBaseSchema.extend({ action: z.literal('diagnostics_stop') }).strict(),
  requestBaseSchema.extend({
    action: z.literal('shutdown'),
    operationId: z.string().uuid(),
  }).strict(),
])

export const operationsResponsePayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), snapshot: operationsSnapshotSchema }).strict(),
  z.object({ type: z.literal('subscribed') }).strict(),
  z.object({ type: z.literal('logs'), page: operationsLogPageSchema }).strict(),
  z.object({
    type: z.literal('diagnostics'),
    diagnostics: operationsSnapshotSchema.shape.observability.shape.diagnostics,
  }).strict(),
  z.object({ type: z.literal('operation'), operation: operationsOperationResultSchema.nullable() }).strict(),
])

export const operationsResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    kind: z.literal('response'),
    requestId: z.string().uuid(),
    ok: z.literal(true),
    payload: operationsResponsePayloadSchema,
  }).strict(),
  z.object({
    kind: z.literal('response'),
    requestId: z.string().uuid(),
    ok: z.literal(false),
    error: z.object({
      code: z.enum(['invalid_request', 'unauthorized', 'not_found', 'conflict', 'operation_failed', 'internal_error']),
      message: z.string().min(1),
    }).strict(),
  }).strict(),
])

export const operationsEventSchema = z.discriminatedUnion('event', [
  z.object({ kind: z.literal('event'), event: z.literal('snapshot'), snapshot: operationsSnapshotSchema }).strict(),
  z.object({ kind: z.literal('event'), event: z.literal('log'), entry: operationsLogEntrySchema }).strict(),
  z.object({ kind: z.literal('event'), event: z.literal('operation'), operation: operationsOperationResultSchema }).strict(),
])

export const operationsClientHelloSchema = z.object({
  kind: z.literal('hello'),
  protocolVersion: z.literal(OPERATIONS_PROTOCOL_VERSION),
  token: z.string().min(32).max(512),
  client: z.object({
    processId: z.number().int().positive(),
    osUser: z.string().min(1),
    hostname: z.string().min(1),
    interactive: z.boolean(),
  }).strict(),
}).strict()

export const operationsServerHelloSchema = z.object({
  kind: z.literal('welcome'),
  protocolVersion: z.literal(OPERATIONS_PROTOCOL_VERSION),
  daemonId: z.string().uuid(),
  workspaceId: z.string().min(16),
  profile: operationsProfileSchema,
}).strict()

export const operationsServerRejectSchema = z.object({
  kind: z.literal('rejected'),
  protocolVersion: z.number().int().positive(),
  code: z.enum(['invalid_handshake', 'incompatible_version', 'unauthorized', 'frame_too_large']),
  message: z.string().min(1),
}).strict()

export const operationsServerHandshakeSchema = z.discriminatedUnion('kind', [
  operationsServerHelloSchema,
  operationsServerRejectSchema,
])

export type OperationsServiceId = z.infer<typeof operationsServiceIdSchema>
export type OperationsProfile = z.infer<typeof operationsProfileSchema>
export type OperationsServiceState = z.infer<typeof operationsServiceStateSchema>
export type OperationsMetric = z.infer<typeof operationsMetricSchema>
export type OperationsServiceSnapshot = z.infer<typeof operationsServiceSnapshotSchema>
export type OperationsHostSnapshot = z.infer<typeof operationsHostSnapshotSchema>
export type OperationsSnapshot = z.infer<typeof operationsSnapshotSchema>
export type OperationsLogEntry = z.infer<typeof operationsLogEntrySchema>
export type OperationsLogCategory = z.infer<typeof operationsLogCategorySchema>
export type OperationsLogRetention = z.infer<typeof operationsLogRetentionSchema>
export type OperationsLogFilter = z.infer<typeof operationsLogFilterSchema>
export type OperationsLogQuery = z.infer<typeof operationsLogQuerySchema>
export type OperationsLogPage = z.infer<typeof operationsLogPageSchema>
export type OperationsOperationResult = z.infer<typeof operationsOperationResultSchema>
export type OperationsRequest = z.infer<typeof operationsRequestSchema>
export type OperationsResponse = z.infer<typeof operationsResponseSchema>
export type OperationsEvent = z.infer<typeof operationsEventSchema>
export type OperationsClientHello = z.infer<typeof operationsClientHelloSchema>
export type OperationsServerHello = z.infer<typeof operationsServerHelloSchema>
export type OperationsServerReject = z.infer<typeof operationsServerRejectSchema>
export type OperationsHandshake = OperationsClientHello | z.infer<typeof operationsServerHandshakeSchema>

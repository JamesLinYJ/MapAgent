// +-------------------------------------------------------------------------
//
//   地理智能平台 - 资源与控制面协议
//
//   文件:       resources.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'
import { runStatusSchema } from './core.js'
import { mapCoordinateSchema } from './map.js'
import { resourceVisibilitySchema } from './platform.js'

// --- Resources ---

export const layerPropertyDescriptorSchema = z.object({
  name: z.string(),
  dataType: z.string(),
  populatedCount: z.number().default(0),
  sampleValues: z.array(z.string()).default([]),
})

export const layerDescriptorSchema = z.object({
  mapLayerId: z.string().trim().min(1),
  layerKey: z.string(),
  name: z.string(),
  sourceType: z.string(),
  geometryType: z.string(),
  srid: z.number().default(4326),
  description: z.string(),
  featureCount: z.number().nullable().default(null),
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().default(null),
  propertySchema: z.array(layerPropertyDescriptorSchema).default([]),
  category: z.string().default('general'),
  status: z.string().default('active'),
  tags: z.array(z.string()).default([]),
  analysisCapabilities: z.array(z.string()).default([]),
  sourceConfigSummary: z.string().nullable().default(null),
  sessionId: z.string().nullable().default(null),
  threadId: z.string().nullable().default(null),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  visibility: resourceVisibilitySchema,
  readonly: z.boolean().default(false),
  createdAt: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
})

export const basemapDescriptorSchema = z.object({
  basemapKey: z.string(),
  name: z.string(),
  provider: z.string(),
  kind: z.string(),
  attribution: z.string().default(''),
  tileUrls: z.array(z.string()).default([]),
  labelTileUrls: z.array(z.string()).default([]),
  available: z.boolean().default(true),
  isDefault: z.boolean().default(false),
})

export const agentRuntimeCapabilitiesSchema = z.object({
  transport: z.enum(['deepseek_responses', 'openai_responses', 'openai_chat_completions', 'none']),
  structuredOutput: z.enum(['json_object', 'json_schema', 'none']),
  functionTools: z.boolean(),
  deferredTools: z.boolean(),
  toolNamespaces: z.boolean(),
  localMcp: z.boolean(),
  hostedTools: z.boolean(),
  handoffs: z.boolean(),
  multiToolResponse: z.boolean(),
  providerParallelToolControl: z.boolean(),
  remoteConversation: z.boolean(),
  serverCompaction: z.boolean(),
})

export const modelInputModalitySchema = z.enum(['text', 'image', 'audio', 'pdf'])

export const modelCapabilityFlagsSchema = z.object({
  reasoning: z.boolean(),
  structuredOutput: z.boolean(),
  toolCalls: z.boolean(),
}).strict()

export const modelCapabilitySnapshotSchema = z.object({
  modelId: z.string().trim()
    .min(1, '请输入模型 ID')
    .max(200, '模型 ID 不能超过 200 个字符'),
  contextWindowTokens: z.number({ error: '上下文词元必须是数字' })
    .int('上下文词元必须是整数')
    .min(1_024, '上下文词元不能少于 1024')
    .max(10_000_000, '上下文词元不能超过 10000000'),
  capabilities: modelCapabilityFlagsSchema,
  modalities: z.array(modelInputModalitySchema)
    .min(1, '至少选择一种输入模态')
    .max(4, '输入模态不能超过四种'),
}).strict().superRefine((model, context) => {
  if (new Set(model.modalities).size !== model.modalities.length) {
    context.addIssue({ code: 'custom', path: ['modalities'], message: '模态声明不能重复' })
  }
  if (!model.modalities.includes('text')) {
    context.addIssue({ code: 'custom', path: ['modalities'], message: '模型必须支持文本输入' })
  }
})

export const modelProviderDescriptorSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  configured: z.boolean(),
  source: z.enum(['builtin', 'custom']).default('builtin'),
  defaultModel: z.string().nullable().default(null),
  availableModels: z.array(z.string()).default([]),
  models: z.array(modelCapabilitySnapshotSchema).default([]),
  capabilities: z.array(z.string()).default([]),
  modalities: z.array(modelInputModalitySchema).default(['text']),
  protocol: z.enum(['responses', 'chat_completions']).nullable().default(null),
  agentRuntime: agentRuntimeCapabilitiesSchema,
  contextWindowTokens: z.number().int().positive().default(128000),
})

// Renderer 可附加普通图片或地图截图。地图截图的空间/时间上下文是结构化数据，
// 不由图片文字或模型反向推断，服务端会把它作为不可信用户内容处理。
const mapScreenshotBoundsSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]).refine(([west, south, east, north]) => west !== east && south < north, {
  // west > east 是跨日期变更线视口的标准包装表示，不能强行扩成全球范围。
  message: '地图截图范围必须满足 west != east 且 south < north',
})

export const mapScreenshotContextSchema = z.object({
  capturedAt: z.string().datetime({ offset: true }),
  viewport: z.object({
    bounds: mapScreenshotBoundsSchema,
    center: mapCoordinateSchema,
    zoom: z.number().finite().min(0).max(24),
    bearing: z.number().finite().min(-360).max(360),
    pitch: z.number().finite().min(0).max(85),
  }).strict(),
  // viewport 数值是 MapLibre 对外暴露的 [longitude, latitude]；
  // 画布内部的 Web Mercator 投影单独记录，避免把经纬度误标为 EPSG:3857。
  crs: z.literal('OGC:CRS84'),
  renderProjection: z.literal('EPSG:3857'),
  renderState: z.object({
    status: z.literal('idle'),
    tilesLoaded: z.literal(true),
  }).strict(),
  renderedLayers: z.array(z.object({
    mapLayerId: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(300),
    currentFrameId: z.string().trim().min(1).max(200).nullable(),
    validTime: z.string().datetime({ offset: true }).nullable(),
  }).strict()).max(100),
  timeRange: z.object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  }).strict().refine(value => Date.parse(value.start) <= Date.parse(value.end), {
    message: '地图截图时间范围必须满足 start <= end',
  }).nullable(),
}).strict()

const runAttachmentBaseShape = {
  fileId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(255),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
}

export const runAttachmentInputSchema = z.discriminatedUnion('kind', [
  z.object({
    ...runAttachmentBaseShape,
    kind: z.literal('image'),
    mapContext: z.null().default(null),
  }).strict(),
  z.object({
    ...runAttachmentBaseShape,
    kind: z.literal('map_screenshot'),
    mapContext: mapScreenshotContextSchema,
  }).strict(),
])

export const runAttachmentsSchema = z.array(runAttachmentInputSchema).max(12).superRefine(
  (attachments, context) => {
    const seen = new Set<string>()
    attachments.forEach((attachment, index) => {
      if (seen.has(attachment.fileId)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'fileId'],
          message: '同一次运行不能重复附加同一文件',
        })
      }
      seen.add(attachment.fileId)
    })
  },
)

export const customProviderIdSchema = z.string()
  .trim()
  .min(1, '请输入服务标识')
  .max(64, '服务标识不能超过 64 个字符')
  .regex(/^[a-z0-9][a-z0-9_-]*$/u, '服务标识只能包含小写字母、数字、连字符和下划线')

export const customProviderProtocolSchema = z.enum(['responses', 'chat_completions'])
export const customProviderModalitySchema = modelInputModalitySchema

export const customProviderConfigSchema = z.object({
  providerId: customProviderIdSchema,
  displayName: z.string().trim()
    .min(1, '请输入显示名称')
    .max(120, '显示名称不能超过 120 个字符'),
  baseUrl: z.string().trim()
    .min(1, '请输入接口地址')
    .url('请输入有效的接口地址')
    .max(2048, '接口地址不能超过 2048 个字符'),
  protocol: customProviderProtocolSchema,
  models: z.array(modelCapabilitySnapshotSchema)
    .min(1, '请至少添加一个模型')
    .max(100, '最多只能保存 100 个模型'),
  defaultModel: z.string().trim()
    .min(1, '请选择默认模型')
    .max(200, '默认模型 ID 不能超过 200 个字符'),
  toolSchemaMode: z.enum(['strict', 'compatible']),
}).strict().superRefine((config, context) => {
  const modelIds = config.models.map(model => model.modelId)
  if (new Set(modelIds).size !== modelIds.length) {
    context.addIssue({ code: 'custom', path: ['models'], message: '模型 ID 不能重复' })
  }
  const defaultModel = config.models.find(model => model.modelId === config.defaultModel)
  if (!defaultModel) {
    context.addIssue({ code: 'custom', path: ['defaultModel'], message: '默认模型必须在模型清单中' })
  }
})

export const customProviderRecordSchema = customProviderConfigSchema.extend({
  revision: z.number().int().positive(),
  hasApiKey: z.boolean(),
  createdByUserId: z.string().min(1),
  lastValidatedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const providerCredentialStageSchema = z.object({
  credentialHandle: z.string().min(1),
  expiresAt: z.string(),
}).strict()

export const providerDiscoveredModelSchema = z.object({
  modelId: z.string().trim().min(1).max(200),
  ownedBy: z.string().trim().min(1).max(200).nullable(),
}).strict()

export const providerModelDiscoverySchema = z.object({
  models: z.array(providerDiscoveredModelSchema).max(200),
  latencyMs: z.number().nonnegative(),
  testedAt: z.string().datetime({ offset: true }),
}).strict()

export const customProviderValidationSchema = z.object({
  connectivityOk: z.literal(true),
  modelCallOk: z.literal(true),
  testedModel: z.string().min(1),
  latencyMs: z.number().nonnegative(),
  testedAt: z.string(),
}).strict()

export const customProviderSaveResultSchema = z.object({
  provider: customProviderRecordSchema,
  descriptor: modelProviderDescriptorSchema,
  validation: customProviderValidationSchema.nullable(),
}).strict()

export const customProviderTestModeSchema = z.enum([
  'connectivity',
  'models',
  'model_call',
])

export const customProviderTestResultSchema = z.object({
  mode: customProviderTestModeSchema,
  connectivityOk: z.boolean(),
  modelCallOk: z.boolean().nullable(),
  testedModel: z.string().min(1).nullable(),
  models: z.array(providerDiscoveredModelSchema).max(200),
  latencyMs: z.number().nonnegative(),
  testedAt: z.string().datetime({ offset: true }),
  warning: z.string().min(1).nullable(),
}).strict()

export const speechLanguageOptionSchema = z.object({
  locale: z.string(),
  label: z.string(),
})

export const speechAuthorizationSchema = z.object({
  authorizationToken: z.string(),
  region: z.string(),
  endpoint: z.string(),
  expiresAt: z.string(),
  defaultLanguage: z.string(),
  supportedLanguages: z.array(speechLanguageOptionSchema).default([]),
})

export const systemComponentsStatusSchema = z.object({
  catalogBackend: z.string(),
  postgisEnabled: z.boolean(),
  postgisError: z.string().nullable().default(null),
  payloadStoreRoot: z.string().nullable().default(null),
  providers: z.array(modelProviderDescriptorSchema).default([]),
  toolProviders: z.array(z.object({
    providerId: z.string(),
    name: z.string(),
    version: z.string().nullable().default(null),
    author: z.string().nullable().default(null),
    language: z.string().nullable().default(null),
    toolCount: z.number().default(0),
    available: z.boolean(),
    error: z.string().nullable(),
  })).default([]),
})

export const skillSourceKindSchema = z.enum(['builtin', 'direct', 'root'])
export const skillTrustStatusSchema = z.enum(['builtin', 'trusted', 'untrusted', 'content_changed'])

export const skillCatalogEntrySchema = z.object({
  skillId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
  description: z.string(),
  aliases: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  capabilityRequirements: z.array(z.string()).default([]),
  source: z.object({
    kind: skillSourceKindSchema,
    label: z.string().trim().min(1),
  }).strict(),
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  enabled: z.boolean(),
  trustStatus: skillTrustStatusSchema,
  active: z.boolean(),
  diagnostic: z.string().nullable().default(null),
})

export const skillCatalogDiagnosticSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  sourceLabel: z.string().nullable().default(null),
  skillId: z.string().nullable().default(null),
})

export const skillCatalogSnapshotSchema = z.object({
  globalEnabled: z.boolean(),
  autoMatchThreshold: z.number().min(0).max(1),
  candidateThreshold: z.number().min(0).max(1),
  entries: z.array(skillCatalogEntrySchema),
  diagnostics: z.array(skillCatalogDiagnosticSchema),
})

export const skillMatchResultSchema = z.object({
  skillId: z.string(),
  name: z.string(),
  score: z.number().min(0).max(1),
  matchKind: z.enum(['explicit', 'exact', 'relevance']),
  reason: z.string(),
  autoLoad: z.boolean(),
  trustStatus: skillTrustStatusSchema,
  enabled: z.boolean(),
})

export const skillSearchResponseSchema = z.object({
  query: z.string(),
  matches: z.array(skillMatchResultSchema),
})

export const toolParameterOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
})

export const toolParameterDescriptorSchema = z.object({
  key: z.string(),
  label: z.string(),
  dataType: z.string(),
  source: z.string().default('text'),
  required: z.boolean().default(false),
  description: z.string().nullable().default(null),
  placeholder: z.string().nullable().default(null),
  defaultValue: z.unknown().nullable().default(null),
  options: z.array(toolParameterOptionSchema).default([]),
  acceptedValueRefKinds: z.array(z.string()).default([]),
})

export const toolDescriptorSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  group: z.string(),
  toolKind: z.string().default('registry'),
  providerId: z.string().nullable().default(null),
  language: z.string().nullable().default(null),
  isReadOnly: z.boolean().default(true),
  isDestructive: z.boolean().default(false),
  parallelSafe: z.boolean().default(false),
  available: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
  parameters: z.array(toolParameterDescriptorSchema).default([]),
  error: z.string().nullable().default(null),
  meta: z.record(z.string(), z.unknown()).prefault({}),
})

export const automationNodeTypeSchema = z.enum([
  'trigger',
  'tool',
  'agent',
  'condition',
  'approval',
  'output',
])

export const automationBindingSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('literal'), value: z.unknown() }),
  z.object({ source: z.literal('input'), path: z.string().min(1) }),
  z.object({ source: z.literal('node'), nodeId: z.string().min(1), path: z.string().min(1) }),
  z.object({
    source: z.literal('value_ref'),
    nodeId: z.string().min(1),
    kind: z.string().min(1),
    path: z.string().min(1).default('refId'),
  }),
])

export const automationRetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(5).default(1),
  backoffSeconds: z.number().int().min(0).max(300).default(0),
})

// Agent 调用前置条件是自动化定义的一部分，由调用边界确定性校验。
// 新资源类型通过扩展此联合类型接入，不把具体 automationId 写入运行时分支。
export const automationInvocationRequirementSchema = z.discriminatedUnion('resource', [
  z.object({
    resource: z.literal('meteorological_files'),
    scope: z.enum(['thread', 'session']).default('thread'),
    minimumCount: z.number().int().min(1).max(500),
    readyOnly: z.boolean().default(true),
  }).strict(),
])

export const automationAgentInvocationSchema = z.object({
  enabled: z.boolean().default(false),
  description: z.string().default(''),
  examples: z.array(z.string().min(1)).max(12).default([]),
  requirements: z.array(automationInvocationRequirementSchema).max(12).default([]),
}).strict()

const automationNodeBaseSchema = z.object({
  nodeId: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(''),
  position: z.object({ x: z.number(), y: z.number() }),
})

export const automationTriggerNodeSchema = automationNodeBaseSchema.extend({
  type: z.literal('trigger'),
  config: z.object({}),
})

export const automationToolNodeSchema = automationNodeBaseSchema.extend({
  type: z.literal('tool'),
  config: z.object({
    toolName: z.string().min(1),
    arguments: z.record(z.string(), automationBindingSchema).prefault({}),
    approvalMode: z.enum(['auto', 'always']).default('auto'),
    retry: automationRetryPolicySchema.default({ maxAttempts: 1, backoffSeconds: 0 }),
  }),
})

export const automationAgentNodeSchema = automationNodeBaseSchema.extend({
  type: z.literal('agent'),
  config: z.object({
    promptTemplate: z.string().min(1),
    executionMode: z.enum(['auto', 'plan']).default('auto'),
    reasoning: z.boolean().default(true),
    retry: automationRetryPolicySchema.default({ maxAttempts: 1, backoffSeconds: 0 }),
  }),
})

export const automationConditionNodeSchema = automationNodeBaseSchema.extend({
  type: z.literal('condition'),
  config: z.object({
    left: automationBindingSchema,
    operator: z.enum(['equals', 'not_equals', 'greater_than', 'greater_or_equal', 'less_than', 'less_or_equal', 'contains', 'exists', 'is_true']),
    right: automationBindingSchema.nullable().default(null),
  }),
})

export const automationApprovalNodeSchema = automationNodeBaseSchema.extend({
  type: z.literal('approval'),
  config: z.object({
    title: z.string().min(1),
    question: z.string().min(1),
    description: z.string().default(''),
  }),
})

export const automationOutputNodeSchema = automationNodeBaseSchema.extend({
  type: z.literal('output'),
  config: z.object({
    outputs: z.record(z.string(), automationBindingSchema).prefault({}),
  }),
})

export const automationNodeSchema = z.discriminatedUnion('type', [
  automationTriggerNodeSchema,
  automationToolNodeSchema,
  automationAgentNodeSchema,
  automationConditionNodeSchema,
  automationApprovalNodeSchema,
  automationOutputNodeSchema,
])

export const automationEdgePortSchema = z.enum([
  'default',
  'success',
  'error',
  'true',
  'false',
  'approved',
  'rejected',
])

export const automationEdgeSchema = z.object({
  edgeId: z.string().min(1),
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
  sourcePort: automationEdgePortSchema.default('default'),
})

export const automationGraphSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  entryNodeId: z.string().min(1),
  nodes: z.array(automationNodeSchema).min(2),
  edges: z.array(automationEdgeSchema).min(1),
  viewport: z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number().positive(),
  }).default({ x: 0, y: 0, zoom: 1 }),
})

export const automationDefinitionSchema = z.object({
  automationId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  revision: z.number().int().positive().default(1),
  publishedRevision: z.number().int().positive().nullable().default(null),
  source: z.enum(['builtin', 'workspace']).default('builtin'),
  lifecycle: z.enum(['draft', 'published', 'disabled']).default('published'),
  workspaceId: z.string().nullable().default(null),
  createdByUserId: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
  parametersSchema: z.record(z.string(), z.unknown()).prefault({}),
  defaultParameters: z.record(z.string(), z.unknown()).prefault({}),
  requiredTools: z.array(z.string()).default([]),
  requiresApproval: z.boolean().default(false),
  timeoutSeconds: z.number().int().positive().default(900),
  outputType: z.string().default('conversation'),
  agentInvocation: automationAgentInvocationSchema.default({
    enabled: false,
    description: '',
    examples: [],
    requirements: [],
  }),
  graph: automationGraphSchema,
  createdAt: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
})

export const automationValidationIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
  nodeId: z.string().nullable().default(null),
  edgeId: z.string().nullable().default(null),
  path: z.string().nullable().default(null),
})

export const automationValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(automationValidationIssueSchema),
  topologicalOrder: z.array(z.string()),
  requiredTools: z.array(z.string()),
})

export const automationVersionRecordSchema = z.object({
  automationId: z.string(),
  revision: z.number().int().positive(),
  lifecycle: z.enum(['draft', 'published', 'archived']),
  definition: automationDefinitionSchema,
  createdByUserId: z.string().nullable().default(null),
  createdAt: z.string(),
  publishedAt: z.string().nullable().default(null),
})

export const automationNodeRunSchema = z.object({
  nodeId: z.string(),
  nodeType: automationNodeTypeSchema,
  label: z.string(),
  status: z.enum(['pending', 'running', 'waiting_approval', 'completed', 'skipped', 'failed', 'cancelled']),
  attempt: z.number().int().nonnegative().default(0),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  output: z.record(z.string(), z.unknown()).prefault({}),
})

export const automationApprovalRequestSchema = z.object({
  approvalId: z.string(),
  nodeId: z.string(),
  title: z.string(),
  question: z.string(),
  description: z.string().default(''),
  status: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.string(),
  resolvedAt: z.string().nullable().default(null),
  resolvedByUserId: z.string().nullable().default(null),
})

export const scheduledTaskSchema = z.object({
  taskId: z.string(),
  targetKind: z.enum(['automation']),
  targetId: z.string(),
  workspaceId: z.string(),
  createdByUserId: z.string(),
  title: z.string(),
  prompt: z.string(),
  parameters: z.record(z.string(), z.unknown()).prefault({}),
  cron: z.string(),
  timezone: z.string(),
  recurring: z.boolean().default(true),
  enabled: z.boolean().default(true),
  status: z.enum(['active', 'paused', 'missed', 'failed', 'deleted']).default('active'),
  lastFiredAt: z.string().nullable().default(null),
  nextFireAt: z.string().nullable().default(null),
  lastRunId: z.string().nullable().default(null),
  queueJobId: z.string().nullable().default(null),
  failureCount: z.number().int().nonnegative().default(0),
  lastErrorMessage: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const automationRunRecordSchema = z.object({
  automationRunId: z.string(),
  automationId: z.string(),
  scheduledTaskId: z.string().nullable().default(null),
  workspaceId: z.string(),
  createdByUserId: z.string(),
  runId: z.string().nullable().default(null),
  automationRevision: z.number().int().positive().default(1),
  status: z.enum(['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled']).default('queued'),
  currentStep: z.string().nullable().default(null),
  triggerKind: z.enum(['manual', 'schedule', 'agent']).default('manual'),
  errorMessage: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
  nodeRuns: z.array(automationNodeRunSchema).default([]),
  pendingApproval: automationApprovalRequestSchema.nullable().default(null),
  outputs: z.record(z.string(), z.unknown()).prefault({}),
  startedAt: z.string(),
  completedAt: z.string().nullable().default(null),
})

export const backgroundTaskInfoSchema = z.object({
  taskId: z.string(),
  kind: z.string(),
  label: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  workspaceId: z.string().nullable().default(null),
  userId: z.string().nullable().default(null),
  runId: z.string().nullable().default(null),
  startedAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
})

export const tokenUsageTotalsSchema = z.object({
  runCount: z.number().int().nonnegative(),
  runsWithUsage: z.number().int().nonnegative(),
  runsWithoutUsage: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheHitInputTokens: z.number().int().nonnegative(),
  cacheMeasuredInputTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative(),
  contextEstimatedTokens: z.number().int().nonnegative(),
  resultCacheHitCount: z.number().int().nonnegative(),
  resultCacheAvoidedRequestCount: z.number().int().nonnegative(),
  resultCacheEstimatedSavedTokens: z.number().int().nonnegative(),
})

export const tokenUsageBucketSchema = tokenUsageTotalsSchema.extend({
  key: z.string(),
  label: z.string(),
})

export const tokenUsageRunSchema = z.object({
  runId: z.string(),
  threadId: z.string().nullable().default(null),
  sessionId: z.string(),
  userQuery: z.string(),
  modelProvider: z.string().nullable().default(null),
  modelName: z.string().nullable().default(null),
  status: runStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheHitInputTokens: z.number().int().nonnegative(),
  cacheMeasuredInputTokens: z.number().int().nonnegative().default(0),
  resultCacheHitCount: z.number().int().nonnegative(),
  resultCacheAvoidedRequestCount: z.number().int().nonnegative(),
  resultCacheEstimatedSavedTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  contextEstimatedTokens: z.number().int().nonnegative(),
  contextUsagePermille: z.number().int().nonnegative().nullable().default(null),
  usageResponseCount: z.number().int().nonnegative(),
  hasUsage: z.boolean(),
})

export const tokenUsageLimitSchema = z.object({
  period: z.enum(['day', 'month']),
  label: z.string(),
  enabled: z.boolean(),
  limitTokens: z.number().int().nonnegative().nullable().default(null),
  usedTokens: z.number().int().nonnegative(),
  remainingTokens: z.number().int().nullable().default(null),
  exceeded: z.boolean(),
  resetsAt: z.string(),
})

export const tokenUsageSummarySchema = z.object({
  workspaceId: z.string(),
  generatedAt: z.string(),
  totals: tokenUsageTotalsSchema,
  limits: z.array(tokenUsageLimitSchema),
  byProvider: z.array(tokenUsageBucketSchema),
  byModel: z.array(tokenUsageBucketSchema),
  byStatus: z.array(tokenUsageBucketSchema),
  recentRuns: z.array(tokenUsageRunSchema),
  warnings: z.array(z.string()).default([]),
})

export const tokenUsageThreadSummarySchema = z.object({
  threadId: z.string().min(1),
  generatedAt: z.string(),
  totals: tokenUsageTotalsSchema,
})

export type LayerPropertyDescriptor = z.infer<typeof layerPropertyDescriptorSchema>
export type LayerDescriptor = z.infer<typeof layerDescriptorSchema>
export type BasemapDescriptor = z.infer<typeof basemapDescriptorSchema>
export type ModelInputModality = z.infer<typeof modelInputModalitySchema>
export type ModelCapabilityFlags = z.infer<typeof modelCapabilityFlagsSchema>
export type ModelCapabilitySnapshot = z.infer<typeof modelCapabilitySnapshotSchema>
export type ModelProviderDescriptor = z.infer<typeof modelProviderDescriptorSchema>
export type MapScreenshotContext = z.infer<typeof mapScreenshotContextSchema>
export type RunAttachmentInput = z.infer<typeof runAttachmentInputSchema>
export type CustomProviderConfig = z.infer<typeof customProviderConfigSchema>
export type CustomProviderRecord = z.infer<typeof customProviderRecordSchema>
export type ProviderDiscoveredModel = z.infer<typeof providerDiscoveredModelSchema>
export type ProviderModelDiscovery = z.infer<typeof providerModelDiscoverySchema>
export type CustomProviderValidation = z.infer<typeof customProviderValidationSchema>
export type CustomProviderSaveResult = z.infer<typeof customProviderSaveResultSchema>
export type CustomProviderTestMode = z.infer<typeof customProviderTestModeSchema>
export type CustomProviderTestResult = z.infer<typeof customProviderTestResultSchema>
export type AgentRuntimeCapabilities = z.infer<typeof agentRuntimeCapabilitiesSchema>
export type SpeechLanguageOption = z.infer<typeof speechLanguageOptionSchema>
export type SpeechAuthorization = z.infer<typeof speechAuthorizationSchema>
export type SystemComponentsStatus = z.infer<typeof systemComponentsStatusSchema>
export type SkillSourceKind = z.infer<typeof skillSourceKindSchema>
export type SkillTrustStatus = z.infer<typeof skillTrustStatusSchema>
export type SkillCatalogEntry = z.infer<typeof skillCatalogEntrySchema>
export type SkillCatalogDiagnostic = z.infer<typeof skillCatalogDiagnosticSchema>
export type SkillCatalogSnapshot = z.infer<typeof skillCatalogSnapshotSchema>
export type SkillMatchResult = z.infer<typeof skillMatchResultSchema>
export type SkillSearchResponse = z.infer<typeof skillSearchResponseSchema>
export type ToolParameterOption = z.infer<typeof toolParameterOptionSchema>
export type ToolParameterDescriptor = z.infer<typeof toolParameterDescriptorSchema>
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>
export type AutomationNodeType = z.infer<typeof automationNodeTypeSchema>
export type AutomationBinding = z.infer<typeof automationBindingSchema>
export type AutomationRetryPolicy = z.infer<typeof automationRetryPolicySchema>
export type AutomationAgentInvocation = z.infer<typeof automationAgentInvocationSchema>
export type AutomationNode = z.infer<typeof automationNodeSchema>
export type AutomationEdge = z.infer<typeof automationEdgeSchema>
export type AutomationGraph = z.infer<typeof automationGraphSchema>
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>
export type AutomationValidationIssue = z.infer<typeof automationValidationIssueSchema>
export type AutomationValidationResult = z.infer<typeof automationValidationResultSchema>
export type AutomationVersionRecord = z.infer<typeof automationVersionRecordSchema>
export type AutomationNodeRun = z.infer<typeof automationNodeRunSchema>
export type AutomationApprovalRequest = z.infer<typeof automationApprovalRequestSchema>
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>
export type AutomationRunRecord = z.infer<typeof automationRunRecordSchema>
export type BackgroundTaskInfo = z.infer<typeof backgroundTaskInfoSchema>
export type TokenUsageTotals = z.infer<typeof tokenUsageTotalsSchema>
export type TokenUsageBucket = z.infer<typeof tokenUsageBucketSchema>
export type TokenUsageRun = z.infer<typeof tokenUsageRunSchema>
export type TokenUsageLimit = z.infer<typeof tokenUsageLimitSchema>
export type TokenUsageSummary = z.infer<typeof tokenUsageSummarySchema>
export type TokenUsageThreadSummary = z.infer<typeof tokenUsageThreadSummarySchema>

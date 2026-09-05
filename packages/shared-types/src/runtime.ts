// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行时配置协议
//
//   文件:       runtime.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 平台 运行时配置协议。
import { z } from 'zod'
import { PLATFORM_STATE_DIRECTORY_NAME } from './productIdentity.js'

// --- Config ---

export const permissionRuleSchema = z.object({
  toolPattern: z.string(),
  decision: z.enum(['always_allow', 'always_deny', 'always_ask']),
  priority: z.number().default(0),
  description: z.string().default(''),
})

export const runtimeHookEventSchema = z.enum([
  'SessionStart',
  'TurnStart',
  'UserInputSubmitted',
  'StepContextCaptured',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'Stop',
  'ChildRunStart',
  'ChildRunStop',
])

export const runtimeHookFailureModeSchema = z.enum(['fail_closed', 'fail_open'])

// Hook 配置只引用进程内显式注册的 handler。这里不接受 command/path，避免
// 一段普通运行时配置退化为未隔离的任意代码加载器。
export const hookConfigSchema = z.object({
  hookId: z.string().trim().min(1),
  eventType: runtimeHookEventSchema,
  enabled: z.boolean().default(true),
  matcher: z.record(z.string(), z.string()).prefault({}),
  priority: z.number().int().default(0),
  description: z.string().default(''),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
  failureMode: runtimeHookFailureModeSchema.default('fail_closed'),
}).strict()

export const runtimeHookOutputSchema = z.object({
  decision: z.enum(['continue', 'block']).default('continue'),
  reason: z.string().trim().min(1).nullable().default(null),
  additionalContext: z.string().max(32_000).nullable().default(null),
  updatedToolInput: z.record(z.string(), z.unknown()).nullable().default(null),
  approvalDecision: z.enum(['approve', 'deny', 'defer']).nullable().default(null),
}).strict().superRefine((output, context) => {
  if (output.decision === 'block' && !output.reason) {
    context.addIssue({ code: 'custom', path: ['reason'], message: 'Hook 阻断时必须提供 reason。' })
  }
})

export const runtimeSubAgentConfigSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  role: z.string(),
  summary: z.string(),
  delegationMode: z.enum(['as_tool', 'handoff']).default('as_tool'),
  parallelSafe: z.boolean().default(false),
  systemPrompt: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  tools: z.array(z.string()).default([]),
  maxTurns: z.number().int().positive().max(100).default(12),
  timeoutMs: z.number().int().positive().max(2_147_483_647).default(120_000),
})

export const subAgentInvocationSchema = z.object({
  workflowStepId: z.string().trim().min(1).nullable().optional()
    .describe('存在智能体工作流时填写本次调用对应的 stepId；Handoff 调用填 null'),
  objective: z.string().trim().min(1),
  expectedDeliverables: z.array(z.string().trim().min(1)).min(1),
  contextRefs: z.array(z.string().trim().min(1)),
  constraints: z.array(z.string().trim().min(1)),
}).strict()

const deliveryArtifactIdSchema = z.string()
  .trim()
  .regex(/^artifact_[a-zA-Z0-9_-]+$/u, '必须是当前线程已授权的 artifact_<id>')
  .describe('当前线程已授权的平台 Artifact ID，必须来自工具结果或 thread-resources；不能填写 valueRefs[].refId')

export const supervisorDeliverySchema = z.object({
  markdown: z.string().trim().min(1).describe('直接展示给用户的最终中文 Markdown 正文'),
  summary: z.string().trim().min(1).describe('最终交付的单段简要摘要'),
  artifactIds: z.array(deliveryArtifactIdSchema)
    .describe('本次交付引用的真实平台 Artifact ID；没有 Artifact 时必须为空数组'),
  warnings: z.array(z.string().trim().min(1)).describe('需要用户注意的真实限制或警告'),
}).strict()

export const subAgentEvidenceSchema = z.object({
  claim: z.string().trim().min(1).describe('由当前工具结果支持的可核验结论'),
  source: z.string().trim().min(1)
    .describe('证据来源，可填写工具名、valueRefs[].refId 或 artifacts[].artifactId'),
}).strict()

export const subAgentDeliverySchema = z.object({
  status: z.enum(['completed', 'failed']),
  summary: z.string().trim().min(1).describe('返回主智能体的任务结论'),
  evidence: z.array(subAgentEvidenceSchema).describe('支持任务结论的证据清单'),
  artifactIds: z.array(deliveryArtifactIdSchema)
    .describe('子智能体引用的真实平台 Artifact ID；没有 Artifact 时必须为空数组'),
  warnings: z.array(z.string().trim().min(1)).describe('任务限制或非致命警告'),
  error: z.string().trim().min(1).nullable().describe('status=failed 时的错误；completed 时必须为 null'),
}).strict()

export const agentToolOutputMetadataSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  callId: z.string().trim().min(1),
  toolName: z.string().trim().min(1),
  resultId: z.string().trim().min(1).nullable(),
  valueRefIds: z.array(z.string().trim().min(1)),
  artifactIds: z.array(z.string().trim().min(1)),
  display: z.object({
    label: z.string().trim().min(1),
    summary: z.string().nullable(),
    source: z.string().nullable(),
  }).strict().nullable(),
}).strict()

export const supervisorRuntimeConfigSchema = z.object({
  name: z.string().default('geo_agent_supervisor'),
  systemPrompt: z.string().default(''),
  approvalInterruptTools: z.array(z.string()).default([]),
  permissionRules: z.array(permissionRuleSchema).default([]),
})

export const runtimeUiConfigSchema = z.object({
  transcriptMaxEntries: z.number().default(40),
  showInternalReasoningLabels: z.boolean().default(true),
  eventGroupingWindowMs: z.number().default(1500),
})

export const runtimeCatalogConfigSchema = z.object({
  allowEmptyCatalog: z.boolean().default(true),
  adminEnabled: z.boolean().default(true),
})

export const runtimeContextConfigSchema = z.object({
  memoryFilePaths: z.array(z.string()).default([]),
  historyRunLimit: z.number().default(4),
  eventWindow: z.number().default(24),
  toolCallWindow: z.number().default(8),
  artifactWindow: z.number().default(6),
  warningWindow: z.number().default(6),
  promptMaxChars: z.number().default(12000),
  contextEntryWindow: z.number().default(18),
  memoryFileCharLimit: z.number().default(4000),
  memoryEnabled: z.boolean().default(true),
  memoryBaseDir: z.string().default(`~/${PLATFORM_STATE_DIRECTORY_NAME}/projects`),
  privateMemoryDir: z.string().nullable().default(null),
  teamMemoryDir: z.string().nullable().default(null),
  memoryEntrypointName: z.string().default('MEMORY.md'),
  instructionEntrypointName: z.string().default('AGENTS.md'),
  instructionMemoryEnabled: z.boolean().default(false),
  memoryMaxIndexLines: z.number().int().positive().default(200),
  memoryMaxIndexBytes: z.number().int().positive().default(25000),
  memoryMaxFiles: z.number().int().positive().default(200),
  memoryRelevantLimit: z.number().int().positive().default(5),
  memoryAutoExtractEnabled: z.boolean().default(true),
  memoryAutoDreamEnabled: z.boolean().default(true),
  memoryAutoDreamMinIntervalMs: z.number().int().positive().default(21_600_000),
  memoryAutoDreamMinFiles: z.number().int().positive().default(3),
  teamMemoryEnabled: z.boolean().default(true),
  sessionMemoryEnabled: z.boolean().default(true),
  sessionMemoryInitTokens: z.number().int().positive().default(10000),
  sessionMemoryUpdateTokens: z.number().int().positive().default(5000),
  sessionMemoryToolCallThreshold: z.number().int().positive().default(3),
  contextWindowTokens: z.number().int().positive().default(128000),
  warningRatio: z.number().min(0.1).max(0.95).default(0.7),
  compactRatio: z.number().min(0.2).max(0.98).default(0.8),
  hardLimitRatio: z.number().min(0.3).max(0.99).default(0.9),
  preserveRecentTurns: z.number().int().positive().default(6),
  inlineToolResultMaxChars: z.number().int().positive().default(12000),
  memoryInitTokens: z.number().int().positive().default(12000),
  memoryUpdateTokens: z.number().int().positive().default(8000),
  summaryProvider: z.string().nullable().default(null),
  summaryModel: z.string().nullable().default(null),
})

export const runtimeGeosearchConfigSchema = z.object({
  provider: z.string().default('nominatim'),
  enabled: z.boolean().default(true),
  baseUrl: z.string().default('https://nominatim.openstreetmap.org'),
  userAgent: z.string().default('geo-agent-platform/0.1'),
  timeoutMs: z.number().default(2500),
  maxCandidates: z.number().default(5),
})

export const runtimePoiConfigSchema = z.object({
  provider: z.string().default('overpass'),
  enabled: z.boolean().default(true),
  baseUrl: z.string().default('https://overpass-api.de/api/interpreter'),
  userAgent: z.string().default('geo-agent-platform/0.1'),
  timeoutMs: z.number().default(8000),
  maxResults: z.number().default(200),
})

// 气象区域配置——不再硬编码杭州。杭州只保留为默认配置数据。
export const meteorologicalRegionSchema = z.object({
  id: z.string(),
  label: z.string(),
  aliases: z.array(z.string()).default([]),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  crs: z.string().default('EPSG:4326'),
  timezone: z.string().default('Asia/Shanghai'),
  defaultNowcastWindowMinutes: z.number().default(180),
})

export type MeteorologicalRegion = z.infer<typeof meteorologicalRegionSchema>

export const runtimeNowcastConfigSchema = z.object({
  meteorologicalRegions: z.array(meteorologicalRegionSchema).default([]),
  defaultMeteorologicalRegionId: z.string().default('hangzhou'),
  forecastHorizonMinutes: z.number().default(180),
  pointBufferMeters: z.number().default(1000),
  districtLayerKey: z.string().nullable().default(null),
  districtNameField: z.string().nullable().default(null),
  rainLevelThresholds: z.record(z.string(), z.number()).default({ none: 0.1, light: 2.5, moderate: 8.0, heavy: 16.0 }),
  candidateLimit: z.number().default(12),
})

export const runtimePlanningConfigSchema = z.object({
  maxPlanRepairRounds: z.number().default(2),
  externalSourcePriority: z.array(z.string()).default(['catalog', 'external_poi', 'geosearch']),
})

export const runtimeSandboxConfigSchema = z.object({
  backend: z.enum(['disabled', 'unix_local', 'sdk_docker']).default('disabled'),
})

export const runtimeDeveloperConfigSchema = z.object({
  enabled: z.boolean().default(false),
  allowedRoots: z.array(z.string().trim().min(1).max(4096)).max(32).default([]),
}).strict().superRefine((config, context) => {
  if (config.enabled && config.allowedRoots.length === 0) {
    context.addIssue({ code: 'custom', path: ['allowedRoots'], message: '开发者模式启用时必须显式配置允许根目录' })
  }
  const rootSet = new Set(config.allowedRoots)
  if (rootSet.size !== config.allowedRoots.length) {
    context.addIssue({ code: 'custom', path: ['allowedRoots'], message: '开发者允许根目录不能重复' })
  }
})

export const runtimeMcpTransportSchema = z.enum(['streamable_http', 'sse', 'stdio'])
export const runtimeMcpExecutionModeSchema = z.literal('function_tools')
export const runtimeMcpApprovalSchema = z.enum(['always', 'never'])

const runtimeMcpCredentialFieldName = /(?:^|[-_])(?:auth(?:entication|orization)?|proxy[-_]?authorization|api[-_]?key|key|access[-_]?token|refresh[-_]?token|token|secret|password|credential|cookie|session)(?:$|[-_])/iu
const runtimeMcpCredentialValue = /^(?:\s*(?:Bearer|Basic)\s+|sk-[A-Za-z0-9_-]{10,})/iu

export const runtimeMcpServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  name: z.string().min(1),
  description: z.string().default(''),
  transport: runtimeMcpTransportSchema.default('streamable_http'),
  executionMode: runtimeMcpExecutionModeSchema.default('function_tools'),
  url: z.string().nullable().default(null),
  command: z.string().nullable().default(null),
  args: z.array(z.string()).default([]),
  cwd: z.string().nullable().default(null),
  env: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  allowedTools: z.array(z.string()).default([]),
  blockedTools: z.array(z.string()).default([]),
  includeServerInToolNames: z.boolean().default(true),
  convertSchemasToStrict: z.boolean().default(true),
  cacheToolsList: z.boolean().default(true),
  useStructuredContent: z.boolean().default(true),
  approval: runtimeMcpApprovalSchema.default('always'),
  timeoutMs: z.number().int().positive().default(20_000),
}).strict().superRefine((server, context) => {
  if (server.transport === 'stdio') {
    if (!server.command?.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'stdio MCP 必须配置 command。',
      })
    }
  } else if (!server.url?.trim()) {
    context.addIssue({
      code: 'custom',
      path: ['url'],
      message: 'HTTP/SSE MCP 必须配置 url。',
    })
  }
  for (const [name, value] of Object.entries(server.headers)) {
    if (runtimeMcpCredentialFieldName.test(name) || runtimeMcpCredentialValue.test(value)) {
      context.addIssue({
        code: 'custom',
        path: ['headers', name],
        message: 'MCP 配置不得内嵌授权信息或 API Key。',
      })
    }
  }
  for (const [name, value] of Object.entries(server.env)) {
    if (runtimeMcpCredentialFieldName.test(name) || runtimeMcpCredentialValue.test(value)) {
      context.addIssue({
        code: 'custom',
        path: ['env', name],
        message: 'MCP 配置不得内嵌密钥、令牌或密码。',
      })
    }
  }
  for (const [index, value] of server.args.entries()) {
    const argumentName = value.replace(/^-+/u, '').split('=', 1)[0] ?? ''
    if (runtimeMcpCredentialFieldName.test(argumentName) || runtimeMcpCredentialValue.test(value)) {
      context.addIssue({
        code: 'custom',
        path: ['args', index],
        message: 'MCP 启动参数不得携带授权信息、密钥或令牌。',
      })
    }
  }
  if (server.url?.trim()) {
    try {
      const url = new URL(server.url)
      if (url.username || url.password) {
        context.addIssue({
          code: 'custom',
          path: ['url'],
          message: 'MCP 地址不得内嵌用户名或密码。',
        })
      }
      for (const name of url.searchParams.keys()) {
        if (runtimeMcpCredentialFieldName.test(name)) {
          context.addIssue({
            code: 'custom',
            path: ['url'],
            message: 'MCP 地址不得通过查询参数携带密钥或令牌。',
          })
          break
        }
      }
    } catch {
      // URL 的协议与格式由运行时连接边界给出统一错误；这里只负责凭据禁入。
    }
  }
})

export const runtimeMcpConfigSchema = z.object({
  enabled: z.boolean().default(false),
  connectTimeoutMs: z.number().int().positive().default(10_000),
  closeTimeoutMs: z.number().int().positive().default(2_000),
  servers: z.array(runtimeMcpServerConfigSchema).default([]),
})

export const runtimeSkillRegistrationSchema = z.object({
  skillId: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  trustedDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).nullable().default(null),
})

export const runtimeSkillConfigSchema = z.object({
  enabled: z.boolean().default(false),
  skillsPath: z.string().default('.agents'),
  skillPaths: z.array(z.string()).default([]),
  skillRoots: z.array(z.string()).default([]),
  registrations: z.array(runtimeSkillRegistrationSchema).default([]),
  autoMatchThreshold: z.number().min(0).max(1).default(0.72),
  candidateThreshold: z.number().min(0).max(1).default(0.12),
}).superRefine((config, context) => {
  if (config.candidateThreshold > config.autoMatchThreshold) {
    context.addIssue({
      code: 'custom',
      path: ['candidateThreshold'],
      message: 'Skill 候选阈值不能高于自动匹配阈值。',
    })
  }
  const skillIds = new Set<string>()
  for (const [index, registration] of config.registrations.entries()) {
    if (skillIds.has(registration.skillId)) {
      context.addIssue({
        code: 'custom',
        path: ['registrations', index, 'skillId'],
        message: `Skill 注册项 '${registration.skillId}' 重复。`,
      })
    }
    skillIds.add(registration.skillId)
  }
})

export const runtimePluginCapabilityBindingsSchema = z.object({
  toolNames: z.array(z.string().trim().min(1)).default([]),
  mcpServerNames: z.array(z.string().trim().min(1)).default([]),
  skillIds: z.array(z.string().trim().min(1)).default([]),
  hookIds: z.array(z.string().trim().min(1)).default([]),
  writableRoots: z.array(z.string().trim().min(1)).default([]),
}).strict()

export const runtimePluginRegistrationSchema = z.object({
  pluginId: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  version: z.string().trim().min(1).default('0.0.0'),
  source: z.string().trim().min(1),
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  bindings: runtimePluginCapabilityBindingsSchema.default({
    toolNames: [],
    mcpServerNames: [],
    skillIds: [],
    hookIds: [],
    writableRoots: [],
  }),
}).strict()

export const runtimePluginConfigSchema = z.object({
  enabled: z.boolean().default(false),
  registrations: z.array(runtimePluginRegistrationSchema).default([]),
}).strict().superRefine((config, context) => {
  const pluginIds = new Set<string>()
  for (const [index, registration] of config.registrations.entries()) {
    if (pluginIds.has(registration.pluginId)) {
      context.addIssue({
        code: 'custom',
        path: ['registrations', index, 'pluginId'],
        message: `Plugin 注册项 '${registration.pluginId}' 重复。`,
      })
    }
    pluginIds.add(registration.pluginId)
  }
})

export const runtimeHostedWebSearchConfigSchema = z.object({
  enabled: z.boolean().default(true),
  searchContextSize: z.enum(['low', 'medium', 'high']).default('medium'),
})

export const runtimeHostedToolsConfigSchema = z.object({
  webSearch: runtimeHostedWebSearchConfigSchema.default({
    enabled: true,
    searchContextSize: 'medium',
  }),
})

export const runtimeSdkConfigSchema = z.object({
  hostedTools: runtimeHostedToolsConfigSchema.default({
    webSearch: {
      enabled: true,
      searchContextSize: 'medium',
    },
  }),
  mcp: runtimeMcpConfigSchema.default({
    enabled: false,
    connectTimeoutMs: 10_000,
    closeTimeoutMs: 2_000,
    servers: [],
  }),
  skills: runtimeSkillConfigSchema.default({
    enabled: false,
    skillsPath: '.agents',
    skillPaths: [],
    skillRoots: [],
    registrations: [],
    autoMatchThreshold: 0.72,
    candidateThreshold: 0.12,
  }),
  plugins: runtimePluginConfigSchema.default({
    enabled: false,
    registrations: [],
  }),
})

export const agentRuntimeConfigSchema = z.object({
  loopTraceLimit: z.number().default(80),
  maxTurns: z.number().default(50),
  maxFunctionToolConcurrency: z.number().int().min(1).max(16).default(4),
  sandbox: runtimeSandboxConfigSchema.default({ backend: 'disabled' }),
  developer: runtimeDeveloperConfigSchema.default({
    enabled: false,
    allowedRoots: [],
  }),
  sdk: runtimeSdkConfigSchema.default({
    hostedTools: {
      webSearch: {
        enabled: true,
        searchContextSize: 'medium',
      },
    },
    mcp: { enabled: false, connectTimeoutMs: 10_000, closeTimeoutMs: 2_000, servers: [] },
    skills: {
      enabled: false,
      skillsPath: '.agents',
      skillPaths: [],
      skillRoots: [],
      registrations: [],
      autoMatchThreshold: 0.72,
      candidateThreshold: 0.12,
    },
    plugins: {
      enabled: false,
      registrations: [],
    },
  }),
  supervisor: supervisorRuntimeConfigSchema.default({
    name: 'geo_agent_supervisor',
    systemPrompt: '',
    approvalInterruptTools: [],
    permissionRules: [],
  }),
  subAgents: z.array(runtimeSubAgentConfigSchema).default([]),
  ui: runtimeUiConfigSchema.default({
    transcriptMaxEntries: 40,
    showInternalReasoningLabels: true,
    eventGroupingWindowMs: 1500,
  }),
  catalog: runtimeCatalogConfigSchema.default({ allowEmptyCatalog: true, adminEnabled: true }),
  planning: runtimePlanningConfigSchema.default({
    maxPlanRepairRounds: 2,
    externalSourcePriority: ['catalog', 'external_poi', 'geosearch'],
  }),
  context: runtimeContextConfigSchema.default({
    memoryFilePaths: [],
    historyRunLimit: 4,
    eventWindow: 24,
    toolCallWindow: 8,
    artifactWindow: 6,
    warningWindow: 6,
    promptMaxChars: 12000,
    contextEntryWindow: 18,
    memoryFileCharLimit: 4000,
    memoryEnabled: true,
    memoryBaseDir: `~/${PLATFORM_STATE_DIRECTORY_NAME}/projects`,
    privateMemoryDir: null,
    teamMemoryDir: null,
    memoryEntrypointName: 'MEMORY.md',
    instructionEntrypointName: 'AGENTS.md',
    instructionMemoryEnabled: false,
    memoryMaxIndexLines: 200,
    memoryMaxIndexBytes: 25000,
    memoryMaxFiles: 200,
    memoryRelevantLimit: 5,
    memoryAutoExtractEnabled: true,
    memoryAutoDreamEnabled: true,
    memoryAutoDreamMinIntervalMs: 21_600_000,
    memoryAutoDreamMinFiles: 3,
    teamMemoryEnabled: true,
    sessionMemoryEnabled: true,
    sessionMemoryInitTokens: 10000,
    sessionMemoryUpdateTokens: 5000,
    sessionMemoryToolCallThreshold: 3,
    contextWindowTokens: 128000,
    warningRatio: 0.7,
    compactRatio: 0.8,
    hardLimitRatio: 0.9,
    preserveRecentTurns: 6,
    inlineToolResultMaxChars: 12000,
    memoryInitTokens: 12000,
    memoryUpdateTokens: 8000,
    summaryProvider: null,
    summaryModel: null,
  }),
  geosearch: runtimeGeosearchConfigSchema.default({
    provider: 'nominatim',
    enabled: true,
    baseUrl: 'https://nominatim.openstreetmap.org',
    userAgent: 'geo-agent-platform/0.1',
    timeoutMs: 2500,
    maxCandidates: 5,
  }),
  externalPoi: runtimePoiConfigSchema.default({
    provider: 'overpass',
    enabled: true,
    baseUrl: 'https://overpass-api.de/api/interpreter',
    userAgent: 'geo-agent-platform/0.1',
    timeoutMs: 8000,
    maxResults: 200,
  }),
  nowcast: runtimeNowcastConfigSchema.default({
    meteorologicalRegions: [
      { id: 'hangzhou', label: '杭州市', aliases: ['杭州'], timezone: 'Asia/Shanghai', crs: 'EPSG:4326', defaultNowcastWindowMinutes: 180 },
    ],
    defaultMeteorologicalRegionId: 'hangzhou',
    forecastHorizonMinutes: 180,
    pointBufferMeters: 1000,
    districtLayerKey: null,
    districtNameField: null,
    rainLevelThresholds: { none: 0.1, light: 2.5, moderate: 8.0, heavy: 16.0 },
    candidateLimit: 12,
  }),
  hookConfigs: z.array(hookConfigSchema).default([]),
})

export const runtimeConfigOriginSchema = z.enum(['default', 'database'])

export const runtimeConfigDocumentSchema = z.object({
  config: agentRuntimeConfigSchema,
  revision: z.number().int().nonnegative(),
  origin: runtimeConfigOriginSchema,
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((document, context) => {
  if (document.origin === 'default' && document.revision !== 0) {
    context.addIssue({
      code: 'custom',
      path: ['revision'],
      message: '默认配置 revision 必须为 0',
    })
  }
  if (document.origin === 'database' && document.revision < 1) {
    context.addIssue({
      code: 'custom',
      path: ['revision'],
      message: '数据库配置 revision 必须大于 0',
    })
  }
})

export type PermissionRuleEntry = z.infer<typeof permissionRuleSchema>
export type RuntimeHookEvent = z.infer<typeof runtimeHookEventSchema>
export type RuntimeHookFailureMode = z.infer<typeof runtimeHookFailureModeSchema>
export type RuntimeHookOutput = z.infer<typeof runtimeHookOutputSchema>
export type HookConfigEntry = z.infer<typeof hookConfigSchema>
export type RuntimeSubAgentConfig = z.infer<typeof runtimeSubAgentConfigSchema>
export type SubAgentInvocation = z.infer<typeof subAgentInvocationSchema>
export type SupervisorDelivery = z.infer<typeof supervisorDeliverySchema>
export type SubAgentEvidence = z.infer<typeof subAgentEvidenceSchema>
export type SubAgentDelivery = z.infer<typeof subAgentDeliverySchema>
export type AgentToolOutputMetadata = z.infer<typeof agentToolOutputMetadataSchema>
export type SupervisorRuntimeConfig = z.infer<typeof supervisorRuntimeConfigSchema>
export type RuntimeUiConfig = z.infer<typeof runtimeUiConfigSchema>
export type RuntimeCatalogConfig = z.infer<typeof runtimeCatalogConfigSchema>
export type RuntimeContextConfig = z.infer<typeof runtimeContextConfigSchema>
export type RuntimeGeosearchConfig = z.infer<typeof runtimeGeosearchConfigSchema>
export type RuntimePoiConfig = z.infer<typeof runtimePoiConfigSchema>
export type RuntimeNowcastConfig = z.infer<typeof runtimeNowcastConfigSchema>
export type RuntimePlanningConfig = z.infer<typeof runtimePlanningConfigSchema>
export type RuntimeSandboxConfig = z.infer<typeof runtimeSandboxConfigSchema>
export type RuntimeDeveloperConfig = z.infer<typeof runtimeDeveloperConfigSchema>
export type RuntimeMcpServerConfig = z.infer<typeof runtimeMcpServerConfigSchema>
export type RuntimeMcpConfig = z.infer<typeof runtimeMcpConfigSchema>
export type RuntimeSkillRegistration = z.infer<typeof runtimeSkillRegistrationSchema>
export type RuntimeSkillConfig = z.infer<typeof runtimeSkillConfigSchema>
export type RuntimePluginCapabilityBindings = z.infer<typeof runtimePluginCapabilityBindingsSchema>
export type RuntimePluginRegistration = z.infer<typeof runtimePluginRegistrationSchema>
export type RuntimePluginConfig = z.infer<typeof runtimePluginConfigSchema>
export type RuntimeSdkConfig = z.infer<typeof runtimeSdkConfigSchema>
export type AgentRuntimeConfig = z.infer<typeof agentRuntimeConfigSchema>
export type RuntimeConfigOrigin = z.infer<typeof runtimeConfigOriginSchema>
export type RuntimeConfigDocument = z.infer<typeof runtimeConfigDocumentSchema>

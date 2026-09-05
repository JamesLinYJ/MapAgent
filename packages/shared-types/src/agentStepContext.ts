// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型请求级不可变 StepContext 契约
//
//   文件:       agentStepContext.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

import { geoWorldCapabilitiesSchema } from './geoWorld.js'
import { modelCapabilitySnapshotSchema } from './resources.js'
import {
  agentToolPlanSnapshotSchema,
  type AgentToolPlanEntry,
  type AgentToolPlanSnapshot,
} from './toolRuntime.js'

export const AGENT_STEP_CONTEXT_SCHEMA_VERSION = 3 as const

export const agentStepIdentitySchema = z.object({
  stepId: z.string().trim().min(1),
  turnId: z.string().trim().min(1),
  segmentId: z.string().trim().min(1),
  modelRequestIndex: z.number().int().positive(),
}).strict()

export const agentPermissionSnapshotSchema = z.object({
  principalId: z.string().trim().min(1).nullable(),
  workspaceId: z.string().trim().min(1),
  roles: z.array(z.string().trim().min(1)),
  toolRules: z.array(z.object({
    toolPattern: z.string().trim().min(1),
    decision: z.enum(['always_allow', 'always_deny', 'always_ask']),
    priority: z.number(),
  }).strict()),
}).strict()

export const agentApprovalPolicySnapshotSchema = z.object({
  interruptToolNames: z.array(z.string().trim().min(1)),
  destructiveToolsRequireApproval: z.literal(true),
}).strict()

export const agentSandboxSnapshotSchema = z.object({
  backend: z.string().trim().min(1),
  writableRoots: z.array(z.string().trim().min(1)),
  networkPolicy: z.string().trim().min(1),
}).strict()

export const agentMcpServerSnapshotSchema = z.object({
  name: z.string().trim().min(1),
  transport: z.enum(['streamable_http', 'sse', 'stdio']),
  approval: z.enum(['always', 'never']),
  configDigest: z.string().trim().min(1),
  authDigest: z.string().trim().min(1),
  toolNames: z.array(z.string().trim().min(1)),
  resourceUris: z.array(z.string().trim().min(1)),
}).strict()

export const agentMcpSnapshotSchema = z.object({
  bindingId: z.string().trim().min(1),
  catalogRevision: z.number().int().nonnegative(),
  configDigest: z.string().trim().min(1),
  authDigest: z.string().trim().min(1),
  capabilityRootDigest: z.string().trim().min(1),
  toolCatalogDigest: z.string().trim().min(1),
  resourceCatalogDigest: z.string().trim().min(1),
  refreshReasons: z.array(z.enum(['initial', 'config', 'auth', 'capability_roots', 'catalog', 'manual'])),
  servers: z.array(agentMcpServerSnapshotSchema),
}).strict()

export const agentSkillInvocationSchema = z.object({
  invocationId: z.string().trim().min(1),
  skillId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
  source: z.object({
    kind: z.string().trim().min(1),
    label: z.string().trim().min(1),
  }).strict(),
  contentDigest: z.string().trim().min(1),
  trustStatus: z.enum(['builtin', 'trusted', 'untrusted', 'content_changed']),
  requiredCapabilities: z.array(z.string().trim().min(1)),
  mode: z.enum(['explicit', 'implicit', 'profile', 'plugin']),
  reason: z.string().trim().min(1),
}).strict()

export const agentSkillSnapshotSchema = z.object({
  skillIds: z.array(z.string().trim().min(1)),
  catalogDigest: z.string().trim().min(1),
  invocations: z.array(agentSkillInvocationSchema),
}).strict()

export const agentPluginBindingSchema = z.object({
  pluginId: z.string().trim().min(1),
  version: z.string().trim().min(1),
  source: z.string().trim().min(1),
  contentDigest: z.string().trim().min(1),
  toolNames: z.array(z.string().trim().min(1)),
  mcpServerNames: z.array(z.string().trim().min(1)),
  skillIds: z.array(z.string().trim().min(1)),
  hookIds: z.array(z.string().trim().min(1)),
  writableRoots: z.array(z.string().trim().min(1)),
}).strict()

export const agentPluginSnapshotSchema = z.object({
  pluginIds: z.array(z.string().trim().min(1)),
  catalogDigest: z.string().trim().min(1),
  bindings: z.array(agentPluginBindingSchema),
}).strict()

export const agentWorldSnapshotSchema = z.object({
  revision: z.number().int().positive(),
  stateDigest: z.string().trim().min(1),
  layerIds: z.array(z.string().trim().min(1)),
  datasetIds: z.array(z.string().trim().min(1)),
  fileIds: z.array(z.string().trim().min(1)),
  artifactIds: z.array(z.string().trim().min(1)),
  valueRefIds: z.array(z.string().trim().min(1)),
  capabilities: geoWorldCapabilitiesSchema,
}).strict()

export const agentStepContextSchema = z.object({
  schemaVersion: z.literal(AGENT_STEP_CONTEXT_SCHEMA_VERSION),
  identity: agentStepIdentitySchema,
  runId: z.string().trim().min(1),
  turnId: z.string().trim().min(1),
  objectiveRevision: z.number().int().positive(),
  inputCursor: z.number().int().nonnegative(),
  model: z.object({
    provider: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    transport: z.enum(['responses', 'chat_completions']),
    capabilities: modelCapabilitySnapshotSchema,
    reasoningEffort: z.string().trim().min(1).nullable(),
    serviceTier: z.string().trim().min(1).nullable(),
    timeoutMs: z.number().int().nonnegative(),
  }).strict(),
  runtimeConfigDigest: z.string().trim().min(1),
  toolPlanDigest: z.string().trim().min(1),
  worldRevision: z.number().int().positive(),
  contextWindowId: z.string().trim().min(1),
  permissions: agentPermissionSnapshotSchema,
  approvalPolicy: agentApprovalPolicySnapshotSchema,
  sandbox: agentSandboxSnapshotSchema,
  mcp: agentMcpSnapshotSchema,
  skills: agentSkillSnapshotSchema,
  plugins: agentPluginSnapshotSchema,
  tools: agentToolPlanSnapshotSchema,
  world: agentWorldSnapshotSchema,
  capturedAt: z.string().datetime({ offset: true }),
  contextDigest: z.string().trim().min(1),
}).strict().superRefine((context, refinement) => {
  if (context.turnId !== context.identity.turnId) {
    refinement.addIssue({ code: 'custom', path: ['turnId'], message: 'turnId 必须与 identity.turnId 一致' })
  }
  if (context.toolPlanDigest !== context.tools.catalogDigest) {
    refinement.addIssue({ code: 'custom', path: ['toolPlanDigest'], message: 'toolPlanDigest 必须绑定当前工具计划' })
  }
  if (context.worldRevision !== context.world.revision) {
    refinement.addIssue({ code: 'custom', path: ['worldRevision'], message: 'worldRevision 必须绑定当前世界快照' })
  }
  if (context.model.modelId !== context.model.capabilities.modelId) {
    refinement.addIssue({ code: 'custom', path: ['model', 'modelId'], message: 'modelId 必须与能力快照一致' })
  }
  if (context.skills.invocations.length > 0) {
    const invocationIds = [...new Set(context.skills.invocations.map(item => item.skillId))].sort()
    if (JSON.stringify(invocationIds) !== JSON.stringify([...context.skills.skillIds].sort())) {
      refinement.addIssue({ code: 'custom', path: ['skills', 'skillIds'], message: 'skillIds 必须与 invocation ledger 一致' })
    }
  }
  if (context.plugins.bindings.length > 0) {
    const bindingIds = [...new Set(context.plugins.bindings.map(item => item.pluginId))].sort()
    if (JSON.stringify(bindingIds) !== JSON.stringify([...context.plugins.pluginIds].sort())) {
      refinement.addIssue({ code: 'custom', path: ['plugins', 'pluginIds'], message: 'pluginIds 必须与 Plugin binding 一致' })
    }
  }
})

export type AgentStepIdentity = z.infer<typeof agentStepIdentitySchema>
export type { AgentToolPlanEntry, AgentToolPlanSnapshot }
export type AgentPermissionSnapshot = z.infer<typeof agentPermissionSnapshotSchema>
export type AgentApprovalPolicySnapshot = z.infer<typeof agentApprovalPolicySnapshotSchema>
export type AgentSandboxSnapshot = z.infer<typeof agentSandboxSnapshotSchema>
export type AgentMcpSnapshot = z.infer<typeof agentMcpSnapshotSchema>
export type AgentMcpServerSnapshot = z.infer<typeof agentMcpServerSnapshotSchema>
export type AgentSkillSnapshot = z.infer<typeof agentSkillSnapshotSchema>
export type AgentSkillInvocation = z.infer<typeof agentSkillInvocationSchema>
export type AgentPluginSnapshot = z.infer<typeof agentPluginSnapshotSchema>
export type AgentPluginBinding = z.infer<typeof agentPluginBindingSchema>
export type AgentWorldSnapshot = z.infer<typeof agentWorldSnapshotSchema>
export type AgentStepContext = z.infer<typeof agentStepContextSchema>

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型请求工具计划编译器
//
//   文件:       ToolPlanCompiler.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ModelRequest } from '@openai/agents'
import {
  agentToolPlanSnapshotSchema,
  type AgentToolExecutionSurface,
  type AgentToolNamespace,
  type AgentToolPlanEntry,
  type AgentToolPlanSnapshot,
} from '@geo-agent-platform/shared-types/tool-runtime'

import type { ToolDef } from '../../framework/types.js'
import { ensureToolSchemas } from '../../framework/schema.js'
import { agentContextDigest } from '../step/agentContextDigest.js'
import type { AgentToolDescriptorSource } from './ToolCatalog.js'

interface ToolPlanProviderCapabilities {
  nativeDeferredTools: boolean
  nativeToolNamespaces: boolean
}

export interface CompileToolPlanInput {
  request: Pick<ModelRequest, 'tools' | 'handoffs'>
  sources: readonly AgentToolDescriptorSource[]
  providerCapabilities: ToolPlanProviderCapabilities
  unavailableReasons?: Readonly<Record<string, string>>
}

/**
 * 编译器只接受即将发送给模型的序列化 request 与同一装配阶段生成的目录来源。
 * 因此 StepContext 中的定义、路由策略和 provider 可见 schema 共享同一事实源。
 */
export function compileToolPlan(input: CompileToolPlanInput): AgentToolPlanSnapshot {
  const sources = indexSources(input.sources)
  const entries = [
    ...input.request.tools.map(tool => compileEntry({
      name: tool.name,
      definition: tool,
      schema: tool.type === 'function' ? tool.parameters : {},
      deferLoading: tool.type === 'function' && tool.deferLoading === true,
      ...(tool.type === 'function' && tool.namespace ? { namespace: tool.namespace } : {}),
      ...(tool.type === 'function' && tool.namespaceDescription
        ? { namespaceDescription: tool.namespaceDescription }
        : {}),
    }, sources, input.providerCapabilities)),
    ...input.request.handoffs.map(handoff => compileEntry({
      name: handoff.toolName,
      definition: { type: 'handoff', ...handoff },
      schema: handoff.inputJsonSchema,
      deferLoading: false,
    }, sources, input.providerCapabilities)),
  ].sort((left, right) => left.name.localeCompare(right.name))
  const namespaces = compileNamespaces(input.request, entries, input.providerCapabilities)
  const deferredEntries = entries.filter(entry => entry.deferLoading)
  const deferredCatalogObjectHash = deferredEntries.length
    ? agentContextDigest(deferredEntries.map(entry => ({
        name: entry.name,
        namespace: entry.namespace,
        schemaDigest: entry.schemaDigest,
        definitionDigest: entry.definitionDigest,
      })))
    : null
  const unavailableReasons = Object.fromEntries(Object.entries(input.unavailableReasons ?? {})
    .map(([name, reason]) => [name.trim(), reason.trim()] as const)
    .filter(([name, reason]) => name.length > 0 && reason.length > 0)
    .sort(([left], [right]) => left.localeCompare(right)))
  const planWithoutDigest = {
    entries,
    namespaces,
    deferredCatalogObjectHash,
    unavailableReasons,
  }
  return deepFreeze(agentToolPlanSnapshotSchema.parse({
    ...planWithoutDigest,
    catalogDigest: agentContextDigest(planWithoutDigest),
  }))
}

/**
 * Automation 与管理员直连调用不经过模型采样，但仍必须得到一份可审计、
 * 不可变的单工具执行计划，避免直连路径绕过目录策略和调用账本。
 */
export function compileDirectToolPlan(input: {
  definition: ToolDef
  source: AgentToolDescriptorSource
  executionSurface: AgentToolExecutionSurface
}): AgentToolPlanSnapshot {
  if (input.definition.name !== input.source.name || input.source.kind !== 'platform') {
    throw new Error(`直连工具 '${input.definition.name}' 的目录绑定不一致`)
  }
  if (!input.source.executionSurfaces.includes(input.executionSurface)) {
    throw new Error(
      `工具 '${input.definition.name}' 未开放 '${input.executionSurface}' 执行入口`,
    )
  }
  const { jsonSchema } = ensureToolSchemas(input.definition)
  const entry: AgentToolPlanEntry = {
    ...input.source,
    schemaDigest: agentContextDigest(jsonSchema),
    definitionDigest: agentContextDigest({
      descriptor: input.source,
      jsonSchema,
    }),
    deferLoading: false,
  }
  const planWithoutDigest = {
    entries: [entry],
    namespaces: [],
    deferredCatalogObjectHash: null,
    unavailableReasons: {},
  }
  return deepFreeze(agentToolPlanSnapshotSchema.parse({
    ...planWithoutDigest,
    catalogDigest: agentContextDigest(planWithoutDigest),
  }))
}

interface SerializedPlanDefinition {
  name: string
  definition: unknown
  schema: unknown
  deferLoading: boolean
  namespace?: string
  namespaceDescription?: string
}

function compileEntry(
  serialized: SerializedPlanDefinition,
  sources: ReadonlyMap<string, AgentToolDescriptorSource>,
  capabilities: ToolPlanProviderCapabilities,
): AgentToolPlanEntry {
  const source = sources.get(serialized.name)
  if (!source) throw new Error(`模型请求公开了未绑定执行来源的工具 '${serialized.name}'`)
  if (serialized.deferLoading && !capabilities.nativeDeferredTools) {
    throw new Error(`Provider 不支持 native deferred tools，却公开了延迟工具 '${serialized.name}'`)
  }
  if (serialized.deferLoading && source.exposure !== 'deferred') {
    throw new Error(`工具 '${serialized.name}' 的 request 要求延迟加载，但目录 exposure 不是 deferred`)
  }
  if (serialized.namespace && !capabilities.nativeToolNamespaces) {
    throw new Error(`Provider 不支持 tool namespace，却公开了命名空间工具 '${serialized.name}'`)
  }
  return {
    ...source,
    schemaDigest: agentContextDigest(serialized.schema),
    definitionDigest: agentContextDigest(serialized.definition),
    deferLoading: serialized.deferLoading,
  }
}

function compileNamespaces(
  request: Pick<ModelRequest, 'tools'>,
  entries: readonly AgentToolPlanEntry[],
  capabilities: ToolPlanProviderCapabilities,
): AgentToolNamespace[] {
  const entryNames = new Set(entries.map(entry => entry.name))
  const groups = new Map<string, { description: string; toolNames: string[]; deferred: boolean }>()
  for (const tool of request.tools) {
    if (tool.type !== 'function' || !tool.namespace) continue
    if (!capabilities.nativeToolNamespaces) {
      throw new Error(`Provider 不支持 tool namespace，却公开了命名空间 '${tool.namespace}'`)
    }
    const description = tool.namespaceDescription?.trim()
    if (!description) throw new Error(`工具命名空间 '${tool.namespace}' 缺少模型可见描述`)
    if (!entryNames.has(tool.name)) throw new Error(`工具命名空间引用了未计划工具 '${tool.name}'`)
    const current = groups.get(tool.namespace)
    if (current && current.description !== description) {
      throw new Error(`工具命名空间 '${tool.namespace}' 的描述不一致`)
    }
    const group = current ?? { description, toolNames: [], deferred: false }
    group.toolNames.push(tool.name)
    group.deferred ||= tool.deferLoading === true
    groups.set(tool.namespace, group)
  }
  return [...groups.entries()].map(([name, group]) => ({
    name,
    description: group.description,
    toolNames: [...new Set(group.toolNames)].sort(),
    deferred: group.deferred,
  })).sort((left, right) => left.name.localeCompare(right.name))
}

function indexSources(
  rawSources: readonly AgentToolDescriptorSource[],
): Map<string, AgentToolDescriptorSource> {
  const sources = new Map<string, AgentToolDescriptorSource>()
  for (const source of rawSources) {
    if (sources.has(source.name)) throw new Error(`Agent 工具目录来源 '${source.name}' 重复`)
    sources.set(source.name, source)
  }
  return sources
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent 工具目录
//
//   文件:       ToolCatalog.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  agentToolDescriptorSourceSchema,
  type AgentToolDescriptor,
  type AgentToolDescriptorSource,
  type AgentToolExecutionSurface,
  type AgentToolKind,
} from '@geo-agent-platform/shared-types/tool-runtime'

import type { ToolRegistry } from '../../framework/registry.js'
import type { ToolDef, ToolRuntimePolicy } from '../../framework/types.js'
import { ensureToolSchemas, isRecord } from '../../framework/schema.js'
import { agentContextDigest } from '../step/agentContextDigest.js'

export type { AgentToolDescriptorSource }

/**
 * ToolCatalog 把 Provider、SDK 扩展和运行策略归一化为一种显式描述符。
 * 下游计划、路由、并发和恢复只读取描述符，不再各自解释 ToolDef 布尔字段。
 */
export class ToolCatalog {
  constructor(private readonly registry: ToolRegistry) {}

  platformSource(name: string): AgentToolDescriptorSource {
    const definition = this.registry.get(name)
    if (!definition) throw new Error(`工具目录缺少平台工具 '${name}'`)
    return platformToolDescriptorSource(definition)
  }

  listPlatformSources(): AgentToolDescriptorSource[] {
    return this.registry.list().map(definition => platformToolDescriptorSource(definition))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  assertPlatformBinding(source: AgentToolDescriptorSource): ToolDef {
    if (source.kind !== 'platform') throw new Error(`工具 '${source.name}' 不是平台 handler`)
    const definition = this.registry.get(source.name)
    if (!definition) throw new Error(`工具 '${source.name}' 已从运行目录移除`)
    const current = platformToolDescriptorSource(definition, {
      approvalRequired: source.approvalAction !== null,
    })
    if (agentContextDigest(current) !== agentContextDigest(source)) {
      throw new Error(`工具 '${source.name}' 的目录策略已变化，不能用过期 StepContext 执行`)
    }
    return definition
  }
}

export function platformToolDescriptorSource(
  definition: ToolDef,
  runtime?: { approvalRequired?: boolean },
): AgentToolDescriptorSource {
  const policy = normalizePlatformPolicy(definition)
  const { jsonSchema } = ensureToolSchemas(definition)
  const approvalAction = runtime?.approvalRequired === true
    ? policy.approvalAction ?? `tool:${definition.name}`
    : policy.approvalAction
  return descriptorSource({
    name: definition.name,
    namespace: policy.namespace,
    providerId: definition.providerId ?? null,
    kind: 'platform',
    exposure: policy.exposure,
    effect: policy.effect,
    parallelism: approvalAction === null ? policy.parallelism : 'exclusive',
    approvalAction,
    replayPolicy: policy.replayPolicy,
    requiredCapabilities: policy.requiredCapabilities,
    requiredValueRefKinds: valueRefKinds(jsonSchema),
    executionSurfaces: normalizeExecutionSurfaces(definition),
  })
}

export function sdkToolDescriptorSource(input: {
  name: string
  kind: Exclude<AgentToolKind, 'platform'>
  providerId?: string | null
  namespace?: string
  exposure?: AgentToolDescriptor['exposure']
  effect?: AgentToolDescriptor['effect']
  parallelism?: AgentToolDescriptor['parallelism']
  approvalAction?: string | null
  replayPolicy?: AgentToolDescriptor['replayPolicy']
  requiredCapabilities?: readonly string[]
  executionSurfaces?: readonly AgentToolExecutionSurface[]
}): AgentToolDescriptorSource {
  const effect = input.effect ?? conservativeSdkEffect(input.kind)
  const approvalAction = input.approvalAction !== undefined
    ? input.approvalAction
    : input.kind === 'sandbox' || input.kind === 'mcp'
      ? `tool:${input.name}`
      : null
  return descriptorSource({
    name: input.name,
    namespace: input.namespace ?? namespaceFromProvider(input.providerId ?? input.kind),
    providerId: input.providerId ?? null,
    kind: input.kind,
    exposure: input.exposure ?? 'immediate',
    effect,
    parallelism: input.parallelism ?? (
      effect === 'read' && approvalAction === null ? 'shared' : 'exclusive'
    ),
    approvalAction,
    replayPolicy: input.replayPolicy ?? (effect === 'read' ? 'safe' : 'manual_recovery'),
    requiredCapabilities: [...input.requiredCapabilities ?? []],
    requiredValueRefKinds: [],
    executionSurfaces: [...input.executionSurfaces ?? ['agent']],
  })
}

function descriptorSource(source: AgentToolDescriptorSource): AgentToolDescriptorSource {
  const parsed = agentToolDescriptorSourceSchema.parse({
    ...source,
    requiredCapabilities: sortedUnique(source.requiredCapabilities),
    requiredValueRefKinds: sortedUnique(source.requiredValueRefKinds),
    executionSurfaces: sortedUnique(source.executionSurfaces),
  })
  return Object.freeze(parsed)
}

interface NormalizedPlatformPolicy {
  namespace: string
  exposure: AgentToolDescriptor['exposure']
  effect: AgentToolDescriptor['effect']
  parallelism: AgentToolDescriptor['parallelism']
  approvalAction: string | null
  replayPolicy: AgentToolDescriptor['replayPolicy']
  requiredCapabilities: string[]
}

function normalizePlatformPolicy(definition: ToolDef): NormalizedPlatformPolicy {
  const configured: ToolRuntimePolicy = definition.runtimePolicy ?? {}
  const effect = configured.effect ?? (
    definition.isDestructive ? 'destructive' : definition.isReadOnly ? 'read' : 'world_write'
  )
  const approvalAction = configured.approvalAction !== undefined
    ? configured.approvalAction
    : definition.requiresApproval === true || effect === 'destructive'
      ? `tool:${definition.name}`
      : null
  const parallelism = configured.parallelism ?? (
    definition.parallelSafe !== false && effect === 'read' && approvalAction === null
      ? 'shared'
      : 'exclusive'
  )
  const replayPolicy = configured.replayPolicy ?? (effect === 'read' ? 'safe' : 'manual_recovery')
  return {
    namespace: configured.namespace ?? namespaceFromProvider(definition.providerId ?? definition.group),
    exposure: configured.exposure ?? 'immediate',
    effect,
    parallelism,
    approvalAction,
    replayPolicy,
    requiredCapabilities: sortedUnique(configured.requiredCapabilities ?? []),
  }
}

function normalizeExecutionSurfaces(definition: ToolDef): AgentToolExecutionSurface[] {
  const surfaces = definition.executionSurfaces ?? ['agent', 'automation', 'debug']
  return sortedUnique(surfaces.map(surface => surface === 'debug' ? 'developer' : surface))
}

function conservativeSdkEffect(kind: Exclude<AgentToolKind, 'platform'>): AgentToolDescriptor['effect'] {
  if (kind === 'hosted') return 'read'
  return 'external_write'
}

function namespaceFromProvider(value: string): string {
  const normalized = value.trim().toLowerCase()
    .replace(/^geo-platform-/u, '')
    .replace(/[^a-z0-9_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
  return normalized || 'platform'
}

function valueRefKinds(schema: Record<string, unknown>): string[] {
  const values = new Set<string>()
  const seen = new Set<Record<string, unknown>>()
  const visit = (node: Record<string, unknown>): void => {
    if (seen.has(node)) return
    seen.add(node)
    for (const value of Array.isArray(node['x-value-ref-kinds']) ? node['x-value-ref-kinds'] : []) {
      if (typeof value === 'string' && value.trim()) values.add(value.trim())
    }
    for (const key of ['properties', '$defs'] as const) {
      if (isRecord(node[key])) for (const child of Object.values(node[key]).filter(isRecord)) visit(child)
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const) {
      if (Array.isArray(node[key])) for (const child of node[key].filter(isRecord)) visit(child)
    }
    if (isRecord(node.items)) visit(node.items)
  }
  visit(schema)
  return [...values].sort()
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[]
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 显式 Capability Plugin 注册表
//
//   文件:       CapabilityPluginRegistry.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import path from 'node:path'

import type {
  AgentPluginBinding,
  AgentPluginSnapshot,
} from '@geo-agent-platform/shared-types/agent-step-context'
import type {
  RuntimePluginCapabilityBindings,
  RuntimePluginConfig,
} from '@geo-agent-platform/shared-types/runtime'

import { agentContextDigest } from '../step/agentContextDigest.js'

export interface PluginPermissionEnvelope extends RuntimePluginCapabilityBindings {}

/**
 * Plugin 是已注册能力的组合视图，不是动态代码加载器。解析过程不会扫描目录，
 * 也不会创建工具/MCP/路径权限；每一项 binding 都必须是基础 envelope 的子集。
 */
export class CapabilityPluginRegistry {
  constructor(private readonly config: RuntimePluginConfig) {}

  resolve(available: PluginPermissionEnvelope): AgentPluginSnapshot {
    if (!this.config.enabled) return emptySnapshot()
    const bindings = this.config.registrations
      .filter(registration => registration.enabled)
      .map(registration => {
        assertNoPermissionExpansion(registration.pluginId, registration.bindings, available)
        return deepFreeze<AgentPluginBinding>({
          pluginId: registration.pluginId,
          version: registration.version,
          source: registration.source,
          contentDigest: registration.contentDigest,
          toolNames: uniqueSorted(registration.bindings.toolNames),
          mcpServerNames: uniqueSorted(registration.bindings.mcpServerNames),
          skillIds: uniqueSorted(registration.bindings.skillIds),
          hookIds: uniqueSorted(registration.bindings.hookIds),
          writableRoots: uniqueSorted(registration.bindings.writableRoots.map(root => path.resolve(root))),
        })
      })
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId))
    const pluginIds = bindings.map(binding => binding.pluginId)
    return deepFreeze({
      pluginIds,
      bindings,
      catalogDigest: agentContextDigest(bindings),
    })
  }
}

function assertNoPermissionExpansion(
  pluginId: string,
  requested: RuntimePluginCapabilityBindings,
  available: PluginPermissionEnvelope,
): void {
  assertSubset(pluginId, 'tool', requested.toolNames, available.toolNames)
  assertSubset(pluginId, 'MCP server', requested.mcpServerNames, available.mcpServerNames)
  assertSubset(pluginId, 'Skill', requested.skillIds, available.skillIds)
  assertSubset(pluginId, 'Hook', requested.hookIds, available.hookIds)
  const allowedRoots = available.writableRoots.map(root => path.resolve(root))
  for (const requestedRoot of requested.writableRoots.map(root => path.resolve(root))) {
    if (!allowedRoots.some(allowed => isPathWithin(allowed, requestedRoot))) {
      throw new Error(`Plugin '${pluginId}' 试图扩大 writable root：${requestedRoot}`)
    }
  }
}

function assertSubset(
  pluginId: string,
  capabilityType: string,
  requested: readonly string[],
  available: readonly string[],
): void {
  const allowed = new Set(available)
  const expanded = [...new Set(requested)].filter(item => !allowed.has(item)).sort()
  if (expanded.length) {
    throw new Error(`Plugin '${pluginId}' 试图扩大 ${capabilityType} 权限：${expanded.join(', ')}`)
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function emptySnapshot(): AgentPluginSnapshot {
  return deepFreeze({
    pluginIds: [],
    bindings: [],
    catalogDigest: agentContextDigest([]),
  })
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

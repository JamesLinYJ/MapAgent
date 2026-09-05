// +-------------------------------------------------------------------------
//
//   地理智能平台 - MCP 配置刷新与精确 Step binding
//
//   文件:       McpRuntimeManager.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'

import type {
  AgentMcpSnapshot,
} from '@geo-agent-platform/shared-types/agent-step-context'
import type {
  RuntimeMcpConfig,
} from '@geo-agent-platform/shared-types/runtime'

import { agentContextDigest } from '../step/agentContextDigest.js'

export type McpRefreshReason = AgentMcpSnapshot['refreshReasons'][number]

export interface CaptureMcpBindingInput {
  config: RuntimeMcpConfig
  activeServerNames: readonly string[]
  toolServers: ReadonlyMap<string, string>
  resourceUris?: ReadonlyMap<string, readonly string[]>
  capabilityRoots?: readonly string[]
  forceNewBinding?: boolean
}

interface ScopeState {
  configDigest: string
  authDigest: string
  capabilityRootDigest: string
  catalogDigest: string
  revision: number
  snapshot: AgentMcpSnapshot
  dirtyReasons: Set<McpRefreshReason>
}

/**
 * MCP refresh 与连接创建分离：连接层先取得真实工具/资源目录，再把目录交给
 * manager 形成不可变 binding。配置或凭据变化只标记对应 scope；旧 Step 仍持有
 * 原 binding，新 binding 只会在下一次 capture 时产生。
 */
export class McpRuntimeManager {
  private readonly scopes = new Map<string, ScopeState>()
  private readonly bindingClosers = new Map<string, Set<() => Promise<void>>>()

  markDirty(scopeId: string, reason: Exclude<McpRefreshReason, 'initial'> = 'manual'): void {
    const state = this.scopes.get(scopeId)
    if (state) state.dirtyReasons.add(reason)
  }

  capture(scopeId: string, input: CaptureMcpBindingInput): AgentMcpSnapshot {
    const activeNames = [...new Set(input.activeServerNames)].sort()
    const activeNameSet = new Set(activeNames)
    const activeConfigs = input.config.enabled
      ? input.config.servers
        .filter(server => server.enabled && activeNameSet.has(server.name))
        .sort((left, right) => left.name.localeCompare(right.name))
      : []
    if (activeConfigs.length !== activeNames.length) {
      const configured = new Set(activeConfigs.map(server => server.name))
      const unknown = activeNames.filter(name => !configured.has(name))
      throw new Error(`MCP binding 引用了未启用的 server：${unknown.join(', ')}`)
    }

    const configDigest = agentContextDigest({
      enabled: input.config.enabled,
      connectTimeoutMs: input.config.connectTimeoutMs,
      closeTimeoutMs: input.config.closeTimeoutMs,
      servers: activeConfigs,
    })
    // 当前稳定版不从系统环境或运行配置读取 MCP 凭据。authDigest 保留为协议
    // 字段，并明确绑定“无外部凭据”事实，未来接入专用授权边界时再独立升级。
    const authDigest = agentContextDigest(activeConfigs.map(server => ({
      name: server.name,
      credentialSource: 'none',
    })))
    const capabilityRootDigest = agentContextDigest({
      roots: [...new Set(input.capabilityRoots ?? [])].sort(),
      filters: activeConfigs.map(server => ({
        name: server.name,
        allowedTools: [...server.allowedTools].sort(),
        blockedTools: [...server.blockedTools].sort(),
      })),
    })
    const toolsByServer = new Map(activeNames.map(name => [name, [] as string[]]))
    for (const [toolName, serverName] of input.toolServers) {
      const tools = toolsByServer.get(serverName)
      if (!tools) throw new Error(`MCP 工具 '${toolName}' 引用了非活动 server '${serverName}'`)
      tools.push(toolName)
    }
    for (const tools of toolsByServer.values()) tools.sort()
    const resourcesByServer = new Map(activeNames.map(name => [
      name,
      [...new Set(input.resourceUris?.get(name) ?? [])].sort(),
    ]))
    const toolCatalogDigest = agentContextDigest([...toolsByServer])
    const resourceCatalogDigest = agentContextDigest([...resourcesByServer])
    const catalogDigest = agentContextDigest({ toolCatalogDigest, resourceCatalogDigest })

    const previous = this.scopes.get(scopeId)
    const refreshReasons = previous
      ? new Set<McpRefreshReason>(previous.dirtyReasons)
      : new Set<McpRefreshReason>(['initial'])
    if (previous && previous.configDigest !== configDigest) refreshReasons.add('config')
    if (previous && previous.authDigest !== authDigest) refreshReasons.add('auth')
    if (previous && previous.capabilityRootDigest !== capabilityRootDigest) {
      refreshReasons.add('capability_roots')
    }
    if (previous && previous.catalogDigest !== catalogDigest) refreshReasons.add('catalog')
    if (previous && input.forceNewBinding) refreshReasons.add('manual')

    if (previous && refreshReasons.size === 0) return previous.snapshot

    const revision = (previous?.revision ?? 0) + 1
    const bindingId = `mcp_binding_${randomUUID()}`
    const servers = activeConfigs.map(server => ({
      name: server.name,
      transport: server.transport,
      approval: server.approval,
      configDigest: agentContextDigest(server),
      authDigest: agentContextDigest({
        credentialSource: 'none',
      }),
      toolNames: toolsByServer.get(server.name) ?? [],
      resourceUris: resourcesByServer.get(server.name) ?? [],
    }))
    const snapshot = deepFreeze<AgentMcpSnapshot>({
      bindingId,
      catalogRevision: revision,
      configDigest,
      authDigest,
      capabilityRootDigest,
      toolCatalogDigest,
      resourceCatalogDigest,
      refreshReasons: [...refreshReasons].sort(refreshReasonOrder),
      servers,
    })
    this.scopes.set(scopeId, {
      configDigest,
      authDigest,
      capabilityRootDigest,
      catalogDigest,
      revision,
      snapshot,
      dirtyReasons: new Set(),
    })
    return snapshot
  }

  bindClose(bindingId: string, close: () => Promise<void>): () => Promise<void> {
    const closers = this.bindingClosers.get(bindingId) ?? new Set()
    closers.add(close)
    this.bindingClosers.set(bindingId, closers)
    let released = false
    return async () => {
      if (released) return
      released = true
      const bound = this.bindingClosers.get(bindingId)
      if (!bound?.delete(close)) return
      if (bound.size === 0) this.bindingClosers.delete(bindingId)
      await close()
    }
  }
}

function refreshReasonOrder(left: McpRefreshReason, right: McpRefreshReason): number {
  const order: McpRefreshReason[] = [
    'initial',
    'config',
    'auth',
    'capability_roots',
    'catalog',
    'manual',
  ]
  return order.indexOf(left) - order.indexOf(right)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

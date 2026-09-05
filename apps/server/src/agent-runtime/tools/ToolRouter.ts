// +-------------------------------------------------------------------------
//
//   地理智能平台 - StepContext 工具路由器
//
//   文件:       ToolRouter.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AgentStepContext } from '@geo-agent-platform/shared-types/agent-step-context'
import type {
  AgentToolDescriptorSource,
} from '@geo-agent-platform/shared-types/tool-runtime'

import type { ToolDef } from '../../framework/types.js'
import { ToolCatalog } from './ToolCatalog.js'

export interface RoutedToolCall {
  callId: string
  toolName: string
  stepId: string
  contextDigest: string
  toolPlanDigest: string
  objectiveRevision: number
  context: AgentStepContext
  descriptor: AgentToolDescriptorSource
  definition: ToolDef | null
}

export interface RoutedPlatformToolCall extends RoutedToolCall {
  definition: ToolDef
}

/**
 * Router 在 prepare 时把 callId 固定到产生该调用的 StepContext。后续排队、
 * 审批和真正 handler dispatch 都读取同一 binding，不再重新扫描“最新工具列表”。
 */
export class ToolRouter {
  private currentContext: AgentStepContext | null = null
  private readonly bindings = new Map<string, RoutedToolCall>()

  constructor(private readonly catalog: ToolCatalog) {}

  bindStepContext(context: AgentStepContext): void {
    if (context.toolPlanDigest !== context.tools.catalogDigest) {
      throw new Error(`StepContext '${context.identity.stepId}' 的工具计划摘要不一致`)
    }
    this.currentContext = context
  }

  currentStepContext(): AgentStepContext {
    if (!this.currentContext) throw new Error('尚未捕获当前 StepContext')
    return this.currentContext
  }

  prepareCall(callId: string, toolName: string): RoutedToolCall {
    const existing = this.bindings.get(callId)
    if (existing) {
      if (existing.toolName !== toolName) {
        throw new Error(`工具调用 '${callId}' 已绑定 '${existing.toolName}'，不能改为 '${toolName}'`)
      }
      return existing
    }
    const context = this.currentContext
    if (!context) throw new Error(`工具调用 '${callId}' 发生前尚未捕获 StepContext`)
    const planned = context.tools.entries.find(entry => entry.name === toolName)
    if (!planned) {
      throw new Error(`工具 '${toolName}' 不在 StepContext '${context.identity.stepId}' 的工具计划中`)
    }
    const descriptor = descriptorSourceFromPlanEntry(planned)
    const definition = descriptor.kind === 'platform'
      ? this.catalog.assertPlatformBinding(descriptor)
      : null
    const binding = Object.freeze({
      callId,
      toolName,
      stepId: context.identity.stepId,
      contextDigest: context.contextDigest,
      toolPlanDigest: context.toolPlanDigest,
      objectiveRevision: context.objectiveRevision,
      context,
      descriptor,
      definition,
    })
    this.bindings.set(callId, binding)
    return binding
  }

  preparePlatformCall(callId: string, toolName: string): RoutedPlatformToolCall {
    const binding = this.prepareCall(callId, toolName)
    assertPlatformRoute(binding, toolName)
    return binding
  }

  /**
   * Agent-as-tool 与 Handoff 的内层工具继承父 Runner 当前采样的权限、世界和
   * 审批快照，但拥有独立 callId 与目录描述符。调用者仍须先通过子 Agent 的
   * allowedToolNames 校验；这里仅负责把已允许调用固定到同一 StepContext。
   */
  prepareNestedPlatformCall(callId: string, toolName: string): RoutedPlatformToolCall {
    const existing = this.bindings.get(callId)
    if (existing) {
      if (existing.toolName !== toolName) {
        throw new Error(`工具调用 '${callId}' 已绑定 '${existing.toolName}'，不能改为 '${toolName}'`)
      }
      assertPlatformRoute(existing, toolName)
      return existing
    }
    const context = this.currentStepContext()
    const descriptor = this.catalog.platformSource(toolName)
    const binding = Object.freeze({
      callId,
      toolName,
      stepId: context.identity.stepId,
      contextDigest: context.contextDigest,
      toolPlanDigest: context.toolPlanDigest,
      objectiveRevision: context.objectiveRevision,
      context,
      descriptor,
      definition: this.catalog.assertPlatformBinding(descriptor),
    })
    this.bindings.set(callId, binding)
    return binding
  }

  requireCall(callId: string, toolName: string): RoutedToolCall {
    const binding = this.bindings.get(callId)
    if (!binding) throw new Error(`工具调用 '${callId}' 尚未建立 StepContext 路由`)
    if (binding.toolName !== toolName) {
      throw new Error(`工具调用 '${callId}' 已绑定 '${binding.toolName}'，不能执行 '${toolName}'`)
    }
    return binding
  }

  requirePlatformCall(callId: string, toolName: string): RoutedPlatformToolCall {
    const binding = this.requireCall(callId, toolName)
    assertPlatformRoute(binding, toolName)
    return binding
  }

  release(callId: string): void {
    this.bindings.delete(callId)
  }
}

function descriptorSourceFromPlanEntry(
  entry: AgentStepContext['tools']['entries'][number],
): AgentToolDescriptorSource {
  return {
    name: entry.name,
    namespace: entry.namespace,
    providerId: entry.providerId,
    kind: entry.kind,
    exposure: entry.exposure,
    effect: entry.effect,
    parallelism: entry.parallelism,
    approvalAction: entry.approvalAction,
    replayPolicy: entry.replayPolicy,
    requiredCapabilities: entry.requiredCapabilities,
    requiredValueRefKinds: entry.requiredValueRefKinds,
    executionSurfaces: entry.executionSurfaces,
  }
}

function assertPlatformRoute(
  binding: RoutedToolCall,
  toolName: string,
): asserts binding is RoutedPlatformToolCall {
  if (binding.descriptor.kind !== 'platform' || !binding.definition) {
    throw new Error(
      `工具 '${toolName}' 的计划类型是 '${binding.descriptor.kind}'，不能路由到平台 handler`,
    )
  }
}

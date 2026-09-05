// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具可见性与执行策略
//
//   文件:       ToolPolicy.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AgentState } from '@geo-agent-platform/shared-types'
import type { AgentRuntimeConfig } from '@geo-agent-platform/shared-types/runtime'
import type { AgentPermissionSnapshot } from '@geo-agent-platform/shared-types/agent-step-context'

import type { ToolRegistry } from '../../framework/registry.js'
import { platformToolDescriptorSource } from './ToolCatalog.js'

export const DEVELOPER_TOOL_PROVIDER_ID = 'geo-platform-developer-tools'

export type ToolPermissionRule = AgentPermissionSnapshot['toolRules'][number]

export function resolveToolPermission(
  toolName: string,
  rules: readonly ToolPermissionRule[],
): ToolPermissionRule | null {
  const matches = rules.filter(rule => toolPatternMatches(rule.toolPattern, toolName))
  matches.sort((left, right) => (
    right.priority - left.priority
    || patternSpecificity(right.toolPattern) - patternSpecificity(left.toolPattern)
    || decisionPrecedence(right.decision) - decisionPrecedence(left.decision)
    || left.toolPattern.localeCompare(right.toolPattern)
  ))
  return matches[0] ?? null
}

export function developerToolsEnabledForRuntime(config: AgentRuntimeConfig): boolean {
  return config.developer.enabled && config.developer.allowedRoots.length > 0
}

export interface ToolPolicyDependencies {
  registry: ToolRegistry
  state: () => AgentState
  claimedWorkflowSteps: () => ReadonlySet<string>
  externalAgentCalls: () => ReadonlyMap<string, string>
  developerModeEnabled?: () => boolean
}

/**
 * ToolPolicy 只回答“当前不可变运行视图允许什么”，不执行、不写数据库、
 * 不发布 UI 投影。Effect 判断来自 ToolDescriptor，而不是重复猜测旧布尔字段。
 */
export class ToolPolicy {
  private activeHandoffAgentId: string | null = null

  constructor(private readonly dependencies: ToolPolicyDependencies) {}

  isExecutionEnabled(): boolean {
    return !this.dependencies.state().planMode
  }

  isSdkExtensionEnabled(): boolean {
    const state = this.dependencies.state()
    return !state.planMode && state.agentWorkflow === null
  }

  isToolEnabled(toolName: string): boolean {
    const tool = this.dependencies.registry.get(toolName)
    if (!tool || !this.isDeveloperToolAllowed(tool.providerId)) return false
    const descriptor = platformToolDescriptorSource(tool)
    const state = this.dependencies.state()
    if (state.planMode) return planReadable(descriptor)
    if (!state.agentWorkflow) return true
    if (state.agentWorkflow.status === 'cancelled' || state.agentWorkflow.status === 'failed') return false
    if (ACTIVE_WORKFLOW_CONTROL_TOOLS.has(toolName)) return true
    if (state.agentWorkflow.status === 'adjusting' || state.agentWorkflow.status === 'completed') {
      return planReadable(descriptor)
    }
    return this.hasReadyWorkflowStep(toolName, 'supervisor')
  }

  isExternalAgentEnabled(agentId: string): boolean {
    const state = this.dependencies.state()
    return !state.planMode && (
      this.hasReadyWorkflowStep(agentId, agentId)
      || this.hasRunningExternalAgentStep(agentId)
    )
  }

  isHandoffEnabled(agentId: string): boolean {
    const state = this.dependencies.state()
    if (state.planMode || state.agentWorkflow !== null) return false
    if (this.activeHandoffAgentId === null) return true
    if (this.activeHandoffAgentId !== agentId) return false
    const owner = state.subAgents.find(candidate => candidate.agentId === agentId)
    return owner?.status === 'running' && Boolean(owner.activeCallId)
  }

  activateHandoff(agentId: string): void {
    if (!this.isHandoffEnabled(agentId)) {
      throw new Error(`当前运行边界禁止转交给子智能体 '${agentId}'`)
    }
    this.activeHandoffAgentId = agentId
  }

  restoreHandoffOwnership(agentId: string): void {
    const state = this.dependencies.state()
    const owner = state.subAgents.find(candidate => candidate.agentId === agentId)
    if (state.planMode
      || state.agentWorkflow !== null
      || !owner
      || owner.status !== 'running'
      || !owner.activeCallId) {
      throw new Error(`Handoff 子智能体 '${agentId}' 没有可恢复的对话所有权`)
    }
    if (this.activeHandoffAgentId && this.activeHandoffAgentId !== agentId) {
      throw new Error(`Handoff 所有权已属于 '${this.activeHandoffAgentId}'，不能恢复 '${agentId}'`)
    }
    this.activeHandoffAgentId = agentId
  }

  finishHandoff(agentId: string): void {
    if (this.activeHandoffAgentId === agentId) this.activeHandoffAgentId = null
  }

  activeHandoffAgent(): string | null {
    return this.activeHandoffAgentId
  }

  isToolEnabledForHandoff(agentId: string, toolName: string): boolean {
    const state = this.dependencies.state()
    const owner = state.subAgents.find(candidate => candidate.agentId === agentId)
    const tool = this.dependencies.registry.get(toolName)
    return this.activeHandoffAgentId === agentId
      && owner?.status === 'running'
      && Boolean(owner.activeCallId)
      && Boolean(tool)
      && this.isDeveloperToolAllowed(tool?.providerId)
      && this.isHandoffEnabled(agentId)
  }

  assertHandoffToolExecutionAllowed(agentId: string, toolName: string): void {
    const owner = this.dependencies.state().subAgents.find(candidate => candidate.agentId === agentId)
    if (owner?.status === 'cancelling' || owner?.status === 'cancelled') {
      throw new Error(`subagent_cancelled: Handoff 子智能体 '${agentId}' 已接受取消请求，禁止启动新的工具 '${toolName}'。`)
    }
    if (!this.isToolEnabledForHandoff(agentId, toolName)) {
      throw new Error(`Handoff 子智能体 '${agentId}' 当前无权执行工具 '${toolName}'。`)
    }
  }

  isToolEnabledForSubAgent(agentId: string, toolName: string): boolean {
    const tool = this.dependencies.registry.get(toolName)
    return Boolean(tool)
      && this.isDeveloperToolAllowed(tool?.providerId)
      && this.isExecutionEnabled()
      && [...this.dependencies.externalAgentCalls().values()].some(candidate => candidate === agentId)
  }

  assertPlanModeAllows(toolName: string): void {
    if (this.activeHandoffAgentId) {
      this.assertHandoffToolExecutionAllowed(this.activeHandoffAgentId, toolName)
    }
    const state = this.dependencies.state()
    if (!state.planMode) return
    const tool = this.dependencies.registry.get(toolName)
    if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
    if (planReadable(platformToolDescriptorSource(tool))) return
    throw new Error(`计划模式只允许无副作用的读取工具，工具 '${toolName}' 会产生写入或外部影响。请先提交工作流结束规划阶段。`)
  }

  assertExecutionPhaseAllowsExternalAgent(agentId: string): void {
    if (this.isExecutionEnabled()) return
    throw new Error(`计划模式禁止调用子智能体 '${agentId}'。请先用 submit_agent_workflow 记录工作流并开始执行。`)
  }

  assertExternalAgentIsRunning(agentId: string): void {
    const running = [...this.dependencies.externalAgentCalls().values()].some(candidate => candidate === agentId)
    if (!running) {
      throw new Error(`子智能体 '${agentId}' 没有正在执行的已批准工作流步骤，不能调用平台工具。`)
    }
  }

  private hasReadyWorkflowStep(toolName: string, ownerAgentId: string): boolean {
    const workflow = this.dependencies.state().agentWorkflow
    if (!workflow || workflow.status !== 'running') return false
    const completed = new Set(workflow.steps
      .filter(step => step.status === 'completed' || step.status === 'skipped')
      .map(step => step.stepId))
    const claimed = this.dependencies.claimedWorkflowSteps()
    return workflow.steps.some(step => (
      step.status === 'pending'
      && step.toolName === toolName
      && step.ownerAgentId === ownerAgentId
      && !claimed.has(step.stepId)
      && step.dependsOn.every(dependency => completed.has(dependency))
    ))
  }

  private hasRunningExternalAgentStep(agentId: string): boolean {
    const state = this.dependencies.state()
    const subAgent = state.subAgents.find(candidate => (
      candidate.agentId === agentId
      && candidate.status === 'running'
      && candidate.currentStepId
    ))
    if (!subAgent?.currentStepId || state.agentWorkflow?.status !== 'running') return false
    return state.agentWorkflow.steps.some(step => (
      step.stepId === subAgent.currentStepId
      && step.status === 'running'
      && step.kind === 'agent'
      && step.toolName === agentId
      && step.ownerAgentId === agentId
    ))
  }

  private isDeveloperToolAllowed(providerId?: string): boolean {
    return providerId !== DEVELOPER_TOOL_PROVIDER_ID
      || this.dependencies.developerModeEnabled?.() === true
  }
}

function planReadable(descriptor: ReturnType<typeof platformToolDescriptorSource>): boolean {
  return descriptor.effect === 'read'
    && (descriptor.exposure === 'plan_readonly' || descriptor.exposure === 'immediate')
}

const ACTIVE_WORKFLOW_CONTROL_TOOLS = new Set([
  'request_clarification',
  'revise_agent_workflow',
])

function toolPatternMatches(pattern: string, toolName: string): boolean {
  const expression = `^${pattern.split('*').map(escapeRegExp).join('.*')}$`
  return new RegExp(expression, 'u').test(toolName)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function patternSpecificity(pattern: string): number {
  return pattern.replaceAll('*', '').length
}

function decisionPrecedence(decision: ToolPermissionRule['decision']): number {
  if (decision === 'always_deny') return 3
  if (decision === 'always_ask') return 2
  return 1
}

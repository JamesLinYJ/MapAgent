// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具执行与持久化协调器
//
//   文件:       toolExecutionCoordinator.ts
//
//   日期:       2026年06月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { ToolRegistry } from '../framework/registry.js'
import type { ToolContext, ToolResult, ValueRef } from '../framework/types.js'
import type { ModelAdapter } from '../model/registry.js'
import { recordModelCompletionUsage, type ModelCompletionService } from '../model/modelResultCache.js'
import { runSdkStructuredOutput } from '../model/sdkStructuredOutput.js'
import type { ToolExecutionStore } from '../store/runtimePorts.js'
import type { AuthContext } from '../security/types.js'
import {
  subAgentInvocationSchema,
  type AgentToolOutputMetadata,
} from '../schemas/types.js'
import { resolveRuntimeValueRef, type ToolResultCommitService } from '../tools/resultPersistence.js'
import { makeId } from '../utils/ids.js'
import { ItemSink } from '../conversation/itemSink.js'
import { RunEventSink } from './turnRunner.js'
import { developerToolsEnabledForRuntime, ToolPolicy } from '../agent-runtime/tools/ToolPolicy.js'
import { resolveToolPermission } from '../agent-runtime/tools/ToolPolicy.js'
import { ensureToolSchemas } from '../framework/schema.js'
import { AGENT_WORKFLOW_CONTROL_TOOLS } from './agentWorkflowState.js'
import { validateGeospatialComposeWorkflowDraft } from './geospatialCompose.js'
import type { AgentStepContext } from '@geo-agent-platform/shared-types/agent-step-context'
import { ToolCatalog } from '../agent-runtime/tools/ToolCatalog.js'
import {
  ToolRouter,
} from '../agent-runtime/tools/ToolRouter.js'
import { ToolInvocationLedger } from '../agent-runtime/tools/ToolInvocationLedger.js'
import { ToolEffectCommitter } from '../agent-runtime/tools/ToolEffectCommitter.js'
import { WorkflowBinder } from '../agent-runtime/tools/WorkflowBinder.js'
import { ToolProjectionPublisher } from '../agent-runtime/tools/ToolProjectionPublisher.js'
import {
  ApprovalService,
  type ApprovalCallInput,
  type ApprovalExecutionDecision,
  type ApprovalRequirement,
} from '../agent-runtime/approvals/ApprovalService.js'
import {
  RuntimeHookRegistry,
  type RuntimeHookSession,
} from '../agent-runtime/hooks/RuntimeHookRegistry.js'

interface CoordinatorOptions {
  store: ToolExecutionStore
  resultCommitService: Pick<ToolResultCommitService, 'commit'>
  registry: ToolRegistry
  adapter: ModelAdapter | null
  modelCompletions?: ModelCompletionService
  workspaceId: string | null
  runId: string
  sessionId: string
  threadId: string
  turnId: string
  modelName?: string | null
  inlineToolResultMaxChars: number
  runtimeConfig?: import('../schemas/types.js').AgentRuntimeConfig
  subAgentConfigs?: import('../schemas/types.js').AgentRuntimeConfig['subAgents']
  auth?: AuthContext | null
  eventSink: RunEventSink
  itemSink: ItemSink
  valueState: Map<string, unknown>
  signal: AbortSignal
  onPlanModeChanged?: (enabled: boolean) => void
  runtimeHooks?: RuntimeHookSession
}

// ToolExecutionCoordinator
//
// 自动 Agent 工具与确定性领域链共享这一执行路径；prepared 之后的每个状态
// 都先落盘再推进，未知副作用状态不会被包装成成功结果。
export class ToolExecutionCoordinator {
  private readonly preparedCalls = new Set<string>()
  private readonly preparedCallRoutes = new Map<string, 'step' | 'catalog'>()
  private readonly preparedArguments = new Map<string, Record<string, unknown>>()
  private readonly preparingCalls = new Map<string, Promise<void>>()
  private readonly externalAgentCalls = new Map<string, string>()
  private readonly callObjectiveRevisions = new Map<string, number>()
  private readonly canonicalToolInputs = new Map<string, {
    toolName: string
    route: 'step' | 'catalog'
    source: string
    input: Record<string, unknown>
  }>()
  private modelInputObjectiveRevision: number
  private readonly policy: ToolPolicy
  private readonly invocationLedger: ToolInvocationLedger
  private readonly effectCommitter: ToolEffectCommitter
  private readonly catalog: ToolCatalog
  private readonly router: ToolRouter
  private readonly approvals: ApprovalService
  private readonly workflowBinder: WorkflowBinder
  private readonly projectionPublisher: ToolProjectionPublisher

  constructor(private readonly options: CoordinatorOptions) {
    const objectiveRevision = options.store.getRun(options.runId).state.objectiveRevision
    this.modelInputObjectiveRevision = Number.isInteger(objectiveRevision) && objectiveRevision > 0
      ? objectiveRevision
      : 1
    this.invocationLedger = new ToolInvocationLedger(options.store, options.runId)
    this.effectCommitter = new ToolEffectCommitter(
      this.invocationLedger,
      options.resultCommitService,
    )
    this.catalog = new ToolCatalog(options.registry)
    this.router = new ToolRouter(this.catalog)
    this.approvals = new ApprovalService({
      store: options.store,
      runId: options.runId,
      threadId: options.threadId,
      sessionId: options.sessionId,
    })
    this.workflowBinder = new WorkflowBinder({
      store: options.store,
      registry: options.registry,
      runId: options.runId,
      eventSink: options.eventSink,
    })
    this.projectionPublisher = new ToolProjectionPublisher({
      store: options.store,
      registry: options.registry,
      runId: options.runId,
      threadId: options.threadId,
      turnId: options.turnId,
      inlineToolResultMaxChars: options.inlineToolResultMaxChars,
      eventSink: options.eventSink,
      itemSink: options.itemSink,
      valueState: options.valueState,
      ...(options.onPlanModeChanged ? { onPlanModeChanged: options.onPlanModeChanged } : {}),
    })
    this.policy = new ToolPolicy({
      registry: options.registry,
      state: () => this.options.store.getRun(this.options.runId).state,
      claimedWorkflowSteps: () => this.workflowBinder.activeClaimedStepIds(
        this.options.store.getRun(this.options.runId).state.agentWorkflow,
      ),
      externalAgentCalls: () => this.externalAgentCalls,
      developerModeEnabled: () => this.options.runtimeConfig
        ? developerToolsEnabledForRuntime(this.options.runtimeConfig)
        : false,
    })
  }

  bindStepContext(context: AgentStepContext): void {
    this.router.bindStepContext(context)
  }

  bindModelInputObjectiveRevision(objectiveRevision: number): void {
    if (!Number.isInteger(objectiveRevision) || objectiveRevision < 1) {
      throw new Error(`无效的模型输入 objective revision '${objectiveRevision}'`)
    }
    if (objectiveRevision < this.modelInputObjectiveRevision) {
      throw new Error(
        `模型输入 objective revision 不能从 ${this.modelInputObjectiveRevision} 回退到 ${objectiveRevision}`,
      )
    }
    this.modelInputObjectiveRevision = objectiveRevision
  }

  checkpointTerminalToolCallIds(): Promise<string[]> {
    return this.invocationLedger.checkpointTerminalCallIds()
  }

  currentModelInputObjectiveRevision(): number {
    return this.modelInputObjectiveRevision
  }

  isExecutionEnabled(): boolean {
    return this.policy.isExecutionEnabled()
  }

  async markSdkToolCallPending(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<void> {
    await this.prepareSdkExtensionCall(toolName, args, callId)
    const requirement = await this.approvalRequirement(toolName, args, callId)
    if (!requirement.requiresApproval) {
      await this.invocationLedger.start(
        callId,
        await this.approvalExecutionDecision(toolName, args, callId),
      )
    }
  }

  async recordSdkRejectedToolCall(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
    error: string,
  ): Promise<void> {
    const context = this.router.currentStepContext()
    const planned = context.tools.entries.some(entry => entry.name === toolName)
    if (!planned) {
      await this.invocationLedger.rejectUnplanned({
        runId: this.options.runId,
        turnId: this.options.turnId,
        callId,
        toolName,
        objectiveRevision: context.objectiveRevision,
        toolPlanDigest: context.toolPlanDigest,
        args,
        error,
      })
      return
    }
    const routed = this.router.prepareCall(callId, toolName)
    await this.invocationLedger.prepare({
      runId: this.options.runId,
      turnId: this.options.turnId,
      callId,
      stepId: routed.stepId,
      objectiveRevision: routed.objectiveRevision,
      toolPlanDigest: routed.toolPlanDigest,
      descriptor: routed.descriptor,
      args,
      executionSurface: 'agent',
    })
    await this.invocationLedger.reject(callId, error, false)
  }

  async markSdkToolCallTerminal(input: {
    callId: string
    outcome: 'succeeded' | 'failed' | 'rejected' | 'aborted'
    resultId: string | null
    error: string | null
  }): Promise<void> {
    let current = await this.options.store.getToolInvocation(this.options.runId, input.callId)
    if (!current || current.status === 'checkpointed' || current.terminalOutcome !== null) return
    if (current.status === 'prepared') {
      const routed = this.router.requireCall(input.callId, current.toolName)
      current = await this.invocationLedger.start(
        input.callId,
        await this.approvalExecutionDecision(
          current.toolName,
          this.requirePreparedArguments(input.callId),
          input.callId,
        ),
      )
      if (current.stepId !== routed.stepId) {
        throw new Error(`工具调用 '${input.callId}' 的 invocation 与 StepContext 不一致`)
      }
    }
    if (input.outcome === 'succeeded') {
      await this.invocationLedger.succeed(input.callId, input.resultId, false)
    } else if (input.outcome === 'failed') {
      await this.invocationLedger.fail(input.callId, input.error ?? 'SDK 工具调用失败', false)
    } else if (input.outcome === 'rejected') {
      await this.invocationLedger.reject(input.callId, input.error ?? 'SDK 拒绝工具调用', false)
    } else {
      await this.invocationLedger.abort(input.callId, input.error ?? 'SDK 中止工具调用', false)
    }
  }

  formatToolFailureForModel(toolName: string, message: string): string {
    const state = this.options.store.getRun(this.options.runId).state
    if (state.agentWorkflow?.status === 'adjusting' && state.failedTool === toolName) {
      return [
        `工具“${this.toolLabel(toolName)}”执行失败：${message}`,
        '工作流进度已记录该步骤失败。',
        '可以调用已注册的无副作用读取工具诊断原因；路径实质变化时用 revise_agent_workflow 更新工作流，缺少用户数据或选择时请求澄清。',
      ].join(' ')
    }
    return `工具调用失败：${message}。请检查参数类型和必需字段后重试。`
  }

  formatUnavailableToolForModel(toolName: string): string {
    const workflow = this.options.store.getRun(this.options.runId).state.agentWorkflow
    if (workflow?.status === 'adjusting') {
      return [
        `工具 '${toolName}' 不在当前可用工具列表中。`,
        '当前智能体工作流正在调整；只能使用已注册的无副作用读取工具诊断，或更新工作流、请求澄清。',
      ].join(' ')
    }
    if (workflow?.status === 'completed') {
      return [
        `工具 '${toolName}' 不在当前可用工具列表中。`,
        '当前计划步骤已完成，处于交付前验证阶段；可继续使用无副作用读取工具。',
        '如果需要新的写入、产出或外部操作，请先调用 revise_agent_workflow 显式补充执行步骤。',
      ].join(' ')
    }
    return `工具 '${toolName}' 不在当前可用工具列表中。请只使用本轮公开的确切工具名；不存在合适能力时如实说明限制。`
  }

  // 任意 MCP 与沙箱执行还没有统一的读写语义契约，因此不能在规划或结构化
  // 工作流中按名称猜测其副作用。load_skill 不走此开关：它只物化配置快照，
  // 不授予 Skill 中后续操作的执行权限。
  isSdkExtensionEnabled(): boolean {
    return this.policy.isSdkExtensionEnabled()
  }

  isToolEnabled(toolName: string): boolean {
    return this.policy.isToolEnabled(toolName)
  }

  isExternalAgentEnabled(agentId: string): boolean {
    return this.policy.isExternalAgentEnabled(agentId)
  }

  isHandoffEnabled(agentId: string): boolean {
    return this.policy.isHandoffEnabled(agentId)
  }

  activateHandoff(agentId: string): void {
    this.policy.activateHandoff(agentId)
  }

  restoreHandoffOwnership(agentId: string): void {
    this.policy.restoreHandoffOwnership(agentId)
  }

  finishHandoff(agentId: string): void {
    this.policy.finishHandoff(agentId)
  }

  activeHandoffAgent(): string | null {
    return this.policy.activeHandoffAgent()
  }

  isToolEnabledForHandoff(agentId: string, toolName: string): boolean {
    return this.policy.isToolEnabledForHandoff(agentId, toolName)
  }

  isToolEnabledForSubAgent(agentId: string, toolName: string): boolean {
    return this.policy.isToolEnabledForSubAgent(agentId, toolName)
  }

  validateToolCall(toolName: string, args: Record<string, unknown>): string | null {
    if (!AGENT_WORKFLOW_DEFINITION_TOOLS.has(toolName)) return null
    const genericError = validateAgentWorkflowDraft(
      args,
      this.options.registry,
      this.options.subAgentConfigs ?? this.options.runtimeConfig?.subAgents ?? [],
    )
    if (genericError) return genericError
    const state = this.options.store.getRun(this.options.runId).state
    return state.runProfile === 'geospatial_compose'
      ? validateGeospatialComposeWorkflowDraft(
          args,
          this.options.registry,
          this.options.subAgentConfigs ?? this.options.runtimeConfig?.subAgents ?? [],
        )
      : null
  }

  async canonicalizeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<Record<string, unknown>> {
    return this.canonicalizeToolCallWithRoute(toolName, args, callId, 'step')
  }

  async canonicalizeCatalogToolCall(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<Record<string, unknown>> {
    return this.canonicalizeToolCallWithRoute(toolName, args, callId, 'catalog')
  }

  private async canonicalizeToolCallWithRoute(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
    route: 'step' | 'catalog',
  ): Promise<Record<string, unknown>> {
    const source = JSON.stringify(args)
    const existing = this.canonicalToolInputs.get(callId)
    if (existing) {
      if (existing.toolName !== toolName || existing.route !== route || existing.source !== source) {
        throw new Error(`工具调用 '${callId}' 的 Hook 输入已固定，不能换名或改写原始参数`)
      }
      return structuredClone(existing.input)
    }
    const context = this.router.currentStepContext()
    const descriptor = route === 'step'
      ? context.tools.entries.find(entry => entry.name === toolName)
      : this.catalog.platformSource(toolName)
    if (!descriptor) throw new Error(`工具 '${toolName}' 不在当前 StepContext 工具计划中`)
    const result = await (this.options.runtimeHooks ?? EMPTY_RUNTIME_HOOKS).run({
      runId: this.options.runId,
      turnId: this.options.turnId,
      stepId: context.identity.stepId,
      eventType: 'PreToolUse',
      attributes: {
        toolName,
        effect: descriptor.effect,
        providerId: descriptor.providerId ?? '',
      },
      toolName,
      toolInput: args,
    }, {
      risk: descriptor.effect === 'read' ? 'normal' : 'high',
      signal: this.options.signal,
      validateUpdatedToolInput: input => this.validateCanonicalToolInput(toolName, input),
      authorizeUpdatedToolInput: input => {
        const rule = resolveToolPermission(toolName, context.permissions.toolRules)
        if (rule?.decision === 'always_deny') {
          throw new Error(`StepContext 权限策略禁止工具 '${toolName}'`)
        }
        const rejection = this.validateToolCall(toolName, input)
        if (rejection) throw new Error(rejection)
      },
    })
    const canonical = result.toolInput ?? structuredClone(args)
    this.canonicalToolInputs.set(callId, {
      toolName,
      route,
      source,
      input: structuredClone(canonical),
    })
    return canonical
  }

  private validateCanonicalToolInput(
    toolName: string,
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const definition = this.options.registry.get(toolName)
    if (!definition) throw new Error(`工具 '${toolName}' 未注册，不能重写输入`)
    const invocation = splitWorkflowStepIdentity(input)
    const parsed = ensureToolSchemas(definition).parameters.parse(invocation.toolArgs)
    return 'workflowStepId' in input
      ? { ...parsed, workflowStepId: invocation.workflowStepId }
      : parsed
  }

  async rejectPreparedToolCall(toolName: string, callId: string, message: string): Promise<void> {
    this.projectionPublisher.rejectPrepared(toolName, callId, message)
    const invocation = await this.options.store.getToolInvocation(this.options.runId, callId)
    if (invocation && invocation.terminalOutcome === null) {
      await this.invocationLedger.reject(callId, message, false)
    }
  }

  async rejectToolApproval(callId: string, message: string): Promise<void> {
    const invocation = await this.options.store.getToolInvocation(this.options.runId, callId)
    if (!invocation) throw new Error(`审批工具调用 '${callId}' 尚未进入持久账本`)
    if (invocation.terminalOutcome === 'rejected') return
    if (invocation.terminalOutcome !== null) {
      throw new Error(
        `审批工具调用 '${callId}' 已以 ${invocation.terminalOutcome} 终结，不能改为 rejected`,
      )
    }
    await this.invocationLedger.reject(callId, message, false)
    await this.projectionPublisher.publishApprovalRejected({
      callId,
      toolName: invocation.toolName,
      objectiveRevision: invocation.objectiveRevision,
      message,
    })
  }

  async prepare(toolName: string, args: Record<string, unknown>, callId: string): Promise<void> {
    return this.prepareWithRoute(toolName, args, callId, 'step')
  }

  async requiresApproval(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<boolean> {
    await this.prepare(toolName, args, callId)
    return (await this.approvalRequirement(toolName, args, callId)).requiresApproval
  }

  async requiresSdkExtensionApproval(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<boolean> {
    await this.prepareSdkExtensionCall(toolName, args, callId)
    return (await this.approvalRequirement(toolName, args, callId)).requiresApproval
  }

  async requiresExternalAgentApproval(
    agentId: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<boolean> {
    return (await this.approvalRequirement(agentId, args, callId)).requiresApproval
  }

  async requiresCatalogApproval(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<boolean> {
    await this.prepareCatalogTool(toolName, args, callId)
    return (await this.approvalRequirement(toolName, args, callId)).requiresApproval
  }

  async prepareCatalogTool(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<void> {
    return this.prepareWithRoute(toolName, args, callId, 'catalog')
  }

  private async prepareWithRoute(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
    route: 'step' | 'catalog',
  ): Promise<void> {
    if (this.preparedCalls.has(callId)) {
      const preparedRoute = this.preparedCallRoutes.get(callId)
      if (preparedRoute !== route) {
        throw new Error(`工具调用 '${callId}' 已通过 ${preparedRoute} 路由准备，不能改为 ${route}`)
      }
      return
    }
    const preparing = this.preparingCalls.get(callId)
    if (preparing) {
      await preparing
      return
    }
    const operation = this.preparePlatformToolCall(toolName, args, callId, route)
    this.preparingCalls.set(callId, operation)
    try {
      await operation
    } finally {
      if (this.preparingCalls.get(callId) === operation) this.preparingCalls.delete(callId)
    }
  }

  private async preparePlatformToolCall(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
    route: 'step' | 'catalog',
  ): Promise<void> {
    const routed = route === 'step'
      ? this.router.preparePlatformCall(callId, toolName)
      : this.router.prepareNestedPlatformCall(callId, toolName)
    const descriptor = routed.descriptor
    const tool = routed.definition
    const invocation = splitWorkflowStepIdentity(args)
    const preparedInvocation = await this.invocationLedger.prepare({
      runId: this.options.runId,
      turnId: this.options.turnId,
      callId,
      stepId: routed.stepId,
      objectiveRevision: routed.objectiveRevision,
      toolPlanDigest: routed.toolPlanDigest,
      descriptor,
      args: invocation.toolArgs,
      executionSurface: 'agent',
    })
    const objectiveRevision = await this.projectionPublisher.ensurePrepared({
      callId,
      toolName,
      toolLabel: tool.label,
      args: invocation.toolArgs,
      workflowStepId: invocation.workflowStepId,
      objectiveRevision: preparedInvocation.objectiveRevision,
      createConversationItem: true,
    })
    if (objectiveRevision !== preparedInvocation.objectiveRevision) {
      throw new Error(`工具调用 '${callId}' 的 transcript 与 invocation objective revision 不一致`)
    }
    this.callObjectiveRevisions.set(callId, objectiveRevision)
    this.preparedArguments.set(callId, structuredClone(invocation.toolArgs))
    this.preparedCalls.add(callId)
    this.preparedCallRoutes.set(callId, route)
  }

  async prepareExternalAgentCall(
    agentId: string,
    agentName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<void> {
    if (this.preparedCalls.has(callId)) return
    const invocation = splitWorkflowStepIdentity(args)
    const routed = this.router.prepareCall(callId, agentId)
    if (routed.descriptor.kind !== 'subagent') {
      throw new Error(`工具 '${agentId}' 的 StepContext 类型不是 subagent`)
    }
    const preparedInvocation = await this.invocationLedger.prepare({
      runId: this.options.runId,
      turnId: this.options.turnId,
      callId,
      stepId: routed.stepId,
      objectiveRevision: routed.objectiveRevision,
      toolPlanDigest: routed.toolPlanDigest,
      descriptor: routed.descriptor,
      args: invocation.toolArgs,
      executionSurface: 'agent',
    })
    const objectiveRevision = await this.projectionPublisher.ensurePrepared({
      callId,
      toolName: agentId,
      toolLabel: agentName,
      args: invocation.toolArgs,
      workflowStepId: invocation.workflowStepId,
      objectiveRevision: preparedInvocation.objectiveRevision,
      createConversationItem: false,
    })
    if (objectiveRevision !== preparedInvocation.objectiveRevision) {
      throw new Error(`工具调用 '${callId}' 的 transcript 与 invocation objective revision 不一致`)
    }
    this.callObjectiveRevisions.set(callId, objectiveRevision)
    this.preparedArguments.set(callId, structuredClone(invocation.toolArgs))
    this.preparedCalls.add(callId)
    this.preparedCallRoutes.set(callId, 'step')
  }

  async executeForModel(toolName: string, args: Record<string, unknown>, callId: string): Promise<string> {
    const result = await this.execute(toolName, args, callId)
    const tool = this.options.registry.get(toolName)
    if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
    if (tool.agentResultMode === 'return_direct') {
      if (!result.modelOutput?.trim()) {
        throw new Error(`工具 '${toolName}' 声明直接返回，但没有提供可交付文本`)
      }
      return result.modelOutput.trim()
    }
    return formatToolResultForModel(
      result,
      this.options.inlineToolResultMaxChars,
      this.options.store.getRun(this.options.runId).state.planMode,
    )
  }

  async executeDirect(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const callId = makeId('call')
    await this.prepareWithRoute(toolName, args, callId, 'catalog')
    return this.execute(toolName, args, callId, undefined, 'immediate', 'catalog')
  }

  async beginExternalAgentStep(
    agentId: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<string | null> {
    this.policy.assertExecutionPhaseAllowsExternalAgent(agentId)
    const { workflowStepId } = splitWorkflowStepIdentity(args)
    const stepId = await this.workflowBinder.claim(agentId, callId, agentId, workflowStepId)
    this.externalAgentCalls.set(callId, agentId)
    await this.invocationLedger.start(
      callId,
      await this.approvalExecutionDecision(agentId, args, callId),
    )
    return stepId
  }

  restoreExternalAgentStep(
    agentId: string,
    callId: string,
    stepId: string | null,
  ): void {
    this.workflowBinder.restoreExternalAgent(agentId, callId, stepId)
    this.externalAgentCalls.set(callId, agentId)
  }

  async completeExternalAgentStep(callId: string, summary: string): Promise<void> {
    try {
      await this.workflowBinder.complete(callId, summary)
    } finally {
      this.externalAgentCalls.delete(callId)
    }
  }

  toolOutputMetadata(callId: string): AgentToolOutputMetadata {
    return this.projectionPublisher.toolOutputMetadata(callId)
  }

  private requireCallObjectiveRevision(callId: string): number {
    const objectiveRevision = this.callObjectiveRevisions.get(callId)
    if (objectiveRevision === undefined) {
      throw new Error(`工具调用 '${callId}' 缺少 objective revision 绑定`)
    }
    return objectiveRevision
  }

  private requirePreparedArguments(callId: string): Record<string, unknown> {
    const args = this.preparedArguments.get(callId)
    if (!args) {
      throw new Error(`工具调用 '${callId}' 缺少本次 StepContext 的 canonical 参数绑定`)
    }
    return structuredClone(args)
  }

  private async approvalRequirement(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<ApprovalRequirement> {
    return this.approvals.requirement(await this.approvalCallInput(toolName, args, callId))
  }

  private async prepareSdkExtensionCall(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<void> {
    const routed = this.router.prepareCall(callId, toolName)
    await this.invocationLedger.prepare({
      runId: this.options.runId,
      turnId: this.options.turnId,
      callId,
      stepId: routed.stepId,
      objectiveRevision: routed.objectiveRevision,
      toolPlanDigest: routed.toolPlanDigest,
      descriptor: routed.descriptor,
      args,
      executionSurface: 'agent',
    })
    this.preparedArguments.set(callId, structuredClone(args))
  }

  private async approvalExecutionDecision(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<ApprovalExecutionDecision> {
    return this.approvals.executionDecision(await this.approvalCallInput(toolName, args, callId))
  }

  private async approvalCallInput(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<ApprovalCallInput> {
    const routed = this.router.requireCall(callId, toolName)
    const invocation = await this.options.store.getToolInvocation(this.options.runId, callId)
    if (!invocation) throw new Error(`工具调用 '${callId}' 尚未进入持久账本`)
    if (invocation.stepId !== routed.stepId) {
      throw new Error(`工具调用 '${callId}' 的 invocation 与 StepContext 不一致`)
    }
    const { toolArgs } = splitWorkflowStepIdentity(args)
    return {
      context: routed.context,
      descriptor: routed.descriptor,
      args: toolArgs,
      invocationId: invocation.invocationId,
      callId,
      stepId: routed.stepId,
    }
  }

  async failExternalAgentStep(callId: string, message: string): Promise<void> {
    try {
      await this.workflowBinder.fail(callId, message)
    } finally {
      this.externalAgentCalls.delete(callId)
    }
  }

  async executeForSubAgent(
    agentId: string,
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<string> {
    // 子 Agent 内层工具不会进入父 RunState；其整个 Agent-as-tool
    // 外层 callId 已保持 pending，直到父 SDK checkpoint 包含外层 result。
    // 因此内层终态可立即收敛，崩溃时仍由外层 pending 禁止自动重放。
    const result = await this.execute(toolName, args, callId, agentId, 'immediate', 'catalog')
    const tool = this.options.registry.get(toolName)
    if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
    if (tool.agentResultMode === 'return_direct') {
      if (!result.modelOutput?.trim()) {
        throw new Error(`工具 '${toolName}' 声明直接返回，但没有提供可交付文本`)
      }
      return result.modelOutput.trim()
    }
    return formatToolResultForModel(
      result,
      this.options.inlineToolResultMaxChars,
      this.options.store.getRun(this.options.runId).state.planMode,
    )
  }

  private async execute(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
    ownerAgentId?: string,
    recoveryTerminal: 'checkpoint' | 'immediate' = 'checkpoint',
    route: 'step' | 'catalog' = 'step',
  ): Promise<ToolResult> {
    this.options.signal.throwIfAborted()
    await this.prepareWithRoute(toolName, args, callId, route)
    this.router.requirePlatformCall(callId, toolName)
    const objectiveRevision = this.requireCallObjectiveRevision(callId)
    const invocation = splitWorkflowStepIdentity(args)
    const toolLabel = this.toolLabel(toolName)
    let result: ToolResult
    let controlsApplied = false
    let existingArtifactIds: ReadonlySet<string> = new Set()
    try {
      this.policy.assertPlanModeAllows(toolName)
      if (ownerAgentId) this.policy.assertExternalAgentIsRunning(ownerAgentId)
      else await this.workflowBinder.claim(toolName, callId, undefined, invocation.workflowStepId)
      await this.invocationLedger.start(
        callId,
        await this.approvalExecutionDecision(toolName, args, callId),
      )
      await this.projectionPublisher.publishStarted(callId, toolName, toolLabel, objectiveRevision)
      existingArtifactIds = new Set(
        this.options.store.getRun(this.options.runId).state.artifacts.map(artifact => artifact.artifactId),
      )
      result = await this.options.registry.execute(toolName, invocation.toolArgs, this.createToolContext(callId))
      const commit = await this.effectCommitter.commit({
        runId: this.options.runId,
        callId,
        toolName,
        toolLabel,
        args: invocation.toolArgs,
        result,
        objectiveRevision,
        checkpointImmediately: recoveryTerminal === 'immediate',
      })
      controlsApplied = commit.controlsApplied
    } catch (error) {
      const message = errorMessage(error)
      const settlementErrors: string[] = []
      try {
        await this.workflowBinder.fail(callId, message)
      } catch (settlementError) {
        settlementErrors.push(errorMessage(settlementError))
      }
      try {
        const invocationRecord = await this.options.store.getToolInvocation(this.options.runId, callId)
        if (invocationRecord?.terminalOutcome === null) {
          if (invocationRecord.status === 'prepared') {
            await this.invocationLedger.reject(
              callId,
              message,
              recoveryTerminal === 'immediate',
            )
          } else if (invocationRecord.status === 'running') {
            await this.invocationLedger.fail(
              callId,
              message,
              recoveryTerminal === 'immediate',
            )
          }
        }
      } catch (settlementError) {
        settlementErrors.push(errorMessage(settlementError))
      }
      try {
        await this.projectionPublisher.publishFailed({
          callId,
          toolName,
          toolLabel,
          message,
          objectiveRevision,
        })
      } catch (settlementError) {
        settlementErrors.push(errorMessage(settlementError))
      }
      if (settlementErrors.length) {
        try {
          await this.options.store.mutateRunState(this.options.runId, state => ({
            warnings: [...state.warnings, `工具失败收敛不完整：${settlementErrors.join('；')}`],
          }))
        } catch {
          // 原始工具错误是调用者需要处理的主因，不用投影失败覆盖。
        }
      }
      throw error
    }

    const postCommitErrors: string[] = []
    try {
      await this.workflowBinder.complete(callId, result.message)
    } catch (error) {
      postCommitErrors.push(errorMessage(error))
    }
    try {
      await this.projectionPublisher.publishSucceeded({
        callId,
        toolName,
        toolLabel,
        result,
        objectiveRevision,
        controlsApplied,
        existingArtifactIds,
      })
    } catch (error) {
      postCommitErrors.push(errorMessage(error))
    }
    for (const message of postCommitErrors) {
      try {
        await this.projectionPublisher.recordPostCommitWarning(toolName, message)
      } catch {
        // 调用结果与副作用已是权威事实；不得因可重建投影再失败而重放工具。
      }
    }
    return result
  }

  async executeForHandoff(
    agentId: string,
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<string> {
    if (this.policy.activeHandoffAgent() !== agentId) {
      throw new Error(`子智能体 '${agentId}' 尚未取得 handoff 所有权`)
    }
    const result = await this.execute(toolName, args, callId, undefined, 'checkpoint', 'catalog')
    const tool = this.options.registry.get(toolName)
    if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
    if (tool.agentResultMode === 'return_direct') {
      if (!result.modelOutput?.trim()) {
        throw new Error(`工具 '${toolName}' 声明直接返回，但没有提供可交付文本`)
      }
      return result.modelOutput.trim()
    }
    return formatToolResultForModel(
      result,
      this.options.inlineToolResultMaxChars,
      false,
    )
  }

  private toolLabel(toolName: string): string {
    const tool = this.options.registry.get(toolName)
    if (!tool) throw new Error(`工具 '${toolName}' 未注册`)
    return tool.label
  }

  private createToolContext(toolCallId: string): ToolContext {
    const run = this.options.store.getRun(this.options.runId)
    return {
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      threadId: this.options.threadId,
      turnId: this.options.turnId,
      rootTurnId: run.rootTurnId ?? this.options.turnId,
      toolCallId,
      signal: this.options.signal,
      runtimeRoot: this.options.store.runtimeRoot,
      ...(this.options.runtimeConfig ? { runtimeConfig: this.options.runtimeConfig } : {}),
      auth: this.options.auth ?? null,
      state: this.options.valueState,
      resolveValueRef: refId => resolveRuntimeValueRef(this.options.valueState, refId),
      listMeteorologicalDatasets: input => this.options.store.meteorology.listMeteorologicalDatasets({
        sessionId: this.options.sessionId,
        threadId: input?.scope === 'thread' ? this.options.threadId : null,
        workspaceId: run.workspaceId,
        filename: input?.filename ?? null,
        ...(input?.limit === undefined ? {} : { limit: input.limit }),
      }),
      resolveMeteorologicalDataset: input => this.options.store.meteorology.resolveMeteorologicalDataset({
        sessionId: this.options.sessionId,
        threadId: input.selector === 'current_thread_latest' ? this.options.threadId : null,
        workspaceId: run.workspaceId,
        datasetId: input.selector === 'explicit_dataset_id' ? input.datasetId : 'latest_upload',
        filename: input.selector === 'current_thread_latest' ? input.filename ?? null : null,
      }),
      resolveMeteorologicalDatasets: datasetIds => this.options.store.meteorology.listMeteorologicalDatasets({
        datasetIds,
        workspaceId: run.workspaceId,
        sessionId: run.workspaceId ? null : this.options.sessionId,
        limit: Math.max(1, datasetIds.length),
      }),
      invokeStructuredModel: async (prompt, schema, options) => {
        if (!this.options.adapter) throw new Error('当前确定性工具链未配置结构化模型调用')
        if (this.options.modelCompletions && this.options.workspaceId) {
          const response = await this.options.modelCompletions.completeStructured({
            workspaceId: this.options.workspaceId,
            runId: this.options.runId,
            provider: this.options.adapter.provider,
            ...(this.options.modelName === undefined ? {} : { model: this.options.modelName }),
            purpose: 'tool_structured_analysis',
            prompt,
            ...(options?.schemaVersion ? { schemaVersion: options.schemaVersion } : {}),
            signal: this.options.signal,
          }, schema)
          await recordModelCompletionUsage(this.options.store, this.options.runId, response)
          return response.content
        }
        const modelName = this.options.modelName ?? this.options.adapter.defaultModel
        if (!modelName) throw new Error(`模型 provider '${this.options.adapter.provider}' 未配置模型名称`)
        return (await runSdkStructuredOutput(
          this.options.adapter,
          modelName,
          prompt,
          schema,
          this.options.signal,
        )).content
      },
      log: (level, message) => this.options.eventSink.emit('tool.completed', message, { level }),
    }
  }

}

const EMPTY_RUNTIME_HOOKS = new RuntimeHookRegistry([]).bind([])

const AGENT_WORKFLOW_DEFINITION_TOOLS = new Set([
  'submit_agent_workflow',
  'revise_agent_workflow',
])

export function validateAgentWorkflowDraft(
  args: Record<string, unknown>,
  registry: ToolRegistry,
  subAgents: ReadonlyArray<{
    agentId: string
    tools?: string[]
    delegationMode?: 'as_tool' | 'handoff'
  }>,
): string | null {
  const workflow = isRecord(args.workflow) ? args.workflow : null
  const rawSteps = workflow && Array.isArray(workflow.steps) ? workflow.steps : []
  if (!rawSteps.length) return '工作流计划无效：至少需要一个可执行步骤。请依据执行能力目录修正后重新提交。'

  const steps = rawSteps.map((value, index) => ({ value: isRecord(value) ? value : null, index }))
  const stepIds = new Set<string>()
  const dependencies = new Map<string, string[]>()
  const subAgentConfigs = new Map(subAgents.map(agent => [agent.agentId, agent]))

  for (const { value: step, index } of steps) {
    if (!step) return `工作流计划无效：第 ${index + 1} 个步骤不是 JSON object。`
    const stepId = typeof step.stepId === 'string' ? step.stepId.trim() : ''
    const title = typeof step.title === 'string' && step.title.trim() ? step.title.trim() : `第 ${index + 1} 个步骤`
    const kind = typeof step.kind === 'string' ? step.kind : ''
    const toolName = typeof step.toolName === 'string' ? step.toolName.trim() : ''
    const ownerAgentId = typeof step.ownerAgentId === 'string' ? step.ownerAgentId.trim() : ''
    if (!stepId) return `工作流计划无效：步骤“${title}”缺少 stepId。`
    if (stepIds.has(stepId)) return `工作流计划无效：stepId '${stepId}' 重复。`
    stepIds.add(stepId)

    if (kind === 'agent') {
      const subAgent = subAgentConfigs.get(toolName)
      if (!subAgent) {
        return `工作流计划无效：步骤“${title}”引用了未配置的子智能体 '${toolName}'。只能使用执行能力目录中的确切 agentId。`
      }
      if (subAgent.delegationMode === 'handoff') {
        return `工作流计划无效：Handoff 子智能体 '${toolName}' 会直接接管最终对话，不能作为需要返回 supervisor 的 workflow 步骤。`
      }
      if (ownerAgentId !== toolName) {
        return `工作流计划无效：子智能体步骤“${title}”的 ownerAgentId 必须等于 '${toolName}'。`
      }
      const invocation = subAgentInvocationSchema.safeParse(step.args)
      if (!invocation.success) {
        return `工作流计划无效：子智能体步骤“${title}”的 args 不符合结构化委托契约。`
      }
      const allowedTools = new Set(subAgent.tools ?? [])
      const invocationText = [
        invocation.data.objective,
        ...invocation.data.expectedDeliverables,
        ...invocation.data.contextRefs,
        ...invocation.data.constraints,
      ].join('\n')
      const mentionedTools = new Set(invocationText.match(/[A-Za-z][A-Za-z0-9_-]*/gu) ?? [])
      const unauthorized = registry.list()
        .map(definition => definition.name)
        .find(name => mentionedTools.has(name) && !allowedTools.has(name))
      if (unauthorized) {
        return `工作流计划无效：子智能体 '${toolName}' 的任务显式要求未授权工具 '${unauthorized}'。请改由 supervisor 执行，或调整为该子智能体目录中的授权工具。`
      }
    } else {
      const definition = registry.get(toolName)
      if (!definition || !(definition.executionSurfaces?.includes('agent') ?? true)) {
        return `工作流计划无效：步骤“${title}”引用了未注册的 Agent 工具 '${toolName}'。只能使用执行能力目录中的确切 toolName。`
      }
      if (AGENT_WORKFLOW_CONTROL_TOOLS.has(toolName)) {
        return `工作流计划无效：计划控制工具 '${toolName}' 不能作为业务执行步骤。`
      }
      if (ownerAgentId !== 'supervisor') {
        return `工作流计划无效：主智能体步骤“${title}”的 ownerAgentId 必须为 supervisor。`
      }
      if (kind === 'automation' && toolName !== 'execute_automation') {
        return `工作流计划无效：Automation 步骤“${title}”必须使用 execute_automation。`
      }
      if (kind !== 'automation' && toolName === 'execute_automation') {
        return `工作流计划无效：execute_automation 步骤“${title}”的 kind 必须为 automation。`
      }
      const stepArgs = isRecord(step.args) ? step.args : null
      if (!stepArgs) return `工作流计划无效：步骤“${title}”的 args 必须是 JSON object。`
      const argumentError = registry.validatePlannedArguments(toolName, stepArgs)
      if (argumentError) {
        return `工作流计划无效：步骤“${title}”的预计参数不符合 '${toolName}' 契约：${argumentError}。依赖前序结果的动态参数应从 args 省略，不得填写占位值。`
      }
    }

    const dependsOn = Array.isArray(step.dependsOn)
      ? step.dependsOn.filter((value): value is string => typeof value === 'string')
      : []
    if (dependsOn.includes(stepId)) return `工作流计划无效：步骤 '${stepId}' 不能依赖自身。`
    dependencies.set(stepId, dependsOn)
  }

  for (const [stepId, dependsOn] of dependencies) {
    const unknown = dependsOn.find(dependency => !stepIds.has(dependency))
    if (unknown) return `工作流计划无效：步骤 '${stepId}' 依赖不存在的步骤 '${unknown}'。`
  }
  if (hasDependencyCycle(dependencies)) {
    return '工作流计划无效：步骤依赖形成了循环，无法确定执行顺序。'
  }
  return null
}

function hasDependencyCycle(dependencies: ReadonlyMap<string, string[]>): boolean {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (stepId: string): boolean => {
    if (visiting.has(stepId)) return true
    if (visited.has(stepId)) return false
    visiting.add(stepId)
    for (const dependency of dependencies.get(stepId) ?? []) {
      if (visit(dependency)) return true
    }
    visiting.delete(stepId)
    visited.add(stepId)
    return false
  }
  return [...dependencies.keys()].some(visit)
}

export function formatToolResultForModel(result: ToolResult, maxChars: number, planMode = false): string {
  const base = {
    message: result.message,
    valueRefs: summarizeValueRefs(result.valueRefs ?? []),
    artifacts: (result.artifacts ?? []).map(artifact => ({
      artifactId: artifact.artifactId,
      artifactType: artifact.artifactType,
      name: artifact.name,
      uri: artifact.uri,
    })),
    ...(planMode ? {
      planningContext: {
        status: 'active',
        actions: ['继续无副作用读取', 'request_clarification', 'submit_agent_workflow', '直接说明计划'],
        guidance: '结构化工作流用于后续进度投影；计划本身不会替代有副作用工具各自的审批。',
      },
    } : {}),
  }
  const full = JSON.stringify({ ...base, payload: result.payload })
  if (full.length <= maxChars) return full
  return JSON.stringify({ ...base, payloadSummary: summarizePayload(result.payload) })
}

function summarizeValueRefs(refs: ValueRef[]) {
  return refs.map(ref => ({
    refId: ref.refId,
    kind: ref.kind,
    label: ref.label,
    unit: ref.unit ?? null,
  }))
}

// 完整工具结果已经落盘到 run/transcript/artifact；模型继续推理只需要结构摘要和
// valueRef 清单。GeoJSON 的坐标通常占据绝大多数体积，但要素属性才是模型回答
// “有哪些对象”时的事实依据，因此压缩坐标、保留有界的属性行；其它大数组保留
// 长度与少量样例，避免后续工具从海量 payload 里误取 ref。
function summarizePayload(value: unknown, depth = 0): unknown {
  const featureCollection = summarizeFeatureCollection(value)
  if (featureCollection) return featureCollection
  if (depth > 3) return scalarSummary(value)
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      sample: value.slice(0, 5).map(item => summarizePayload(item, depth + 1)),
    }
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
    return Object.fromEntries(entries.map(([key, item]) => [key, summarizePayload(item, depth + 1)]))
  }
  return value
}

const MAX_GEOJSON_PROPERTY_ROWS = 100

function summarizeFeatureCollection(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) return null
  const propertyRows = value.features
    .slice(0, MAX_GEOJSON_PROPERTY_ROWS)
    .map((feature, index) => ({
      index,
      geometryType: isRecord(feature) && isRecord(feature.geometry) && typeof feature.geometry.type === 'string'
        ? feature.geometry.type
        : null,
      properties: isRecord(feature) && isRecord(feature.properties)
        ? summarizeFeatureProperties(feature.properties)
        : {},
    }))
  return {
    type: 'FeatureCollection',
    featureCount: value.features.length,
    propertyRows,
    propertyRowsComplete: value.features.length <= MAX_GEOJSON_PROPERTY_ROWS,
  }
}

function summarizeFeatureProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return [key, value]
    return [key, scalarSummary(value)]
  }))
}

function scalarSummary(value: unknown): unknown {
  if (Array.isArray(value)) return { type: 'array', length: value.length }
  if (isRecord(value)) return { type: 'object', keys: Object.keys(value).slice(0, 12) }
  return value
}

function splitWorkflowStepIdentity(args: Record<string, unknown>): {
  workflowStepId: string | null
  toolArgs: Record<string, unknown>
} {
  const raw = args.workflowStepId
  if (raw !== undefined && raw !== null && (typeof raw !== 'string' || !raw.trim())) {
    throw new Error('workflowStepId 必须是非空字符串或 null。')
  }
  const toolArgs = { ...args }
  delete toolArgs.workflowStepId
  return {
    workflowStepId: typeof raw === 'string' ? raw.trim() : null,
    toolArgs,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

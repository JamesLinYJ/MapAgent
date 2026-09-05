// +-------------------------------------------------------------------------
//
//   地理智能平台 - Handoff 子智能体装配
//
//   文件:       handoffAgentFactory.ts
//
//   日期:       2026年07月21日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  Agent,
  handoff,
  type Handoff,
  type Model,
} from '@openai/agents'
import {
  subAgentInvocationSchema,
  type RuntimeSubAgentConfig,
} from '@geo-agent-platform/shared-types/runtime'

import { createAgentsTools, type AgentsExecutionContext, type AgentsToolExecutionScope } from './agentsToolBridge.js'
import { modelSettings } from './runtimeSdkProjection.js'
import {
  resolveSubAgentModel,
  resolveSubAgentModelCapabilities,
  SubAgentStateController,
  type SubAgentRuntimeDependencies,
} from './subAgentRuntimeSupport.js'

const AGENT_NAME = /^[a-zA-Z0-9_-]+$/u

export interface HandoffAgentIntegration {
  handoffs: Handoff<AgentsExecutionContext, 'text'>[]
  agentIds: ReadonlySet<string>
  toolAgentIds: ReadonlyMap<string, string>
  complete(agentId: string, summary: string): Promise<void>
  fail(agentId: string, message: string): Promise<void>
}

interface HandoffAgentFactoryOptions extends SubAgentRuntimeDependencies {
  configs: RuntimeSubAgentConfig[]
  stateController: SubAgentStateController
  prepareModel(model: Model): Model
}

export function createHandoffAgents(options: HandoffAgentFactoryOptions): HandoffAgentIntegration {
  const configs = options.configs.filter(config => config.delegationMode === 'handoff')
  const byAgentId = new Map(configs.map(config => [config.agentId, config]))
  const handoffs = configs.map(config => {
    if (!AGENT_NAME.test(config.agentId)) throw new Error(`Handoff Agent id '${config.agentId}' 不是合法工具名`)
    const toolName = `handoff_to_${config.agentId}`
    if (options.toolRegistry.get(toolName)) throw new Error(`Handoff 工具名 '${toolName}' 与现有工具重名`)
    const modelCapabilities = resolveSubAgentModelCapabilities(config, options)
    if (config.tools.length && !modelCapabilities.capabilities.toolCalls) {
      throw new Error(`Handoff 模型 '${modelCapabilities.modelId}' 不支持工具调用`)
    }
    const executionScope: AgentsToolExecutionScope = {
      isToolEnabled: name => options.coordinator.isToolEnabledForHandoff(config.agentId, name),
      validateToolCall: (name, args) => options.coordinator.validateToolCall(name, args),
      formatToolFailureForModel: (name, message) => options.coordinator.formatToolFailureForModel(name, message),
      rejectPreparedToolCall: (name, callId, message) => options.coordinator.rejectPreparedToolCall(name, callId, message),
      canonicalizeToolCall: (name, args, callId) => options.coordinator.canonicalizeCatalogToolCall(name, args, callId),
      prepareToolCall: (name, args, callId) => options.coordinator.prepareCatalogTool(
        name,
        args,
        callId,
      ),
      requiresApproval: (name, args, callId) => options.coordinator.requiresCatalogApproval(
        name,
        args,
        callId,
      ),
      requiresSdkExtensionApproval: (name, args, callId) => options.coordinator.requiresSdkExtensionApproval(
        name,
        args,
        callId,
      ),
      executeTool: (name, args, callId) => options.coordinator.executeForHandoff(
        config.agentId,
        name,
        args,
        callId,
      ),
      runToolExecution: (lane, operation) => options.executionGate.run(lane, operation),
      toolOutputMetadata: callId => options.coordinator.toolOutputMetadata(callId),
    }
    const agent = new Agent<AgentsExecutionContext>({
      name: config.agentId,
      instructions: async () => {
        await options.subAgentControls.touch(
          options.runId,
          config.agentId,
          'Handoff 子智能体正在准备模型调用',
        )
        return [
          config.systemPrompt ?? config.summary,
          ...await options.subAgentControls.consumeInstructions(options.runId, config.agentId),
          '你已经通过 handoff 接管当前对话。请完成任务并直接返回可展示给用户的中文 Markdown 正文；不要再把任务退回给主智能体。',
          'Artifact、警告和运行证据由平台根据真实工具账本附加，不要在正文中伪造 ID 或结构化包装。',
        ].join('\n\n')
      },
      handoffDescription: config.summary,
      // Handoff 与父 Agent 共用同一个 Runner 段，因此它的每次 provider
      // 请求也必须进入父运行的 StepContext、ModelRequest 与 checkpoint 绑定。
      model: options.prepareModel(resolveSubAgentModel(config, options)),
      modelSettings: modelSettings(
        options.reasoning,
        modelCapabilities.capabilities.reasoning,
      ),
      tools: createAgentsTools(options.toolRegistry, options.approvalTools, {
        schemaMode: options.adapter.agentToolSchemaMode,
        allowedToolNames: new Set(config.tools),
        executionScope,
      }),
    })
    return handoff(agent, {
      toolNameOverride: toolName,
      toolDescriptionOverride: `把当前对话处理权转交给 ${config.name}。${config.summary}`,
      inputType: subAgentInvocationSchema,
      isEnabled: () => options.coordinator.isHandoffEnabled(config.agentId),
      onHandoff: async (_context, input) => {
        subAgentInvocationSchema.parse(input)
        await options.stateController.startHandoff(config)
      },
    })
  })

  return {
    handoffs,
    agentIds: new Set(configs.map(config => config.agentId)),
    toolAgentIds: new Map(configs.map(config => [`handoff_to_${config.agentId}`, config.agentId])),
    async complete(agentId, summary) {
      const config = byAgentId.get(agentId)
      if (!config) return
      await options.stateController.completeHandoff(config, summary)
    },
    async fail(agentId, message) {
      const config = byAgentId.get(agentId)
      if (!config) return
      await options.stateController.failHandoff(config, message)
    },
  }
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 子智能体工具装配
//
//   文件:       subAgentToolFactory.ts
//
//   日期:       2026年07月17日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  invokeFunctionTool,
  type FunctionToolCustomDataContext,
  type Tool,
} from '@openai/agents'
import {
  agentToolOutputMetadataSchema,
  subAgentInvocationSchema,
} from '@geo-agent-platform/shared-types/runtime'

import type { AgentRuntimeConfig } from '../schemas/types.js'
import type { AgentsExecutionContext } from './agentsToolBridge.js'
import { serializeAgentEvent } from './runtimeSdkProjection.js'
import {
  assertSubAgentDeliveryArtifacts,
  createSubAgentDeliveryAgent,
  createSubAgentExecutionContext,
  formatSubAgentInput,
  parseSubAgentDelivery,
  subAgentErrorHandlers,
  subAgentFailureMessage,
  SubAgentStateController,
  type SubAgentRuntimeDependencies,
} from './subAgentRuntimeSupport.js'
import { platformToolDescriptorSource } from '../agent-runtime/tools/ToolCatalog.js'

const AGENT_TOOL_NAME = /^[a-zA-Z0-9_-]+$/u

interface SubAgentToolFactoryOptions extends SubAgentRuntimeDependencies {
  configs: AgentRuntimeConfig['subAgents']
  stateController?: SubAgentStateController
}

// 子智能体继续使用 Agents SDK 原生 Agent-as-tool，但执行前后必须进入同一份
// 智能体工作流状态机，避免“子智能体已完成、工作流步骤仍在等待”的双事实源。
export async function createSubAgentTools(
  options: SubAgentToolFactoryOptions,
): Promise<Tool<AgentsExecutionContext>[]> {
  const stateController = options.stateController ?? new SubAgentStateController(options)
  if (!options.stateController) await stateController.initialize(options.configs)

  return options.configs.filter(config => config.delegationMode === 'as_tool').map(config => {
    if (!AGENT_TOOL_NAME.test(config.agentId)) throw new Error(`子 Agent id '${config.agentId}' 不能作为工具名`)
    if (options.toolRegistry.get(config.agentId)) throw new Error(`子 Agent id '${config.agentId}' 与现有工具重名`)
    assertParallelSafeConfiguration(config, options)
    const subAgent = createSubAgentDeliveryAgent(config, options)
    const subAgentExecutionContext = createSubAgentExecutionContext(config, options)
    const agentTool = subAgent.asTool({
      toolName: config.agentId,
      toolDescription: config.summary,
      parameters: subAgentInvocationSchema,
      includeInputSchema: true,
      inputBuilder: ({ params }) => formatSubAgentInput(params),
      needsApproval: async (_runContext, input, callId) => {
        if (!callId) throw new Error(`子 Agent '${config.agentId}' 缺少 callId`)
        const invocation = subAgentInvocationSchema.parse(input)
        await options.coordinator.prepareExternalAgentCall(
          config.agentId,
          config.name,
          invocation,
          callId,
        )
        return options.coordinator.requiresExternalAgentApproval(
          config.agentId,
          invocation,
          callId,
        )
      },
      isEnabled: () => options.coordinator.isExternalAgentEnabled(config.agentId),
      runOptions: {
        context: subAgentExecutionContext,
        maxTurns: config.maxTurns,
        errorHandlers: subAgentErrorHandlers(config),
      },
      customOutputExtractor: async output => {
        for (const item of output.newItems) {
          await options.store.appendAgentTranscript(options.runId, config.agentId, {
            type: 'completed_item',
            item: item.toJSON(),
          })
        }
        if (output.interruptions.length) return ''
        return JSON.stringify(output.finalOutput)
      },
      onStream: async ({ event }) => {
        await options.store.appendAgentTranscript(options.runId, config.agentId, serializeAgentEvent(event))
        await stateController.activity(config, subAgentActivityLabel(event.type))
      },
    })
    const invoke = agentTool.invoke.bind(agentTool)
    const timedAgentTool = {
      ...agentTool,
      timeoutMs: config.timeoutMs,
      timeoutBehavior: 'raise_exception' as const,
      invoke,
    }
    // 必须保留 Agent.asTool() 返回对象的身份。SDK 用 WeakMap 把该工具关联到
    // 源 Agent，RunState 恢复会沿此关联重建嵌套 Agent 图；复制对象会破坏恢复。
    return Object.assign(agentTool, {
      customDataExtractor: ({ toolCall, output }: FunctionToolCustomDataContext<AgentsExecutionContext>) => {
        if (output === '') {
          return agentToolOutputMetadataSchema.parse({
            schemaVersion: 1,
            callId: toolCall.callId,
            toolName: config.agentId,
            resultId: null,
            valueRefIds: [],
            artifactIds: [],
            display: {
              label: config.name,
              summary: '子智能体等待审批',
              source: 'openai_agents_agent_as_tool',
            },
          })
        }
        const delivery = parseSubAgentToolPresentation(config.agentId, output)
        return agentToolOutputMetadataSchema.parse({
          schemaVersion: 1,
          callId: toolCall.callId,
          toolName: config.agentId,
          resultId: null,
          valueRefIds: [],
          artifactIds: delivery.artifactIds,
          display: {
            label: config.name,
            summary: delivery.summary,
            source: 'openai_agents_agent_as_tool',
          },
        })
      },
      // 用 SDK 公开的 invokeFunctionTool 在工作流状态包装器内部执行超时。
      // 这样超时会先把子智能体和步骤落为 failed，再作为硬失败返回父运行。
      invoke: async (
        runContext: Parameters<typeof agentTool.invoke>[0],
        input: Parameters<typeof agentTool.invoke>[1],
        details: Parameters<typeof agentTool.invoke>[2],
      ) => {
        const callId = details?.toolCall?.callId
        if (!callId) throw new Error(`子 Agent '${config.agentId}' 缺少 callId`)
        const invocation = parseSubAgentInvocation(config.agentId, input)
        const isolatedSignal = options.subAgentControls.begin({
          runId: options.runId,
          agentId: config.agentId,
          callId,
          delegationMode: 'as_tool',
          timeoutMs: config.timeoutMs,
        })
        let terminalClaimed = false
        try {
          return await options.executionGate.run(
            config.parallelSafe ? 'shared' : 'exclusive',
            async () => {
              const workflowStepId = details.resumeState
                ? await stateController.resume(config, callId)
                : await stateController.start(config, invocation, callId)
              try {
                const invocationDetails = isolatedSignal
                  ? {
                      ...details,
                      signal: details.signal
                        ? AbortSignal.any([details.signal, isolatedSignal])
                        : isolatedSignal,
                    }
                  : details
                const output = await invokeFunctionTool({
                  tool: timedAgentTool,
                  runContext,
                  input,
                  details: invocationDetails,
                })
                if (options.subAgentControls.isCancellationRequested(options.runId, config.agentId, callId)) {
                  const outcome = options.subAgentControls.claimTerminalOutcome(
                    options.runId,
                    config.agentId,
                    callId,
                  )
                  terminalClaimed = true
                  if (outcome.status !== 'cancelled') throw new Error('子智能体取消终态不一致。')
                  await stateController.cancel(config, callId, workflowStepId, outcome.reason)
                  return cancelledSubAgentToolOutput(outcome.reason)
                }
                if (output === '') return output
                if (typeof output !== 'string') {
                  throw new Error(`子 Agent '${config.agentId}' 返回了非文本工具结果`)
                }
                const delivery = parseSubAgentDelivery(config.agentId, output)
                assertSubAgentDeliveryArtifacts(delivery, options)
                const outcome = options.subAgentControls.claimTerminalOutcome(
                  options.runId,
                  config.agentId,
                  callId,
                )
                terminalClaimed = true
                if (outcome.status === 'cancelled') {
                  await stateController.cancel(config, callId, workflowStepId, outcome.reason)
                  return cancelledSubAgentToolOutput(outcome.reason)
                }
                await stateController.complete(config, callId, workflowStepId, delivery)
                return JSON.stringify(delivery)
              } catch (error) {
                if (terminalClaimed) throw error
                const outcome = options.subAgentControls.claimTerminalOutcome(
                  options.runId,
                  config.agentId,
                  callId,
                )
                terminalClaimed = true
                if (outcome.status === 'cancelled') {
                  await stateController.cancel(config, callId, workflowStepId, outcome.reason)
                  return cancelledSubAgentToolOutput(outcome.reason)
                }
                const message = subAgentFailureMessage(error, config)
                await stateController.fail(config, callId, workflowStepId, message)
                throw new Error(message, { cause: error })
              }
            },
          )
        } finally {
          options.subAgentControls.finish(options.runId, config.agentId, callId)
        }
      },
    })
  })
}

function cancelledSubAgentToolOutput(message: string): string {
  return JSON.stringify({
    status: 'cancelled',
    summary: message,
    evidence: [],
    artifactIds: [],
    warnings: [message],
    error: null,
  })
}

function parseSubAgentToolPresentation(
  agentId: string,
  output: unknown,
): { summary: string; artifactIds: string[] } {
  if (typeof output === 'string') {
    try {
      const parsed: unknown = JSON.parse(output)
      if (
        typeof parsed === 'object'
        && parsed !== null
        && 'status' in parsed
        && parsed.status === 'cancelled'
        && 'summary' in parsed
        && typeof parsed.summary === 'string'
        && 'artifactIds' in parsed
        && Array.isArray(parsed.artifactIds)
        && parsed.artifactIds.every(value => typeof value === 'string')
      ) {
        return { summary: parsed.summary, artifactIds: parsed.artifactIds }
      }
    } catch {
      // 继续使用正式 delivery 解析器生成稳定错误。
    }
  }
  return parseSubAgentDelivery(agentId, output)
}

function subAgentActivityLabel(eventType: string): string {
  if (eventType === 'agent_updated_stream_event') return '子智能体已切换执行阶段'
  if (eventType === 'run_item_stream_event') return '子智能体产生了新的运行项'
  return '子智能体模型正在响应'
}

function assertParallelSafeConfiguration(
  config: AgentRuntimeConfig['subAgents'][number],
  options: SubAgentToolFactoryOptions,
): void {
  if (!config.parallelSafe) return
  for (const toolName of config.tools) {
    const definition = options.toolRegistry.get(toolName)
    if (!definition) throw new Error(`并发安全子 Agent '${config.agentId}' 引用了未知工具 '${toolName}'`)
    const approvalRequired = options.approvalTools.has(toolName)
    if (approvalRequired || platformToolDescriptorSource(definition).parallelism !== 'shared') {
      throw new Error(
        `子 Agent '${config.agentId}' 只有在全部工具都显式 parallelSafe、只读、无破坏且免审批时才能共享并发；'${toolName}' 不符合。`,
      )
    }
  }
}

function parseSubAgentInvocation(agentId: string, input: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    throw new Error(`子 Agent '${agentId}' 调用参数不是有效 JSON`)
  }
  const result = subAgentInvocationSchema.safeParse(parsed)
  if (!result.success) throw new Error(`子 Agent '${agentId}' 调用参数不符合 input 契约`)
  return result.data
}

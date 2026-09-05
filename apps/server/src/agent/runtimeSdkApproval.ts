// +-------------------------------------------------------------------------
//
//   地理智能平台 - SDK 扩展审批适配器
//
//   文件:       runtimeSdkApproval.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { RunContext, Tool } from '@openai/agents'

import type { AgentsExecutionContext } from './agentsToolBridge.js'

/**
 * MCP 与 Sandbox function tool 只在 SDK 公共 needsApproval 边界接入平台。
 * 是否允许、是否中断和 exact/session 复用全部由 StepContext 对应的中央服务决定。
 */
export function applySdkExtensionApprovalPolicy<TContext>(
  tool: Tool<TContext>,
): Tool<TContext> {
  if (tool.type !== 'function') return tool
  return {
    ...tool,
    needsApproval: async (
      runContext: RunContext<unknown>,
      input: unknown,
      callId?: string,
    ) => {
      if (!callId) throw new Error(`SDK 扩展工具 '${tool.name}' 缺少 callId`)
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error(`SDK 扩展工具 '${tool.name}' 参数必须为 JSON object`)
      }
      const context = requireApprovalContext(runContext.context)
      return context.requiresSdkExtensionApproval(
        tool.name,
        input as Record<string, unknown>,
        callId,
      )
    },
  }
}

type SdkApprovalContext = Pick<AgentsExecutionContext, 'requiresSdkExtensionApproval'>

function requireApprovalContext(context: unknown): SdkApprovalContext {
  if (!isApprovalContext(context)) {
    throw new Error('SDK 扩展工具缺少平台审批上下文')
  }
  return context
}

function isApprovalContext(context: unknown): context is SdkApprovalContext {
  return Boolean(
    context
    && typeof context === 'object'
    && typeof Reflect.get(context, 'requiresSdkExtensionApproval') === 'function',
  )
}

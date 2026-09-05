// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型 Provider 能力判定
//
//   文件:       providerCapabilities.ts
//
//   日期:       2026年06月25日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-07-31):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: Provider 能力摘要按 Responses 原生工具能力展示，不再使用英文 Hosted Tools 占位。
// --------------------------------------------------------------------------

import type { ModelProviderDescriptor } from '@geo-agent-platform/shared-types'

// Provider 描述来自系统状态接口，是前端判断可选模型的事实源。
//
// 这里只做显式能力解释：未配置的 provider 不可选；缺少能力标签时不猜测。
export function supportsAgentSdkLiveSupervisor(provider?: ModelProviderDescriptor | null): boolean {
  if (!provider?.configured) return false
  return provider.capabilities.includes('agents_sdk_live_supervisor')
}

export function providerUnavailableLabel(provider?: ModelProviderDescriptor | null): string {
  if (!provider) return '（不可用）'
  if (!provider.configured) return '（未配置）'
  if (!supportsAgentSdkLiveSupervisor(provider)) return '（未接入智能分析）'
  return ''
}

export function modelRouteUnavailableReason(
  provider: ModelProviderDescriptor | null | undefined,
  model: string,
): string | null {
  if (!provider) return '尚未选择模型服务'
  if (!provider.configured) return `${provider.displayName} 尚未配置`
  if (!supportsAgentSdkLiveSupervisor(provider)) return `${provider.displayName} 尚未接入智能分析`

  const normalizedModel = model.trim()
  if (!normalizedModel) return '尚未选择可用模型'
  const availableModels = new Set([
    provider.defaultModel,
    ...provider.availableModels,
  ].filter((candidate): candidate is string => Boolean(candidate?.trim())))
  if (!availableModels.has(normalizedModel)) return `模型 ${normalizedModel} 当前不可用`
  return null
}

export function agentRuntimeCapabilitySummary(
  provider?: ModelProviderDescriptor | null,
): string {
  if (!provider) return '尚未选择模型服务。'
  if (!provider.configured) return '该模型服务尚未配置。'
  const runtime = provider.agentRuntime
  if (runtime.transport === 'none') return '该模型服务当前未接入智能分析。'
  if (!supportsAgentSdkLiveSupervisor(provider)) {
    return '配置已保存；默认模型未声明工具调用和结构化输出。'
  }

  const multiTool = runtime.multiToolResponse ? '支持同轮多工具响应' : '不支持同轮多工具响应'
  const concurrency = runtime.providerParallelToolControl
    ? '提供商可控制并行'
    : '由平台本地安全闸门控制并发'
  const hostedTools = runtime.hostedTools ? '支持服务端联网搜索' : null
  const unavailable = [
    !runtime.hostedTools ? '服务端工具' : null,
    !runtime.remoteConversation ? '服务端连续会话' : null,
    !runtime.serverCompaction ? '服务端上下文压缩' : null,
  ].filter((item): item is string => Boolean(item))

  return [
    transportLabel(runtime.transport),
    multiTool,
    concurrency,
    hostedTools,
    unavailable.length ? `${unavailable.join('、')}不可用` : null,
  ].filter((item): item is string => Boolean(item)).join(' · ')
}

function transportLabel(transport: ModelProviderDescriptor['agentRuntime']['transport']): string {
  if (transport === 'deepseek_responses') return 'DeepSeek 响应接口'
  if (transport === 'openai_responses') return '响应接口'
  if (transport === 'openai_chat_completions') return '对话补全接口'
  return '未接入智能分析'
}

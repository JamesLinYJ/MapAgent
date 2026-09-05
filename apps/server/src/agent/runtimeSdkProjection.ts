// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 投影工具
//
//   文件:       runtimeSdkProjection.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 这里集中 SDK input item、stream event、reasoning delta 和 JSON 参数解析。
// 运行时状态机只调用这些纯函数，不直接散落处理 SDK payload 细节。

import type {
AgentInputItem,
ModelSettings,
RunStreamEvent,
RunToolApprovalItem,
} from '@openai/agents';
import type { TranscriptEntry } from '../schemas/types.js';
import type { ConversationChatMessage } from './contextManager.js';

export function modelSettings(
  reasoning: boolean | undefined = true,
  supportsReasoning = true,
): ModelSettings {
  return {
    // 计划模式的安全边界由 ToolExecutionCoordinator 和终止状态校验负责。
    // `required` 会迫使模型调用无关工具，且与部分供应商的 thinking 模式冲突。
    toolChoice: 'auto',
    // 缓存统计必须看到供应商未经 SDK 补零的 usage，才能区分明确报告的
    // cached_tokens: 0 与 Chat Completions 流转换器合成的占位零值。
    preserveRawUsage: true,
    // 支持 reasoning 的 Responses 模型必须用 `none` 显式关闭；省略字段会让
    // DeepSeek 等 Provider 回到默认开启状态。不支持 reasoning 的模型则不发送该字段。
    ...(supportsReasoning
      ? { reasoning: { effort: reasoning === false ? 'none' as const : 'high' as const } }
      : {}),
    retry: {
      maxRetries: 1,
      policy: ({ providerAdvice }: { providerAdvice?: { replaySafety?: 'safe' | 'unsafe'; suggested?: boolean } }) =>
        providerAdvice?.replaySafety === 'safe' && providerAdvice.suggested === true,
    },
  }
}

export function conversationMessagesToAgentItems(
  sourceMessages: ConversationChatMessage[],
  systemPrompt: string,
): AgentInputItem[] {
  const items: AgentInputItem[] = []
  const callNames = new Map<string, string>()
  const messages = sourceMessages[0]?.role === 'system' && sourceMessages[0].content === systemPrompt
    ? sourceMessages.slice(1)
    : [...sourceMessages]
  for (const message of messages) {
    if (message.role === 'system') {
      items.push({ type: 'message', role: 'system', content: message.content ?? '' })
    } else if (message.role === 'user') {
      items.push({ type: 'message', role: 'user', content: message.content ?? '' })
    } else if (message.role === 'assistant') {
      if (message.content) {
        items.push({
          type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: message.content }],
        })
      }
      for (const call of message.tool_calls ?? []) {
        callNames.set(call.id, call.function.name)
        items.push({
          type: 'function_call', status: 'completed', callId: call.id,
          name: call.function.name, arguments: call.function.arguments,
        })
      }
    } else if (message.role === 'tool') {
      if (!message.tool_call_id) throw new Error('历史工具结果缺少 tool_call_id')
      items.push({
        type: 'function_call_result',
        status: 'completed',
        callId: message.tool_call_id,
        name: callNames.get(message.tool_call_id) ?? 'tool',
        output: message.content ?? '',
      })
    } else {
      throw new Error(`不支持的历史消息角色 '${message.role}'`)
    }
  }
  return items
}

export function combineSessionInput(
  historyItems: AgentInputItem[],
  currentItems: AgentInputItem[],
): AgentInputItem[] {
  return [...historyItems, ...currentItems]
}

export function serializeAgentEvent(event: RunStreamEvent): Record<string, unknown> {
  if (event.type === 'run_item_stream_event') {
    return { type: event.type, name: event.name, item: event.item.toJSON() }
  }
  if (event.type === 'agent_updated_stream_event') {
    return { type: event.type, agent: event.agent.name }
  }
  return { type: event.type, data: event.data }
}

export function isAssistantContentCheckpoint(entry: TranscriptEntry): entry is TranscriptEntry & {
  kind: 'checkpoint'
  payload: Record<string, unknown> & { callId: string; content: string }
} {
  return entry.kind === 'checkpoint'
    && entry.payload.type === 'assistant_content_for_tool_call'
    && typeof entry.payload.callId === 'string'
    && typeof entry.payload.content === 'string'
}

export function toolResultText(output: Extract<AgentInputItem, { type: 'function_call_result' }>['output']): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    const text = output.flatMap(part => part.type === 'input_text' ? [part.text] : []).join('')
    if (text) return text
  }
  if (isRecord(output) && output.type === 'text' && typeof output.text === 'string') return output.text
  throw new Error('SDK Session 工具结果不是文本')
}

export function extractReasoningDelta(value: unknown): string {
  if (!isRecord(value)) return ''
  if (value.type === 'response.reasoning_text.delta' && typeof value.delta === 'string') {
    return value.delta
  }
  const choices = Array.isArray(value.choices) ? value.choices : []
  const first = choices[0]
  if (!isRecord(first) || !isRecord(first.delta)) return ''
  const reasoning = first.delta.reasoning ?? first.delta.reasoning_content
  return typeof reasoning === 'string' ? reasoning : ''
}

export function functionCallId(interruption: RunToolApprovalItem): string | null {
  const raw = interruption.rawItem
  return raw.type === 'function_call' && typeof raw.callId === 'string' ? raw.callId : null
}

export function parseArguments(value: string | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value ?? '{}')
  if (!isRecord(parsed)) throw new Error('审批工具参数必须为 JSON object')
  return parsed
}

export function requireThreadId(threadId: string | null | undefined): string {
  if (!threadId) throw new Error('连续对话运行必须属于 thread')
  return threadId
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${field} 不能为空`)
  return value
}

export function sdkNativeLedgerStatus(status: 'completed' | 'in_progress' | 'incomplete'): 'started' | 'completed' | 'failed' {
  if (status === 'incomplete') return 'failed'
  if (status === 'in_progress') return 'started'
  return 'completed'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型窗口运行上下文重注入
//
//   文件:       RuntimeContextReinjection.ts
//
//   日期:       2026年08月30日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AgentInputItem,ModelRequest } from '@openai/agents'

const RUNTIME_CONTEXT_START = '<runtime-context>'
const RUNTIME_CONTEXT_END = '</runtime-context>'

/**
 * 把会随 Thread、Run 或步骤变化的上下文放入模型输入，而不是改写稳定的
 * systemInstructions。每次发包前替换旧块，保证 SDK 重试和多步骤运行不会叠加。
 */
export function reinjectRuntimeContext(
  request: ModelRequest,
  runtimeContext: string,
  hookContexts: readonly string[],
): ModelRequest {
  const currentItems: AgentInputItem[] = typeof request.input === 'string'
    ? [{ type: 'message', role: 'user', content: request.input }]
    : request.input
  const withoutOldContext = currentItems.filter(item => !isRuntimeContextItem(item))
  const sections = runtimeContext.trim() ? [runtimeContext.trim()] : []
  const normalizedHookContexts = hookContexts
    .map(context => context.trim())
    .filter(Boolean)
  if (normalizedHookContexts.length) {
    sections.push([
      '## Runtime Hook 附加上下文',
      ...normalizedHookContexts,
    ].join('\n'))
  }
  if (!sections.length) {
    return { ...request, input: withoutOldContext }
  }

  const contextItem: AgentInputItem = {
    type: 'message',
    role: 'system',
    content: [
      RUNTIME_CONTEXT_START,
      ...sections,
      RUNTIME_CONTEXT_END,
    ].join('\n'),
  }
  const lastUserIndex = findLastIndex(withoutOldContext, item => (
    'role' in item && item.role === 'user'
  ))
  const insertionIndex = lastUserIndex >= 0
    ? lastUserIndex
    : leadingSystemCount(withoutOldContext)
  return {
    ...request,
    input: [
      ...withoutOldContext.slice(0, insertionIndex),
      contextItem,
      ...withoutOldContext.slice(insertionIndex),
    ],
  }
}

export function isRuntimeContextItem(item: AgentInputItem): boolean {
  return 'role' in item
    && item.role === 'system'
    && typeof item.content === 'string'
    && item.content.startsWith(RUNTIME_CONTEXT_START)
    && item.content.endsWith(RUNTIME_CONTEXT_END)
}

function leadingSystemCount(items: readonly AgentInputItem[]): number {
  let count = 0
  for (const item of items) {
    if ('role' in item && item.role === 'system') count += 1
    else break
  }
  return count
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (value !== undefined && predicate(value)) return index
  }
  return -1
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型窗口 GeoWorld 基线重注入
//
//   文件:       WorldBaselineReinjection.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { AgentInputItem,ModelRequest } from '@openai/agents'
import type { RecordedAgentStepContext } from '../step/AgentStepContextFactory.js'

const WORLD_BASELINE_START = '<geo-world-baseline '
const WORLD_BASELINE_END = '</geo-world-baseline>'

/**
 * 每个精确模型请求只携带与 StepContext 绑定的一份 GeoWorld 投影。
 *
 * 基线位于最后一个真实用户输入之前：压缩摘要可以更老，当前 objective
 * 仍保持最靠近模型的位置。旧基线会被同 revision 的权威快照替换，避免
 * rollover 或 retry 后叠加出多个相互矛盾的世界状态。
 */
export function reinjectGeoWorldBaseline(
  request: ModelRequest,
  context: RecordedAgentStepContext,
): ModelRequest {
  const currentItems: AgentInputItem[] = typeof request.input === 'string'
    ? [{ type: 'message', role: 'user', content: request.input }]
    : request.input
  const withoutOldBaseline = currentItems.filter(item => !isWorldBaselineItem(item))
  const baseline = worldBaselineItem(context)
  const lastUserIndex = findLastIndex(withoutOldBaseline, item => (
    'role' in item && item.role === 'user'
  ))
  const insertionIndex = lastUserIndex >= 0 ? lastUserIndex : leadingSystemCount(withoutOldBaseline)
  return {
    ...request,
    input: [
      ...withoutOldBaseline.slice(0, insertionIndex),
      baseline,
      ...withoutOldBaseline.slice(insertionIndex),
    ],
  }
}

export function assertGeoWorldBaselineBound(
  request: ModelRequest,
  context: RecordedAgentStepContext,
): void {
  if (typeof request.input === 'string') {
    throw new Error(`模型请求缺少 GeoWorld revision ${context.worldRevision} 基线`)
  }
  const baselines = request.input.filter(isWorldBaselineItem)
  if (baselines.length !== 1) {
    throw new Error(`模型请求必须且只能包含一份 GeoWorld 基线，实际为 ${baselines.length} 份`)
  }
  const baseline = baselines[0]
  if (!baseline || !('content' in baseline) || typeof baseline.content !== 'string') {
    throw new Error('模型请求 GeoWorld 基线正文无效')
  }
  const lines = baseline.content.split('\n')
  const expectedOpening = `${WORLD_BASELINE_START}revision="${context.worldRevision}" state-digest="${context.world.stateDigest}">`
  const encodedWorld = lines[2]
  let parsedWorld: unknown = null
  try {
    parsedWorld = encodedWorld ? JSON.parse(encodedWorld) : null
  } catch {
    throw new Error('模型请求 GeoWorld 基线状态不是有效 JSON')
  }
  if (
    lines[0] !== expectedOpening
    || stableJson(parsedWorld) !== stableJson(context.world)
    || lines.at(-1) !== WORLD_BASELINE_END
  ) {
    throw new Error(`模型请求 GeoWorld 基线与 StepContext revision ${context.worldRevision} 不一致`)
  }
}

function worldBaselineItem(context: RecordedAgentStepContext): AgentInputItem {
  return {
    type: 'message',
    role: 'system',
    content: [
      `${WORLD_BASELINE_START}revision="${context.worldRevision}" state-digest="${context.world.stateDigest}">`,
      '这是本次模型请求绑定的当前地理世界状态投影。只能按列出的稳定 ID 引用对象；需要名称、属性或内容时必须调用相应读取工具。',
      JSON.stringify(context.world),
      WORLD_BASELINE_END,
    ].join('\n'),
  }
}

export function isWorldBaselineItem(item: AgentInputItem): boolean {
  return 'role' in item
    && item.role === 'system'
    && typeof item.content === 'string'
    && item.content.startsWith(WORLD_BASELINE_START)
    && item.content.endsWith(WORLD_BASELINE_END)
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

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  )
}

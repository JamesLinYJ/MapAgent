// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 时间线滚动控制
//
//   文件:       localAgentScroll.ts
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5
// --------------------------------------------------------------------------

export interface AgentScrollLine {
  key: string
}

export type AgentTimelineScroll =
  | { mode: 'follow' }
  | { mode: 'anchored'; anchorKey: string; fallbackStart: number }

export interface AgentTimelineWindow<T extends AgentScrollLine> {
  lines: T[]
  start: number
  end: number
  unseenLines: number
  following: boolean
}

export const FOLLOW_AGENT_TIMELINE: AgentTimelineScroll = { mode: 'follow' }

/** 锚点是当前视窗首行，新消息到达时不会把用户正在读的内容推走。 */
export function resolveAgentTimelineWindow<T extends AgentScrollLine>(
  lines: readonly T[],
  capacity: number,
  scroll: AgentTimelineScroll,
): AgentTimelineWindow<T> {
  const safeCapacity = Math.max(1, capacity)
  const maximumStart = Math.max(0, lines.length - safeCapacity)
  const anchoredIndex = scroll.mode === 'anchored'
    ? lines.findIndex(line => line.key === scroll.anchorKey)
    : -1
  const start = scroll.mode === 'follow'
    ? maximumStart
    : Math.max(0, Math.min(maximumStart, anchoredIndex >= 0 ? anchoredIndex : scroll.fallbackStart))
  const end = Math.min(lines.length, start + safeCapacity)
  return {
    lines: lines.slice(start, end),
    start,
    end,
    unseenLines: scroll.mode === 'follow' ? 0 : Math.max(0, lines.length - end),
    following: scroll.mode === 'follow',
  }
}

export function scrollAgentTimeline<T extends AgentScrollLine>(
  lines: readonly T[],
  capacity: number,
  current: AgentTimelineScroll,
  distance: number,
): AgentTimelineScroll {
  if (!lines.length || distance === 0) return current
  const window = resolveAgentTimelineWindow(lines, capacity, current)
  const maximumStart = Math.max(0, lines.length - Math.max(1, capacity))
  const nextStart = Math.max(0, Math.min(maximumStart, window.start + distance))
  if (nextStart >= maximumStart) return FOLLOW_AGENT_TIMELINE
  return {
    mode: 'anchored',
    anchorKey: lines[nextStart]?.key ?? lines[0]?.key ?? '',
    fallbackStart: nextStart,
  }
}

/** 将键盘焦点所在行纳入当前视窗，不经过顶部，也不改变已可见内容的位置。 */
export function revealAgentTimelineLine<T extends AgentScrollLine>(
  lines: readonly T[],
  capacity: number,
  current: AgentTimelineScroll,
  targetKey: string,
): AgentTimelineScroll {
  const targetIndex = lines.findIndex(line => line.key === targetKey)
  if (targetIndex < 0) return current
  const safeCapacity = Math.max(1, capacity)
  const window = resolveAgentTimelineWindow(lines, safeCapacity, current)
  if (targetIndex >= window.start && targetIndex < window.end) return current

  const maximumStart = Math.max(0, lines.length - safeCapacity)
  const nextStart = targetIndex < window.start
    ? targetIndex
    : Math.max(0, targetIndex - safeCapacity + 1)
  if (nextStart >= maximumStart) return FOLLOW_AGENT_TIMELINE
  return {
    mode: 'anchored',
    anchorKey: lines[nextStart]?.key ?? targetKey,
    fallbackStart: nextStart,
  }
}

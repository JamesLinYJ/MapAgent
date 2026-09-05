// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 时间线滚动测试
//
//   文件:       localAgentScroll.test.ts
//
//   日期:       2026年09月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  FOLLOW_AGENT_TIMELINE,
  revealAgentTimelineLine,
  resolveAgentTimelineWindow,
  scrollAgentTimeline,
} from './localAgentScroll.js'

const lines = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `line_${index}` }))

describe('local Agent timeline scroll', () => {
  it('follows the latest content without replaying from the beginning', () => {
    expect(resolveAgentTimelineWindow(lines(20), 5, FOLLOW_AGENT_TIMELINE))
      .toMatchObject({ start: 15, end: 20, unseenLines: 0, following: true })
  })

  it('keeps the same top line when new streaming lines arrive', () => {
    const anchored = scrollAgentTimeline(lines(20), 5, FOLLOW_AGENT_TIMELINE, -6)
    const before = resolveAgentTimelineWindow(lines(20), 5, anchored)
    const after = resolveAgentTimelineWindow(lines(25), 5, anchored)

    expect(before.lines[0]?.key).toBe('line_9')
    expect(after.lines[0]?.key).toBe('line_9')
    expect(after.unseenLines).toBe(11)
  })

  it('returns to direct latest following when scrolling to the bottom', () => {
    const anchored = scrollAgentTimeline(lines(20), 5, FOLLOW_AGENT_TIMELINE, -8)
    expect(scrollAgentTimeline(lines(20), 5, anchored, 8)).toBe(FOLLOW_AGENT_TIMELINE)
  })

  it('reveals a focused historical line directly without replaying from the top', () => {
    const revealed = revealAgentTimelineLine(lines(200), 10, FOLLOW_AGENT_TIMELINE, 'line_80')
    expect(resolveAgentTimelineWindow(lines(200), 10, revealed)).toMatchObject({
      start: 80,
      end: 90,
      following: false,
    })
  })

  it('keeps the current anchor when the focused line is already visible', () => {
    const anchored = scrollAgentTimeline(lines(30), 6, FOLLOW_AGENT_TIMELINE, -10)
    const visible = resolveAgentTimelineWindow(lines(30), 6, anchored)
    const revealed = revealAgentTimelineLine(
      lines(30),
      6,
      anchored,
      visible.lines[2]?.key ?? '',
    )
    expect(revealed).toBe(anchored)
  })
})

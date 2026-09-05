// +-------------------------------------------------------------------------
//
//   地理智能平台 - Goal 编辑态转换测试
//
//   文件:       goalDraft.test.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { buildRunGoalInput, DEFAULT_GOAL_DRAFT } from './goalDraft'

describe('Goal composer draft', () => {
  it('uses the submitted query as the default condition and normalizes bounded controls', () => {
    const goal = buildRunGoalInput({
      ...DEFAULT_GOAL_DRAFT,
      enabled: true,
      acceptanceCriteriaText: '完成空间分析\n\n 提供可复核证据 ',
      maxRechecks: '3',
      deadlineLocal: '2099-08-08T20:00',
      maxTokenBudget: '20000',
    }, ' 分析杭州风险 ', Date.parse('2026-08-08T00:00:00.000Z'))

    expect(goal).toMatchObject({
      condition: '分析杭州风险',
      acceptanceCriteria: ['完成空间分析', '提供可复核证据'],
      maxRechecks: 3,
      maxTokenBudget: 20_000,
    })
    expect(goal?.deadlineAt).toMatch(/^2099-08-08T/u)
  })

  it('returns null when Goal mode is disabled', () => {
    expect(buildRunGoalInput(DEFAULT_GOAL_DRAFT, '普通查询')).toBeNull()
  })

  it('rejects expired deadlines and unbounded recheck counts before submission', () => {
    expect(() => buildRunGoalInput({
      ...DEFAULT_GOAL_DRAFT,
      enabled: true,
      maxRechecks: '11',
    }, '目标')).toThrow('最大复验次数必须在 0–10 之间')

    expect(() => buildRunGoalInput({
      ...DEFAULT_GOAL_DRAFT,
      enabled: true,
      deadlineLocal: '2000-01-01T00:00',
    }, '目标', Date.parse('2026-08-08T00:00:00.000Z'))).toThrow('截止时间必须晚于当前时间')
  })
})

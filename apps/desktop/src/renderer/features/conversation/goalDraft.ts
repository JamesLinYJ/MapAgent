// +-------------------------------------------------------------------------
//
//   地理智能平台 - Goal 编辑态转换
//
//   文件:       goalDraft.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { RunGoalInput } from '@geo-agent-platform/shared-types'

import type { GoalComposerDraft } from './types'

export const DEFAULT_GOAL_DRAFT: GoalComposerDraft = {
  enabled: false,
  condition: '',
  acceptanceCriteriaText: '',
  maxRechecks: '2',
  deadlineLocal: '',
  maxTokenBudget: '',
}

export function buildRunGoalInput(
  draft: GoalComposerDraft,
  fallbackCondition: string,
  now = Date.now(),
): RunGoalInput | null {
  if (!draft.enabled) return null

  const condition = draft.condition.trim() || fallbackCondition.trim()
  if (!condition) throw new Error('启用 Goal 后必须填写目标条件。')
  if (condition.length > 2000) throw new Error('Goal 条件不能超过 2000 个字符。')

  const acceptanceCriteria = draft.acceptanceCriteriaText
    .split(/\r?\n/u)
    .map(value => value.trim())
    .filter(Boolean)
  if (acceptanceCriteria.length > 20) throw new Error('Goal 验收标准最多 20 条。')
  if (acceptanceCriteria.some(value => value.length > 500)) {
    throw new Error('每条 Goal 验收标准不能超过 500 个字符。')
  }

  const maxRechecks = parseBoundedInteger(draft.maxRechecks, '最大复验次数', 0, 10)
  const maxTokenBudget = draft.maxTokenBudget.trim()
    ? parseBoundedInteger(draft.maxTokenBudget, 'Goal 词元预算', 1, 10_000_000)
    : null
  const deadlineAt = parseFutureDeadline(draft.deadlineLocal, now)

  return {
    condition,
    acceptanceCriteria,
    maxRechecks,
    deadlineAt,
    maxTokenBudget,
  }
}

function parseBoundedInteger(value: string, label: string, minimum: number, maximum: number): number {
  const normalized = value.trim()
  if (!/^\d+$/u.test(normalized)) throw new Error(`${label}必须是整数。`)
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label}必须在 ${minimum}–${maximum} 之间。`)
  }
  return parsed
}

function parseFutureDeadline(value: string, now: number): string | null {
  const normalized = value.trim()
  if (!normalized) return null
  const timestamp = new Date(normalized).getTime()
  if (!Number.isFinite(timestamp)) throw new Error('Goal 截止时间格式无效。')
  if (timestamp <= now) throw new Error('Goal 截止时间必须晚于当前时间。')
  return new Date(timestamp).toISOString()
}

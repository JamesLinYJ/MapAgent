// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation Cron 计算
//
//   文件:       cronSchedule.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { CronExpressionParser } from 'cron-parser'

export interface CronScheduleInput {
  cron: string
  timezone: string
  from?: Date
}

// 平台 v1 明确采用标准 5 字段 cron。pg-boss 接受更宽的表达式，
// 但产品层只开放一个稳定语义，避免用户看到与 UI/审计不一致的触发时间。
export function assertSupportedCronExpression(cron: string): void {
  const normalized = cron.trim().replace(/\s+/gu, ' ')
  const parts = normalized.split(' ')
  if (parts.length !== 5) {
    throw new Error('定时任务 cron 必须是 5 字段表达式：分 时 日 月 周。')
  }
  if (/[?LH#@]/iu.test(normalized)) {
    throw new Error('定时任务 cron 暂不支持 ?、L、H、# 或 @ 预设表达式。')
  }
  if (/[A-Za-z]/u.test(normalized)) {
    throw new Error('定时任务 cron 请使用数字月份和星期，不使用英文缩写。')
  }
}

export function computeNextFireAt(input: CronScheduleInput): string {
  assertSupportedCronExpression(input.cron)
  if (!input.timezone.trim()) throw new Error('定时任务必须指定 timezone。')
  const expression = CronExpressionParser.parse(input.cron.trim(), {
    currentDate: input.from ?? new Date(),
    tz: input.timezone,
  })
  return expression.next().toDate().toISOString()
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - ID 与时间工具
//
//   文件:       ids.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------
import { randomUUID } from 'node:crypto'

export function makeId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function nowUtc() {
  return new Date().toISOString()
}

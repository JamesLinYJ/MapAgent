// +-------------------------------------------------------------------------
//
//   地理智能平台 - StepContext 稳定摘要
//
//   文件:       agentContextDigest.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'

import { stableJson } from '../../framework/schema.js'

export function agentContextDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value), 'utf8').digest('hex')}`
}

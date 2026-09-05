// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久上下文窗口契约
//
//   文件:       contextWindow.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

export const CONTEXT_WINDOW_SCHEMA_VERSION = 1 as const
export const CONTEXT_PROMPT_PROTOCOL_VERSION = '1' as const

export const contextWindowSourceSummarySchema = z.object({
  turnId: z.string().min(1),
  objectiveRevision: z.number().int().positive(),
  inputCursor: z.number().int().nonnegative(),
  summaryObjectHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)),
}).strict()

export const contextWindowCompactionSchema = z.object({
  sourceDigest: z.string().min(1),
  summaryObjectHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)),
  promptVersion: z.string().min(1),
  compactedAt: z.string().datetime({ offset: true }),
}).strict()

export const contextWindowSchema = z.object({
  schemaVersion: z.literal(CONTEXT_WINDOW_SCHEMA_VERSION),
  contextWindowId: z.string().min(1),
  runId: z.string().min(1),
  generation: z.number().int().positive(),
  promptProtocolVersion: z.string().min(1),
  sourceDigest: z.string().min(1),
  sourceSummary: contextWindowSourceSummarySchema,
  compaction: contextWindowCompactionSchema.nullable(),
  startedAt: z.string().datetime({ offset: true }),
  closedAt: z.string().datetime({ offset: true }).nullable(),
}).strict()

export type ContextWindowSourceSummary = z.infer<typeof contextWindowSourceSummarySchema>
export type ContextWindowCompaction = z.infer<typeof contextWindowCompactionSchema>
export type ContextWindow = z.infer<typeof contextWindowSchema>

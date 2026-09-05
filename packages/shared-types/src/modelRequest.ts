// +-------------------------------------------------------------------------
//
//   地理智能平台 - 精确模型请求日志契约
//
//   文件:       modelRequest.ts
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import { z } from 'zod'

export const MODEL_REQUEST_RECORD_SCHEMA_VERSION = 2 as const

const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const contentObjectHashSchema = z.string().regex(/^[a-f0-9]{64}$/u)

/**
 * 一次 provider 调用的不可变事实。完整请求正文只存在内容寻址对象中，
 * 结构化表只保存归属、摘要和恢复所需的对象 hash。
 */
export const modelRequestRecordSchema = z.object({
  schemaVersion: z.literal(MODEL_REQUEST_RECORD_SCHEMA_VERSION),
  requestId: z.string().min(1),
  runId: z.string().min(1),
  turnId: z.string().min(1),
  stepId: z.string().min(1),
  segmentId: z.string().min(1),
  objectiveRevision: z.number().int().positive(),
  inputCursor: z.number().int().nonnegative(),
  contextWindowId: z.string().min(1),
  contextDigest: sha256DigestSchema,
  agentStepContextSchemaVersion: z.number().int().positive(),
  provider: z.string().min(1),
  modelId: z.string().min(1),
  inputObjectHash: contentObjectHashSchema,
  inputDigest: sha256DigestSchema,
  instructionsDigest: sha256DigestSchema,
  toolPlanDigest: sha256DigestSchema,
  worldRevision: z.number().int().positive(),
  inputEntryIds: z.array(z.string().min(1)),
  summaryObjectHashes: z.array(contentObjectHashSchema),
  createdAt: z.string().min(1),
}).strict()

export type ModelRequestRecord = z.infer<typeof modelRequestRecordSchema>

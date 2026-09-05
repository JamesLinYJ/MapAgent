// +-------------------------------------------------------------------------
//
//   地理智能平台 - 文件型会话协议
//
//   文件:       conversation.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

// 平台 文件型会话协议：transcript、checkpoint、compaction 与上下文报告。
import { z } from 'zod'
import { analysisRunSchema } from './platform.js'

// --- File conversation kernel ---

export const transcriptEntryKindSchema = z.enum([
  'message', 'tool_call', 'tool_result',
  'compact_boundary', 'compact_summary', 'checkpoint',
])

export const contentRefSchema = z.object({
  algorithm: z.literal('sha256').default('sha256'),
  hash: z.string(),
  mediaType: z.string().default('application/octet-stream'),
  sizeBytes: z.number().int().nonnegative(),
  relativePath: z.string(),
})

export const transcriptEntrySchema = z.object({
  schemaVersion: z.literal(2).default(2),
  seq: z.number().int().positive(),
  entryId: z.string(),
  parentEntryId: z.string().nullable().default(null),
  logicalParentEntryId: z.string().nullable().default(null),
  threadId: z.string(),
  runId: z.string().nullable().default(null),
  turnId: z.string().nullable().default(null),
  kind: transcriptEntryKindSchema,
  timestamp: z.string(),
  payload: z.record(z.string(), z.unknown()).prefault({}),
})

export const threadManifestSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  threadId: z.string(),
  sessionId: z.string(),
  activeLeafEntryId: z.string().nullable().default(null),
  lastSequence: z.number().int().nonnegative().default(0),
  transcriptEntryCount: z.number().int().nonnegative().default(0),
  estimatedContextTokens: z.number().int().nonnegative().default(0),
  latestCompactionId: z.string().nullable().default(null),
  memoryVersion: z.number().int().nonnegative().default(0),
  memoryBasedOnTokens: z.number().int().nonnegative().default(0),
  forkedFrom: z.object({
    threadId: z.string(),
    entryId: z.string(),
  }).nullable().default(null),
  quarantined: z.boolean().default(false),
  quarantineReason: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const AGENTS_SDK_STATE_SCHEMA_VERSION = 7 as const

export const runCheckpointSchema = z.object({
  schemaVersion: z.literal(3).default(3),
  run: z.lazy(() => analysisRunSchema),
  activeEntryId: z.string().nullable().default(null),
  pendingToolCallIds: z.array(z.string()).default([]),
  lastPersistedAt: z.string(),
  recoveryStatus: z.enum(['clean', 'interrupted', 'requires_action']).default('clean'),
  orchestrationEngine: z.literal('openai_agents').nullable().default(null),
  sdkStateContentHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable().default(null),
  agentsSdkVersion: z.string().nullable().default(null),
  runtimeConfigDigest: z.string().nullable().default(null),
  // 历史终态 Run 仍需可读；restore 边界再严格校验当前版本。
  sdkStateSchemaVersion: z.number().int().positive().nullable().default(null),
  sdkStateUpdatedAt: z.string().nullable().default(null),
  nextInputSequence: z.number().int().positive().default(1),
  checkpointInputCursor: z.number().int().nonnegative().default(0),
  activeInputLeaseId: z.string().nullable().default(null),
  activeInputLeaseFrom: z.number().int().positive().nullable().default(null),
  activeInputLeaseTo: z.number().int().positive().nullable().default(null),
  terminalInputClaimId: z.string().nullable().default(null),
  terminalObjectiveRevision: z.number().int().positive().nullable().default(null),
  terminalInputCursor: z.number().int().nonnegative().nullable().default(null),
  terminalClaimedAt: z.string().nullable().default(null),
})

export const compactionRecordSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  compactionId: z.string(),
  threadId: z.string(),
  boundaryEntryId: z.string(),
  summaryEntryId: z.string(),
  firstCompactedEntryId: z.string(),
  lastCompactedEntryId: z.string(),
  preservedFromEntryId: z.string().nullable().default(null),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceEntryIds: z.array(z.string()).min(1),
  sourceUnitIds: z.array(z.string()).min(1),
  sourceObjectHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1),
  summary: z.string(),
  strategy: z.literal('model'),
  summaryProvider: z.string().min(1),
  summaryModel: z.string().min(1),
  promptVersion: z.string().min(1),
  preTokens: z.number().int().nonnegative(),
  postTokens: z.number().int().nonnegative(),
  createdAt: z.string(),
})

export const threadMemoryDocumentSchema = z.object({
  threadId: z.string(),
  version: z.number().int().nonnegative(),
  content: z.string(),
  generatedContent: z.string().default(''),
  pinnedContent: z.string().default(''),
  source: z.enum(['system', 'user', 'fork']).default('system'),
  basedOnEntryId: z.string().nullable().default(null),
  estimatedTokens: z.number().int().nonnegative().default(0),
  updatedAt: z.string(),
})

export const contextAssemblyReportSchema = z.object({
  threadId: z.string(),
  activeLeafEntryId: z.string().nullable().default(null),
  contextWindowTokens: z.number().int().positive(),
  estimatedTokens: z.number().int().nonnegative(),
  usageRatio: z.number().nonnegative(),
  compactionRecommended: z.boolean(),
  hardLimitReached: z.boolean(),
  includedEntryIds: z.array(z.string()).default([]),
  omittedEntryCount: z.number().int().nonnegative().default(0),
  latestCompactionId: z.string().nullable().default(null),
  sections: z.array(z.object({
    name: z.string(),
    estimatedTokens: z.number().int().nonnegative(),
  })).default([]),
})

export type TranscriptEntryKind = z.infer<typeof transcriptEntryKindSchema>
export type ContentRef = z.infer<typeof contentRefSchema>
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>
export type ThreadManifest = z.infer<typeof threadManifestSchema>
export type RunCheckpoint = z.infer<typeof runCheckpointSchema>
export type CompactionRecord = z.infer<typeof compactionRecordSchema>
export type ThreadMemoryDocument = z.infer<typeof threadMemoryDocumentSchema>
export type ContextAssemblyReport = z.infer<typeof contextAssemblyReportSchema>

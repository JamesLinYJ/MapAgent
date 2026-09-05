// +-------------------------------------------------------------------------
//
//   地理智能平台 - 记忆系统 Zod 契约
//
//   文件:       schemas.ts
//
//   日期:       2026年06月30日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { z } from 'zod'

export const memoryScopeSchema = z.enum(['private', 'team', 'session', 'instruction'])
export const memoryTypeSchema = z.enum(['user', 'feedback', 'project', 'reference'])

export const memoryFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  type: memoryTypeSchema,
  paths: z.union([z.string(), z.array(z.string())]).optional(),
})

export const memoryFileRecordSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  scope: memoryScopeSchema,
  type: memoryTypeSchema.nullable().default(null),
  name: z.string().default(''),
  description: z.string().default(''),
  mtimeMs: z.number().nonnegative().default(0),
  content: z.string().optional(),
  parent: z.string().nullable().default(null),
  globs: z.array(z.string()).default([]),
  contentDiffersFromDisk: z.boolean().default(false),
})

const memorySearchResultSchema = z.object({
  record: memoryFileRecordSchema,
  reason: z.string().default(''),
  score: z.number().min(0).max(1).default(0),
})

export const memorySelectorOutputSchema = z.object({
  selected_memories: z.array(z.string()),
})

export type MemoryScope = z.infer<typeof memoryScopeSchema>
export type MemoryType = z.infer<typeof memoryTypeSchema>
export type MemoryFrontmatter = z.infer<typeof memoryFrontmatterSchema>
export type MemoryFileRecord = z.infer<typeof memoryFileRecordSchema>
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>

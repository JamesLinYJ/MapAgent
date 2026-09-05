// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面系统日志记录契约
//
//   文件:       desktopLogRecords.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { matchesOperationsLogFilter } from '@geo-agent-platform/operations-supervisor/log-buffer'
import {
  operationsLogAttributeValueSchema,
  operationsLogCategorySchema,
  operationsLogCorrelationSchema,
  operationsLogEntrySchema,
  operationsLogLevelSchema,
  operationsLogRetentionSchema,
  type OperationsLogEntry,
  type OperationsLogQuery,
} from '@geo-agent-platform/shared-types/operations'
import { z } from 'zod'

const desktopFileLogRecordSchema = z.object({
  version: z.literal(2),
  createdAt: z.string().datetime(),
  level: operationsLogLevelSchema,
  event: z.string().min(1).max(120),
  category: operationsLogCategorySchema,
  retention: operationsLogRetentionSchema,
  correlation: operationsLogCorrelationSchema,
  scope: z.string().trim().min(1).max(80),
  processId: z.number().int().positive(),
  message: z.string().max(16_000),
  errorStack: z.string().max(8_000).nullable(),
  attributes: z.record(z.string().min(1).max(80), operationsLogAttributeValueSchema),
}).strict()

export type DesktopFileLogRecord = z.infer<typeof desktopFileLogRecordSchema>

export function desktopFileLogRecord(entry: OperationsLogEntry): DesktopFileLogRecord {
  return desktopFileLogRecordSchema.parse({
    version: 2,
    createdAt: entry.createdAt,
    level: entry.level,
    event: entry.event,
    category: entry.category,
    retention: entry.retention,
    correlation: entry.correlation,
    scope: entry.component ?? 'desktop',
    processId: entry.processId ?? process.pid,
    message: entry.message,
    errorStack: entry.errorStack,
    attributes: entry.attributes,
  })
}

export function serializeDesktopFileLogRecord(input: DesktopFileLogRecord): string {
  return JSON.stringify(desktopFileLogRecordSchema.parse(input))
}

export function parseDesktopFileLogRecord(input: unknown): DesktopFileLogRecord | null {
  const parsed = desktopFileLogRecordSchema.safeParse(input)
  return parsed.success ? parsed.data : null
}

export function projectDesktopLogLines(
  lines: readonly string[],
  query: OperationsLogQuery,
): OperationsLogEntry[] {
  if (!query.includeSupervisor || query.tail === 0) return []
  const entries: OperationsLogEntry[] = []
  for (const [index, line] of lines.entries()) {
    const parsed = parseLine(line)
    if (!parsed) continue
    const entry = operationsLogEntrySchema.parse({
      sequence: 1_500_000_000 + index,
      serviceId: null,
      component: parsed.scope,
      processId: parsed.processId,
      stream: 'supervisor',
      level: parsed.level,
      event: parsed.event,
      category: parsed.category,
      retention: parsed.retention,
      correlation: parsed.correlation,
      message: parsed.message,
      errorStack: parsed.errorStack,
      attributes: parsed.attributes,
      createdAt: parsed.createdAt,
    })
    if (matchesOperationsLogFilter(entry, query)) entries.push(entry)
  }
  return entries.slice(-query.tail)
}

function parseLine(value: string): DesktopFileLogRecord | null {
  try {
    const parsed: unknown = JSON.parse(value)
    const result = desktopFileLogRecordSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

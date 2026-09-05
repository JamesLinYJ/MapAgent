// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具目录存储
//
//   文件:       toolCatalogStore.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { and, asc, eq } from 'drizzle-orm'
import type { Database } from '../../db/connection.js'
import { toolCatalogEntries } from '../../db/schema.js'
import { decodeRequiredRecord } from '../../db/valueDecoders.js'

type ToolCatalogRow = typeof toolCatalogEntries.$inferSelect

export interface ToolCatalogEntry {
  toolKind: string
  toolName: string
  payload: Record<string, unknown>
  sortOrder: number
}

// 工具目录是 ToolProvider 状态的产品化投影。这里使用 Drizzle 主路径，
// 不再靠手写 SQL 字符串维护排序、更新和删除规则。
export class ToolCatalogStore {
  constructor(private readonly db: Database) {}

  async listToolCatalogEntries(): Promise<ToolCatalogEntry[]> {
    const rows = await this.db
      .select()
      .from(toolCatalogEntries)
      .orderBy(
        asc(toolCatalogEntries.sortOrder),
        asc(toolCatalogEntries.toolKind),
        asc(toolCatalogEntries.toolName),
      )
    return rows.map(row => mapToolCatalogRow(row))
  }

  async upsertToolCatalogEntry(entry: ToolCatalogEntry): Promise<ToolCatalogEntry> {
    await this.db
      .insert(toolCatalogEntries)
      .values({
        toolKind: entry.toolKind,
        toolName: entry.toolName,
        payloadJson: entry.payload,
        sortOrder: entry.sortOrder,
      })
      .onConflictDoUpdate({
        target: [toolCatalogEntries.toolName, toolCatalogEntries.toolKind],
        set: {
          payloadJson: entry.payload,
          sortOrder: entry.sortOrder,
        },
      })
    return entry
  }

  async deleteToolCatalogEntry(toolKind: string, toolName: string): Promise<void> {
    await this.db
      .delete(toolCatalogEntries)
      .where(and(
        eq(toolCatalogEntries.toolKind, toolKind),
        eq(toolCatalogEntries.toolName, toolName),
      ))
  }
}

function mapToolCatalogRow(row: ToolCatalogRow): ToolCatalogEntry {
  return {
    toolKind: row.toolKind,
    toolName: row.toolName,
    payload: decodeRequiredRecord(row.payloadJson, 'tool_catalog_entries.payload_json'),
    sortOrder: row.sortOrder,
  }
}

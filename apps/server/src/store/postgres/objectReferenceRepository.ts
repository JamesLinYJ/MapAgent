// +-------------------------------------------------------------------------
//
//   地理智能平台 - 内容对象引用持久化
//
//   文件:       objectReferenceRepository.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { eq, ne } from 'drizzle-orm'
import type { Database } from '../../db/connection.js'
import {
  platformConversationEntries,
  platformFileObjects,
  platformMeteorologicalDatasets,
  platformModelRequestRecords,
  platformRunRecords,
  platformRuns,
  platformThreadMemoryVersions,
} from '../../db/schema.js'
import type { ObjectReferenceRepository } from './conversationPersistencePorts.js'

export class PostgresObjectReferenceRepository implements ObjectReferenceRepository {
  constructor(private readonly db: Database) {}

  async listReferencedObjectHashes(): Promise<string[]> {
    const [runRows, modelRequestRows, memoryRows, entryRows, recordRows, fileRows, meteorologicalRows] = await Promise.all([
      this.db.select({ hash: platformRuns.sdkStateContentHash }).from(platformRuns),
      this.db.select({ hash: platformModelRequestRecords.inputObjectHash }).from(platformModelRequestRecords),
      this.db.select({ hash: platformThreadMemoryVersions.contentHash }).from(platformThreadMemoryVersions),
      this.db.select({ payload: platformConversationEntries.payloadJson }).from(platformConversationEntries),
      this.db.select({ payload: platformRunRecords.payloadJson }).from(platformRunRecords),
      this.db.select({ hash: platformFileObjects.contentHash })
        .from(platformFileObjects)
        // pending 记录在物理 publish 前已 durable reserve，是跨进程/崩溃
        // GC pin；只有 deleted 明确放弃对象引用。
        .where(ne(platformFileObjects.status, 'deleted')),
      this.db.select({ hash: platformMeteorologicalDatasets.contentHash })
        .from(platformMeteorologicalDatasets)
        .where(eq(platformMeteorologicalDatasets.status, 'ready')),
    ])
    const hashes = new Set<string>()
    for (const row of [...runRows, ...modelRequestRows, ...memoryRows, ...fileRows, ...meteorologicalRows]) {
      if (row.hash && /^[a-f0-9]{64}$/u.test(row.hash)) hashes.add(row.hash)
    }
    for (const row of [...entryRows, ...recordRows]) collectSha256Strings(row.payload, hashes)
    return [...hashes]
  }
}

function collectSha256Strings(value: unknown, hashes: Set<string>): void {
  if (typeof value === 'string') {
    if (/^[a-f0-9]{64}$/u.test(value)) hashes.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSha256Strings(item, hashes)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const item of Object.values(value)) collectSha256Strings(item, hashes)
}

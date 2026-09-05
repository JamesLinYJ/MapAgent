// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象任务仓储
//
//   文件:       meteorologicalJobRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { eq } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { platformMeteorologicalJobs } from '../../db/schema.js'
import type { MeteorologicalJobRecord } from '../../schemas/types.js'
import { decodeRequiredRecord, decodeRequiredTimestamp } from '../../db/valueDecoders.js'

type JobRow = typeof platformMeteorologicalJobs.$inferSelect

/** 气象后台处理任务状态与结果载荷的唯一写入边界。 */
export class MeteorologicalJobRepository {
  constructor(private readonly db: Database) {}

  async get(jobId: string): Promise<MeteorologicalJobRecord | null> {
    const rows = await this.db
      .select()
      .from(platformMeteorologicalJobs)
      .where(eq(platformMeteorologicalJobs.jobId, jobId))
      .limit(1)
    const row = rows[0]
    return row ? mapJobRow(row) : null
  }

  async create(job: MeteorologicalJobRecord): Promise<void> {
    await this.db.insert(platformMeteorologicalJobs).values({
      jobId: job.jobId,
      datasetId: job.datasetId,
      workspaceId: job.workspaceId,
      createdByUserId: job.createdByUserId,
      sessionId: job.sessionId,
      threadId: job.threadId,
      kind: job.kind,
      status: job.status,
      message: job.message,
      payloadJson: job.payload,
      createdAt: new Date(job.createdAt),
      updatedAt: new Date(job.updatedAt),
      completedAt: job.completedAt ? new Date(job.completedAt) : null,
    })
  }
}

function mapJobRow(row: JobRow): MeteorologicalJobRecord {
  return {
    jobId: row.jobId,
    datasetId: row.datasetId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    sessionId: row.sessionId,
    threadId: row.threadId,
    kind: row.kind,
    status: row.status,
    message: row.message,
    payload: decodeRequiredRecord(row.payloadJson, 'platform_meteorological_jobs.payload_json'),
    createdAt: decodeRequiredTimestamp(row.createdAt, 'platform_meteorological_jobs.created_at'),
    updatedAt: decodeRequiredTimestamp(row.updatedAt, 'platform_meteorological_jobs.updated_at'),
    completedAt: row.completedAt
      ? decodeRequiredTimestamp(row.completedAt, 'platform_meteorological_jobs.completed_at')
      : null,
  }
}

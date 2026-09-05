// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostgreSQL 审批事实仓储
//
//   文件:       approvalRepository.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { isDeepStrictEqual } from 'node:util'

import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import {
  approvalRecordSchema,
  type ApprovalRecord,
} from '@geo-agent-platform/shared-types/approval-runtime'

import type { Database, DatabaseTransaction } from '../../db/connection.js'
import { platformApprovalRecords } from '../../db/schema.js'
import type { RunMutationQueue } from '../runMutationQueue.js'
import type {
  ApprovalRepository,
  ConsumeApprovalRecordInput,
  ResolveApprovalRecordInput,
} from './conversationPersistencePorts.js'

export class PostgresApprovalRepository implements ApprovalRepository {
  constructor(
    private readonly db: Database,
    private readonly runMutations: RunMutationQueue,
  ) {}

  prepareApprovalRecord(record: ApprovalRecord): Promise<ApprovalRecord> {
    const prepared = approvalRecordSchema.parse(record)
    if (prepared.version !== 1 || prepared.status === 'consumed') {
      return Promise.reject(new Error('新审批记录必须以 version 1 的 pending/resolved 状态建立'))
    }
    return this.runMutations.run(prepared.runId, () => this.db.transaction(async tx => {
      const inserted = await tx.insert(platformApprovalRecords)
        .values(toApprovalValues(prepared))
        .onConflictDoNothing()
        .returning()
      if (inserted[0]) return mapApprovalRow(inserted[0])

      const existing = await getApprovalForCallInTransaction(tx, prepared.runId, prepared.callId)
      if (!existing) throw new Error(`审批调用 '${prepared.callId}' 的唯一键冲突但记录不存在`)
      if (!sameApprovalIdentity(existing, prepared)) {
        throw new Error(`审批调用 '${prepared.callId}' 的持久身份与重试请求不一致`)
      }
      return existing
    }))
  }

  async getApprovalRecord(approvalId: string): Promise<ApprovalRecord | null> {
    const rows = await this.db.select().from(platformApprovalRecords)
      .where(eq(platformApprovalRecords.approvalId, approvalId))
      .limit(1)
    return rows[0] ? mapApprovalRow(rows[0]) : null
  }

  async getApprovalRecordForCall(runId: string, callId: string): Promise<ApprovalRecord | null> {
    const rows = await this.db.select().from(platformApprovalRecords)
      .where(and(
        eq(platformApprovalRecords.runId, runId),
        eq(platformApprovalRecords.callId, callId),
      ))
      .limit(1)
    return rows[0] ? mapApprovalRow(rows[0]) : null
  }

  async listApprovalRecords(runId: string): Promise<ApprovalRecord[]> {
    const rows = await this.db.select().from(platformApprovalRecords)
      .where(eq(platformApprovalRecords.runId, runId))
      .orderBy(asc(platformApprovalRecords.createdAt), asc(platformApprovalRecords.approvalId))
    return rows.map(mapApprovalRow)
  }

  async findSessionApproval(sessionId: string, actionKey: string): Promise<ApprovalRecord | null> {
    const rows = await this.db.select().from(platformApprovalRecords)
      .where(and(
        eq(platformApprovalRecords.sessionId, sessionId),
        eq(platformApprovalRecords.actionKey, actionKey),
        eq(platformApprovalRecords.decision, 'approved'),
        eq(platformApprovalRecords.decisionScope, 'session'),
        inArray(platformApprovalRecords.status, ['resolved', 'consumed']),
      ))
      .orderBy(desc(platformApprovalRecords.resolvedAt), desc(platformApprovalRecords.approvalId))
      .limit(1)
    return rows[0] ? mapApprovalRow(rows[0]) : null
  }

  resolveApprovalRecord(input: ResolveApprovalRecordInput): Promise<ApprovalRecord> {
    return this.runMutations.run(input.runId, () => this.db.transaction(async tx => {
      const current = await requireApproval(tx, input.runId, input.approvalId)
      if (current.status !== 'pending') {
        if (
          current.decision === input.decision
          && current.decisionScope === input.scope
          && current.decisionReason === input.reason
        ) return current
        throw new Error(`审批 '${input.approvalId}' 已用不同决定处理`)
      }
      if (current.version !== input.expectedVersion) {
        throw new Error(`审批 '${input.approvalId}' 的 resolve CAS 失败`)
      }
      const updatedRows = await tx.update(platformApprovalRecords).set({
        status: 'resolved',
        decision: input.decision,
        decisionScope: input.scope,
        decisionReason: input.reason,
        decidedByUserId: input.decidedByUserId,
        resolvedAt: new Date(input.resolvedAt),
        version: current.version + 1,
      }).where(and(
        eq(platformApprovalRecords.approvalId, input.approvalId),
        eq(platformApprovalRecords.runId, input.runId),
        eq(platformApprovalRecords.status, 'pending'),
        eq(platformApprovalRecords.version, input.expectedVersion),
      )).returning()
      if (!updatedRows[0]) throw new Error(`审批 '${input.approvalId}' 的 resolve CAS 失败`)
      return mapApprovalRow(updatedRows[0])
    }))
  }

  consumeApprovalRecord(input: ConsumeApprovalRecordInput): Promise<ApprovalRecord> {
    return this.runMutations.run(input.runId, () => this.db.transaction(async tx => {
      const current = await requireApproval(tx, input.runId, input.approvalId)
      if (current.status === 'consumed') return current
      if (current.status !== 'resolved' || current.version !== input.expectedVersion) {
        throw new Error(`审批 '${input.approvalId}' 的 consume CAS 失败`)
      }
      const updatedRows = await tx.update(platformApprovalRecords).set({
        status: 'consumed',
        consumedAt: new Date(input.consumedAt),
        version: current.version + 1,
      }).where(and(
        eq(platformApprovalRecords.approvalId, input.approvalId),
        eq(platformApprovalRecords.runId, input.runId),
        eq(platformApprovalRecords.status, 'resolved'),
        eq(platformApprovalRecords.version, input.expectedVersion),
      )).returning()
      if (!updatedRows[0]) throw new Error(`审批 '${input.approvalId}' 的 consume CAS 失败`)
      return mapApprovalRow(updatedRows[0])
    }))
  }
}

async function getApprovalForCallInTransaction(
  tx: DatabaseTransaction,
  runId: string,
  callId: string,
): Promise<ApprovalRecord | null> {
  const rows = await tx.select().from(platformApprovalRecords)
    .where(and(
      eq(platformApprovalRecords.runId, runId),
      eq(platformApprovalRecords.callId, callId),
    ))
    .for('update')
    .limit(1)
  return rows[0] ? mapApprovalRow(rows[0]) : null
}

async function requireApproval(
  tx: DatabaseTransaction,
  runId: string,
  approvalId: string,
): Promise<ApprovalRecord> {
  const rows = await tx.select().from(platformApprovalRecords)
    .where(and(
      eq(platformApprovalRecords.runId, runId),
      eq(platformApprovalRecords.approvalId, approvalId),
    ))
    .for('update')
    .limit(1)
  if (!rows[0]) throw new Error(`审批 '${approvalId}' 不存在`)
  return mapApprovalRow(rows[0])
}

function mapApprovalRow(
  row: typeof platformApprovalRecords.$inferSelect,
): ApprovalRecord {
  return approvalRecordSchema.parse({
    approvalId: row.approvalId,
    runId: row.runId,
    threadId: row.threadId,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    invocationId: row.invocationId,
    callId: row.callId,
    stepId: row.stepId,
    contextDigest: row.contextDigest,
    actionKey: row.actionKey,
    action: row.actionJson,
    status: row.status,
    decision: row.decision,
    decisionScope: row.decisionScope,
    decisionReason: row.decisionReason,
    decidedByUserId: row.decidedByUserId,
    sourceApprovalId: row.sourceApprovalId,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    consumedAt: row.consumedAt?.toISOString() ?? null,
    version: row.version,
  })
}

function toApprovalValues(record: ApprovalRecord): typeof platformApprovalRecords.$inferInsert {
  return {
    approvalId: record.approvalId,
    runId: record.runId,
    threadId: record.threadId,
    sessionId: record.sessionId,
    workspaceId: record.workspaceId,
    invocationId: record.invocationId,
    callId: record.callId,
    stepId: record.stepId,
    contextDigest: record.contextDigest,
    actionKey: record.actionKey,
    actionJson: record.action,
    status: record.status,
    decision: record.decision,
    decisionScope: record.decisionScope,
    decisionReason: record.decisionReason,
    decidedByUserId: record.decidedByUserId,
    sourceApprovalId: record.sourceApprovalId,
    createdAt: new Date(record.createdAt),
    resolvedAt: record.resolvedAt ? new Date(record.resolvedAt) : null,
    consumedAt: record.consumedAt ? new Date(record.consumedAt) : null,
    version: record.version,
  }
}

function sameApprovalIdentity(left: ApprovalRecord, right: ApprovalRecord): boolean {
  const identity = (record: ApprovalRecord) => ({
    approvalId: record.approvalId,
    runId: record.runId,
    threadId: record.threadId,
    sessionId: record.sessionId,
    workspaceId: record.workspaceId,
    invocationId: record.invocationId,
    callId: record.callId,
    stepId: record.stepId,
    contextDigest: record.contextDigest,
    actionKey: record.actionKey,
    action: record.action,
  })
  return isDeepStrictEqual(identity(left), identity(right))
}

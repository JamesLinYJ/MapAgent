// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 运行仓储
//
//   文件:       automationRunRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, asc, desc, eq, inArray } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { platformAutomationRuns } from '../../db/schema.js'
import {
  automationApprovalRequestSchema,
  automationNodeRunSchema,
  automationRunRecordSchema,
  type AutomationApprovalRequest,
  type AutomationNodeRun,
  type AutomationRunRecord,
  type AutomationStatus,
  type AutomationTriggerKind,
} from '../../automations/schemas.js'

type AutomationRunRow = typeof platformAutomationRuns.$inferSelect

export interface CreateAutomationRunInput {
  automationRunId: string
  automationId: string
  automationRevision: number
  scheduledTaskId: string | null
  workspaceId: string
  createdByUserId: string
  runId: string | null
  status: AutomationStatus
  currentStep: string | null
  triggerKind: AutomationTriggerKind
  errorMessage?: string | null
  metadata?: Record<string, unknown>
  nodeRuns?: AutomationNodeRun[]
  pendingApproval?: AutomationApprovalRequest | null
  outputs?: Record<string, unknown>
}

export interface UpdateAutomationRunInput {
  runId?: string | null
  status?: AutomationStatus
  currentStep?: string | null
  errorMessage?: string | null
  metadata?: Record<string, unknown>
  nodeRuns?: AutomationNodeRun[]
  pendingApproval?: AutomationApprovalRequest | null
  outputs?: Record<string, unknown>
  completedAt?: string | null
  expectedStatuses?: AutomationStatus[]
}

/** Automation 执行投影及节点状态的唯一写入边界。 */
export class AutomationRunRepository {
  constructor(private readonly db: Database) {}

  async createAutomationRun(input: CreateAutomationRunInput): Promise<AutomationRunRecord> {
    const rows = await this.db
      .insert(platformAutomationRuns)
      .values({
        automationRunId: input.automationRunId,
        automationId: input.automationId,
        automationRevision: input.automationRevision,
        scheduledTaskId: input.scheduledTaskId,
        workspaceId: input.workspaceId,
        createdByUserId: input.createdByUserId,
        runId: input.runId,
        status: input.status,
        currentStep: input.currentStep,
        triggerKind: input.triggerKind,
        errorMessage: input.errorMessage ?? null,
        metadataJson: input.metadata ?? {},
        nodeRunsJson: records(input.nodeRuns ?? []),
        pendingApprovalJson: input.pendingApproval ? record(input.pendingApproval) : null,
        outputsJson: input.outputs ?? {},
        startedAt: new Date(),
      })
      .returning()
    const row = rows[0]
    if (!row) throw new Error('Automation 运行记录创建后无法读取。')
    return mapAutomationRunRow(row)
  }

  async getAutomationRun(automationRunId: string): Promise<AutomationRunRecord | null> {
    const rows = await this.db
      .select()
      .from(platformAutomationRuns)
      .where(eq(platformAutomationRuns.automationRunId, automationRunId))
      .limit(1)
    const row = rows[0]
    return row ? mapAutomationRunRow(row) : null
  }

  async updateAutomationRun(
    automationRunId: string,
    input: UpdateAutomationRunInput,
  ): Promise<AutomationRunRecord> {
    const patch: Partial<typeof platformAutomationRuns.$inferInsert> = {}
    if (input.runId !== undefined) patch.runId = input.runId
    if (input.status !== undefined) patch.status = input.status
    if (input.currentStep !== undefined) patch.currentStep = input.currentStep
    if (input.errorMessage !== undefined) patch.errorMessage = input.errorMessage
    if (input.metadata !== undefined) patch.metadataJson = input.metadata
    if (input.nodeRuns !== undefined) patch.nodeRunsJson = records(input.nodeRuns)
    if (input.pendingApproval !== undefined) {
      patch.pendingApprovalJson = input.pendingApproval ? record(input.pendingApproval) : null
    }
    if (input.outputs !== undefined) patch.outputsJson = input.outputs
    if (input.completedAt !== undefined) {
      patch.completedAt = input.completedAt ? new Date(input.completedAt) : null
    }
    const conditions = [eq(platformAutomationRuns.automationRunId, automationRunId)]
    if (input.expectedStatuses) {
      if (!input.expectedStatuses.length) throw new Error('Automation 状态前置条件不能为空。')
      conditions.push(inArray(platformAutomationRuns.status, input.expectedStatuses))
    }
    const rows = await this.db
      .update(platformAutomationRuns)
      .set(patch)
      .where(and(...conditions))
      .returning()
    const row = rows[0]
    if (!row) {
      if (input.expectedStatuses && await this.getAutomationRun(automationRunId)) {
        throw new Error(`Automation 运行 '${automationRunId}' 状态已变化，请刷新后重试。`)
      }
      throw new Error(`Automation 运行 '${automationRunId}' 不存在。`)
    }
    return mapAutomationRunRow(row)
  }

  async listAutomationRuns(
    workspaceId: string,
    scheduledTaskId?: string | null,
  ): Promise<AutomationRunRecord[]> {
    const conditions = [eq(platformAutomationRuns.workspaceId, workspaceId)]
    if (scheduledTaskId) conditions.push(eq(platformAutomationRuns.scheduledTaskId, scheduledTaskId))
    const rows = await this.db
      .select()
      .from(platformAutomationRuns)
      .where(and(...conditions))
      .orderBy(desc(platformAutomationRuns.startedAt))
      .limit(100)
    return rows.map(mapAutomationRunRow)
  }

  async listQueuedAutomationRuns(): Promise<AutomationRunRecord[]> {
    const rows = await this.db
      .select()
      .from(platformAutomationRuns)
      .where(eq(platformAutomationRuns.status, 'queued'))
      .orderBy(asc(platformAutomationRuns.startedAt))
      .limit(1_000)
    return rows.map(mapAutomationRunRow)
  }
}

function mapAutomationRunRow(row: AutomationRunRow): AutomationRunRecord {
  return automationRunRecordSchema.parse({
    automationRunId: row.automationRunId,
    automationId: row.automationId,
    automationRevision: row.automationRevision,
    scheduledTaskId: row.scheduledTaskId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    runId: row.runId,
    status: row.status,
    currentStep: row.currentStep,
    triggerKind: row.triggerKind,
    errorMessage: row.errorMessage,
    metadata: row.metadataJson,
    nodeRuns: automationNodeRunSchema.array().parse(row.nodeRunsJson),
    pendingApproval: row.pendingApprovalJson
      ? automationApprovalRequestSchema.parse(row.pendingApprovalJson)
      : null,
    outputs: row.outputsJson,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  })
}

function record(value: object): Record<string, unknown> {
  return structuredClone(value) as unknown as Record<string, unknown>
}

function records(values: readonly object[]): Array<Record<string, unknown>> {
  return values.map(value => record(value))
}

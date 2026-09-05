// +-------------------------------------------------------------------------
//
//   地理智能平台 - 定时任务仓储
//
//   文件:       scheduledTaskRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, desc, eq, ne } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { platformScheduledTasks } from '../../db/schema.js'
import {
  scheduledTaskSchema,
  type ScheduledTask,
  type ScheduledTaskStatus,
} from '../../automations/schemas.js'

type ScheduledTaskRow = typeof platformScheduledTasks.$inferSelect

export interface CreateScheduledTaskInput {
  taskId: string
  targetKind: 'automation'
  targetId: string
  workspaceId: string
  createdByUserId: string
  title: string
  prompt: string
  parameters: Record<string, unknown>
  cron: string
  timezone: string
  recurring: boolean
  enabled: boolean
  status: ScheduledTaskStatus
  nextFireAt: string | null
}

export interface UpdateScheduledTaskInput {
  targetKind?: 'automation'
  targetId?: string
  title?: string
  prompt?: string
  parameters?: Record<string, unknown>
  cron?: string
  timezone?: string
  recurring?: boolean
  enabled?: boolean
  status?: ScheduledTaskStatus
  nextFireAt?: string | null
  lastFiredAt?: string | null
  lastRunId?: string | null
  queueJobId?: string | null
  failureCount?: number
  lastErrorMessage?: string | null
}

/** 定时任务配置、队列关联和触发游标的唯一写入边界。 */
export class ScheduledTaskRepository {
  constructor(private readonly db: Database) {}

  async listScheduledTasks(workspaceId: string): Promise<ScheduledTask[]> {
    const rows = await this.db
      .select()
      .from(platformScheduledTasks)
      .where(and(
        eq(platformScheduledTasks.workspaceId, workspaceId),
        ne(platformScheduledTasks.status, 'deleted'),
      ))
      .orderBy(desc(platformScheduledTasks.updatedAt))
    return rows.map(mapScheduledTaskRow)
  }

  async listActiveScheduledTasks(): Promise<ScheduledTask[]> {
    const rows = await this.db
      .select()
      .from(platformScheduledTasks)
      .where(and(
        eq(platformScheduledTasks.enabled, true),
        eq(platformScheduledTasks.status, 'active'),
      ))
      .orderBy(platformScheduledTasks.nextFireAt)
    return rows.map(mapScheduledTaskRow)
  }

  async getScheduledTask(taskId: string): Promise<ScheduledTask | null> {
    const rows = await this.db
      .select()
      .from(platformScheduledTasks)
      .where(eq(platformScheduledTasks.taskId, taskId))
      .limit(1)
    const row = rows[0]
    return row ? mapScheduledTaskRow(row) : null
  }

  async createScheduledTask(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    const now = new Date()
    const rows = await this.db
      .insert(platformScheduledTasks)
      .values({
        taskId: input.taskId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        workspaceId: input.workspaceId,
        createdByUserId: input.createdByUserId,
        title: input.title,
        prompt: input.prompt,
        parametersJson: input.parameters,
        cron: input.cron,
        timezone: input.timezone,
        recurring: input.recurring,
        enabled: input.enabled,
        status: input.status,
        nextFireAt: input.nextFireAt ? new Date(input.nextFireAt) : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    const row = rows[0]
    if (!row) throw new Error('定时任务创建后无法读取。')
    return mapScheduledTaskRow(row)
  }

  async updateScheduledTask(taskId: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask> {
    const patch: Partial<typeof platformScheduledTasks.$inferInsert> = { updatedAt: new Date() }
    if (input.targetKind !== undefined) patch.targetKind = input.targetKind
    if (input.targetId !== undefined) patch.targetId = input.targetId
    if (input.title !== undefined) patch.title = input.title
    if (input.prompt !== undefined) patch.prompt = input.prompt
    if (input.parameters !== undefined) patch.parametersJson = input.parameters
    if (input.cron !== undefined) patch.cron = input.cron
    if (input.timezone !== undefined) patch.timezone = input.timezone
    if (input.recurring !== undefined) patch.recurring = input.recurring
    if (input.enabled !== undefined) patch.enabled = input.enabled
    if (input.status !== undefined) patch.status = input.status
    if (input.nextFireAt !== undefined) patch.nextFireAt = input.nextFireAt ? new Date(input.nextFireAt) : null
    if (input.lastFiredAt !== undefined) patch.lastFiredAt = input.lastFiredAt ? new Date(input.lastFiredAt) : null
    if (input.lastRunId !== undefined) patch.lastRunId = input.lastRunId
    if (input.queueJobId !== undefined) patch.queueJobId = input.queueJobId
    if (input.failureCount !== undefined) patch.failureCount = input.failureCount
    if (input.lastErrorMessage !== undefined) patch.lastErrorMessage = input.lastErrorMessage
    const rows = await this.db
      .update(platformScheduledTasks)
      .set(patch)
      .where(eq(platformScheduledTasks.taskId, taskId))
      .returning()
    const row = rows[0]
    if (!row) throw new Error(`定时任务 '${taskId}' 不存在。`)
    return mapScheduledTaskRow(row)
  }

  async markScheduledTaskDeleted(taskId: string): Promise<ScheduledTask> {
    return this.updateScheduledTask(taskId, { enabled: false, status: 'deleted', nextFireAt: null })
  }
}

function mapScheduledTaskRow(row: ScheduledTaskRow): ScheduledTask {
  return scheduledTaskSchema.parse({
    taskId: row.taskId,
    targetKind: row.targetKind,
    targetId: row.targetId,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    title: row.title,
    prompt: row.prompt,
    parameters: row.parametersJson,
    cron: row.cron,
    timezone: row.timezone,
    recurring: row.recurring,
    enabled: row.enabled,
    status: row.status,
    lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
    nextFireAt: row.nextFireAt?.toISOString() ?? null,
    lastRunId: row.lastRunId,
    queueJobId: row.queueJobId,
    failureCount: row.failureCount,
    lastErrorMessage: row.lastErrorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

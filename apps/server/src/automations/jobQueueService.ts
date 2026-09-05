// +-------------------------------------------------------------------------
//
//   地理智能平台 - pg-boss 任务队列适配层
//
//   文件:       jobQueueService.ts
//
//   日期:       2026年07月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { PgBoss, type Job } from 'pg-boss'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Env } from '../framework/env.js'
import { errorLogPayload, logger } from '../observability/logger.js'

const AUTOMATION_QUEUE_NAME = 'geo-agent-platform.automation.run'

export const automationJobPayloadSchema = z.object({
  scheduledTaskId: z.string().min(1).nullable().default(null),
  automationRunId: z.string().min(1).nullable().default(null),
  automationId: z.string().min(1),
  workspaceId: z.string().min(1),
  triggeredByUserId: z.string().min(1),
  triggerKind: z.enum(['manual', 'schedule']),
  dispatchId: z.string().min(1),
  prompt: z.string().default(''),
  parameters: z.record(z.string(), z.unknown()).prefault({}),
})

export type AutomationJobPayload = z.infer<typeof automationJobPayloadSchema>

export type AutomationJobHandler = (payload: AutomationJobPayload, queueJobId: string) => Promise<void>

export class JobQueueService {
  private readonly boss: PgBoss
  private started = false

  constructor(env: Env) {
    this.boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      schema: 'pgboss',
      application_name: 'geo-agent-platform-automation-queue',
      schedule: true,
      migrate: true,
      createSchema: true,
      supervise: true,
      monitorIntervalSeconds: 60,
      maintenanceIntervalSeconds: 60,
      connectionTimeoutMillis: 5_000,
    })
    this.boss.on('error', error => {
      logger.error({ error: errorLogPayload(error) }, 'automation queue error')
    })
    this.boss.on('warning', warning => {
      logger.warn({ warning }, 'automation queue warning')
    })
  }

  async start(handler: AutomationJobHandler): Promise<void> {
    if (this.started) return
    await this.boss.start()
    await this.boss.createQueue(AUTOMATION_QUEUE_NAME, {
      retryLimit: 2,
      retryBackoff: true,
      expireInSeconds: 1800,
      retentionSeconds: 14 * 24 * 60 * 60,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
    })
    await this.boss.work<AutomationJobPayload>(AUTOMATION_QUEUE_NAME, { batchSize: 1 }, async jobs => {
      for (const job of jobs) {
        await this.handleJob(job, handler)
      }
    })
    this.started = true
  }

  async stop(): Promise<void> {
    if (!this.started) return
    await this.boss.stop({ graceful: true, timeout: 10_000 })
    this.started = false
  }

  async enqueueAutomationRun(payload: AutomationJobPayload, queueJobId: string): Promise<string> {
    const normalized = automationJobPayloadSchema.parse(payload)
    const normalizedQueueJobId = z.string().uuid().parse(queueJobId)
    try {
      const jobId = await this.boss.send(AUTOMATION_QUEUE_NAME, normalized, {
        id: normalizedQueueJobId,
        singletonKey: normalized.dispatchId,
        retryLimit: 2,
        retryBackoff: true,
      })
      if (jobId) return jobId
    } catch (error) {
      const existing = await this.requireMatchingDispatch(normalizedQueueJobId, normalized)
      if (existing) return existing
      throw error
    }
    const existing = await this.requireMatchingDispatch(normalizedQueueJobId, normalized)
    if (existing) return existing
    throw new Error('自动化流程任务入队失败。')
  }

  async cancelAutomationJob(jobId: string): Promise<void> {
    await this.boss.cancel(AUTOMATION_QUEUE_NAME, jobId)
  }

  async scheduleTask(input: {
    taskId: string
    cron: string
    timezone: string
    recurring: boolean
    nextFireAt: string
    payload: AutomationJobPayload
  }): Promise<string | null> {
    await this.boss.unschedule(AUTOMATION_QUEUE_NAME, input.taskId)
    if (!input.recurring) {
      const jobId = await this.boss.send(AUTOMATION_QUEUE_NAME, input.payload, {
        singletonKey: `one-shot:${input.taskId}`,
        startAfter: new Date(input.nextFireAt),
        retryLimit: 2,
        retryBackoff: true,
      })
      if (!jobId) throw new Error('一次性定时任务入队失败。')
      return jobId
    }
    await this.boss.schedule(AUTOMATION_QUEUE_NAME, input.cron, input.payload, {
      key: input.taskId,
      tz: input.timezone,
      singletonKey: input.taskId,
      retryLimit: 2,
      retryBackoff: true,
    })
    return null
  }

  async unscheduleTask(taskId: string, queueJobId?: string | null): Promise<void> {
    await this.boss.unschedule(AUTOMATION_QUEUE_NAME, taskId)
    if (queueJobId) await this.boss.cancel(AUTOMATION_QUEUE_NAME, queueJobId)
  }

  private async handleJob(job: Job<AutomationJobPayload>, handler: AutomationJobHandler): Promise<void> {
    const payload = automationJobPayloadSchema.parse(job.data)
    await handler(payload, job.id)
  }

  private async requireMatchingDispatch(
    queueJobId: string,
    payload: AutomationJobPayload,
  ): Promise<string | null> {
    const existing = await this.boss.getJobById<AutomationJobPayload>(AUTOMATION_QUEUE_NAME, queueJobId)
    if (!existing) return null
    const existingPayload = automationJobPayloadSchema.parse(existing.data)
    if (!isDeepStrictEqual(existingPayload, payload)) {
      throw new Error(`队列任务 '${queueJobId}' 已存在，但载荷与 Automation dispatch 不一致。`)
    }
    if (existing.state === 'completed' || existing.state === 'cancelled' || existing.state === 'failed') {
      throw new Error(`队列任务 '${queueJobId}' 已处于 ${existing.state}，不能作为待分发任务恢复。`)
    }
    return existing.id
  }
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostgreSQL StepContext 不可变记录仓储
//
//   文件:       AgentStepContextRepository.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { desc, eq } from 'drizzle-orm'
import {
  agentStepContextSchema,
  type AgentStepContext,
} from '@geo-agent-platform/shared-types/agent-step-context'

import type { Database } from '../../db/connection.js'
import { platformAgentStepContexts, platformRuns } from '../../db/schema.js'
import { agentContextDigest } from './agentContextDigest.js'

export class AgentStepContextRepository {
  constructor(private readonly db: Database) {}

  async appendNext(
    runId: string,
    build: (modelRequestIndex: number) => AgentStepContext,
  ): Promise<AgentStepContext> {
    return this.db.transaction(async tx => {
      const runRows = await tx.select({ runId: platformRuns.runId })
        .from(platformRuns)
        .where(eq(platformRuns.runId, runId))
        .for('update')
        .limit(1)
      if (!runRows[0]) throw new Error(`运行 '${runId}' 不存在`)
      const latest = await tx.select({
        modelRequestIndex: platformAgentStepContexts.modelRequestIndex,
      }).from(platformAgentStepContexts)
        .where(eq(platformAgentStepContexts.runId, runId))
        .orderBy(desc(platformAgentStepContexts.modelRequestIndex))
        .limit(1)
      const modelRequestIndex = (latest[0]?.modelRequestIndex ?? 0) + 1
      const context = agentStepContextSchema.parse(build(modelRequestIndex))
      if (context.runId !== runId) throw new Error(`StepContext '${context.identity.stepId}' 不属于 run '${runId}'`)
      if (context.identity.modelRequestIndex !== modelRequestIndex) {
        throw new Error(
          `StepContext '${context.identity.stepId}' request index 不一致：`
          + `期望 ${modelRequestIndex}，实际 ${context.identity.modelRequestIndex}`,
        )
      }
      verifyContextDigest(context)
      await tx.insert(platformAgentStepContexts).values({
        stepId: context.identity.stepId,
        runId: context.runId,
        turnId: context.turnId,
        segmentId: context.identity.segmentId,
        modelRequestIndex: context.identity.modelRequestIndex,
        objectiveRevision: context.objectiveRevision,
        inputCursor: context.inputCursor,
        worldRevision: context.worldRevision,
        runtimeConfigDigest: context.runtimeConfigDigest,
        toolPlanDigest: context.toolPlanDigest,
        contextDigest: context.contextDigest,
        contextJson: context,
        createdAt: new Date(context.capturedAt),
      })
      return deepFreeze(structuredClone(context))
    })
  }

  async list(runId: string): Promise<AgentStepContext[]> {
    const rows = await this.db.select().from(platformAgentStepContexts)
      .where(eq(platformAgentStepContexts.runId, runId))
      .orderBy(platformAgentStepContexts.modelRequestIndex)
    return rows.map(row => mapContextRow(row))
  }

  async get(stepId: string): Promise<AgentStepContext | null> {
    const rows = await this.db.select().from(platformAgentStepContexts)
      .where(eq(platformAgentStepContexts.stepId, stepId))
      .limit(1)
    return rows[0] ? mapContextRow(rows[0]) : null
  }
}

function mapContextRow(
  row: typeof platformAgentStepContexts.$inferSelect,
): AgentStepContext {
  const context = agentStepContextSchema.parse(row.contextJson)
  if (
    context.identity.stepId !== row.stepId
    || context.runId !== row.runId
    || context.turnId !== row.turnId
    || context.identity.segmentId !== row.segmentId
    || context.identity.modelRequestIndex !== row.modelRequestIndex
    || context.objectiveRevision !== row.objectiveRevision
    || context.inputCursor !== row.inputCursor
    || context.worldRevision !== row.worldRevision
    || context.runtimeConfigDigest !== row.runtimeConfigDigest
    || context.toolPlanDigest !== row.toolPlanDigest
    || context.contextDigest !== row.contextDigest
    || context.capturedAt !== row.createdAt.toISOString()
  ) {
    throw new Error(`StepContext '${row.stepId}' 行与 context_json 不一致`)
  }
  verifyContextDigest(context)
  return deepFreeze(structuredClone(context))
}

function verifyContextDigest(context: AgentStepContext): void {
  const { contextDigest, ...contextWithoutDigest } = context
  if (agentContextDigest(contextWithoutDigest) !== contextDigest) {
    throw new Error(`StepContext '${context.identity.stepId}' context_digest 校验失败`)
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

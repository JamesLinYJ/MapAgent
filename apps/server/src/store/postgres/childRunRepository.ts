// +-------------------------------------------------------------------------
//
//   地理智能平台 - 持久子运行预算与智能体邮箱仓储
//
//   文件:       childRunRepository.ts
//
//   日期:       2026年08月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  agentMessageSchema,
  childRunDescriptorSchema,
  rootRunBudgetSchema,
  type AgentMessage,
  type AgentMessageKind,
  type ChildRunDescriptor,
  type RootRunBudget,
} from '@geo-agent-platform/shared-types/child-run'
import { and, asc, eq, inArray } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { runDomainSnapshotSchema, type RunDomainSnapshot } from '../../schemas/types.js'
import {
  platformAgentMessages,
  platformRootRunBudgets,
  platformRuns,
  platformRunSnapshots,
} from '../../db/schema.js'

export interface AppendAgentMessageInput {
  messageId: string
  senderRunId: string
  receiverRunId: string
  parentTurnId: string
  rootTurnId: string
  kind: AgentMessageKind
  content: string
  triggerTurn: boolean
}

export interface RootRunBudgetLimits {
  maxConcurrentChildren: number
  maxSpawnDepth: number
  maxTotalChildren: number
  maxTotalModelTokens: number | null
  maxWallClockMs: number | null
}

/** 只拥有 child identity 查询、根预算计数和跨 Run mailbox 状态机。 */
export class PostgresChildRunRepository {
  constructor(private readonly db: Database) {}

  async getDescriptor(runId: string): Promise<ChildRunDescriptor | null> {
    const rows = await this.selectChildRuns()
      .where(and(eq(platformRuns.runId, runId), eq(platformRuns.runKind, 'child')))
      .limit(1)
    return rows[0] ? mapChildRun(rows[0].run, requireSnapshot(rows[0])) : null
  }

  async findBySpawn(parentRunId: string, spawnCallId: string): Promise<ChildRunDescriptor | null> {
    const rows = await this.selectChildRuns().where(and(
      eq(platformRuns.parentRunId, parentRunId),
      eq(platformRuns.spawnCallId, spawnCallId),
      eq(platformRuns.runKind, 'child'),
    )).limit(1)
    return rows[0] ? mapChildRun(rows[0].run, requireSnapshot(rows[0])) : null
  }

  async listChildren(parentRunId: string): Promise<ChildRunDescriptor[]> {
    const rows = await this.selectChildRuns().where(and(
      eq(platformRuns.parentRunId, parentRunId),
      eq(platformRuns.runKind, 'child'),
    )).orderBy(asc(platformRuns.createdAt), asc(platformRuns.runId))
    return rows.map(row => mapChildRun(row.run, requireSnapshot(row)))
  }

  async listDescendants(rootRunId: string): Promise<ChildRunDescriptor[]> {
    const rows = await this.selectChildRuns().where(and(
      eq(platformRuns.rootRunId, rootRunId),
      eq(platformRuns.runKind, 'child'),
    )).orderBy(asc(platformRuns.spawnDepth), asc(platformRuns.createdAt), asc(platformRuns.runId))
    return rows.map(row => mapChildRun(row.run, requireSnapshot(row)))
  }

  async listTerminalChildren(): Promise<ChildRunDescriptor[]> {
    const rows = await this.selectChildRuns().where(eq(platformRuns.runKind, 'child'))
      .orderBy(asc(platformRuns.updatedAt), asc(platformRuns.runId))
    const terminal = new Set(['completed', 'failed', 'cancelled', 'requires_action'])
    return rows
      .map(row => mapChildRun(row.run, requireSnapshot(row)))
      .filter(run => terminal.has(run.status))
  }

  async getRootBudget(rootRunId: string): Promise<RootRunBudget> {
    const rows = await this.db.select().from(platformRootRunBudgets)
      .where(eq(platformRootRunBudgets.rootRunId, rootRunId)).limit(1)
    const row = rows[0]
    if (!row) throw new Error(`根运行 '${rootRunId}' 缺少根预算`)
    return mapRootBudget(row)
  }

  async configureRootBudget(rootRunId: string, limits: RootRunBudgetLimits): Promise<RootRunBudget> {
    return this.db.transaction(async tx => {
      const rows = await tx.select().from(platformRootRunBudgets)
        .where(eq(platformRootRunBudgets.rootRunId, rootRunId)).for('update').limit(1)
      const current = rows[0]
      if (!current) throw new Error(`根运行 '${rootRunId}' 缺少根预算`)
      if (current.totalChildren > limits.maxTotalChildren) throw new Error('新累计 child 预算小于已生成数量')
      if (current.activeChildren > limits.maxConcurrentChildren) throw new Error('新并发 child 预算小于活动数量')
      if (current.usedModelTokens > (limits.maxTotalModelTokens ?? Number.MAX_SAFE_INTEGER)) {
        throw new Error('新模型词元预算小于已使用数量')
      }
      const updated = await tx.update(platformRootRunBudgets).set({
        ...limits,
        version: current.version + 1,
        updatedAt: new Date(),
      }).where(and(
        eq(platformRootRunBudgets.rootRunId, rootRunId),
        eq(platformRootRunBudgets.version, current.version),
      )).returning()
      if (!updated[0]) throw new Error(`根运行 '${rootRunId}' 的预算配置 CAS 冲突`)
      return mapRootBudget(updated[0])
    })
  }

  async appendMessage(input: AppendAgentMessageInput): Promise<AgentMessage> {
    const content = input.content.trim()
    if (!content) throw new Error('智能体消息内容不能为空')
    return this.db.transaction(async tx => {
      const existingRows = await tx.select().from(platformAgentMessages)
        .where(eq(platformAgentMessages.messageId, input.messageId)).limit(1)
      const existing = existingRows[0]
      if (existing) {
        const message = mapAgentMessage(existing)
        if (!sameMessageRequest(message, { ...input, content })) {
          throw new Error(`智能体消息 '${input.messageId}' 已用于不同请求`)
        }
        return message
      }
      const runRows = await tx.select().from(platformRuns)
        .where(inArray(platformRuns.runId, [input.senderRunId, input.receiverRunId]))
        .orderBy(asc(platformRuns.runId)).for('update')
      const sender = runRows.find(row => row.runId === input.senderRunId)
      const receiver = runRows.find(row => row.runId === input.receiverRunId)
      if (!sender || !receiver) throw new Error('智能体消息的发送或接收运行不存在')
      if (sender.runId === receiver.runId) throw new Error('智能体消息不能发送给自身')
      if (sender.rootRunId !== receiver.rootRunId) throw new Error('智能体消息不能跨根运行发送')
      const expectedRootTurnId = sender.runKind === 'child' ? sender.rootTurnId : receiver.rootTurnId
      if (!expectedRootTurnId || expectedRootTurnId !== input.rootTurnId) {
        throw new Error('智能体消息的 rootTurnId 与持久 child 身份不一致')
      }
      const sequence = receiver.nextAgentMessageSequence
      const createdAt = new Date()
      const insertedRows = await tx.insert(platformAgentMessages).values({
        ...input,
        rootRunId: sender.rootRunId,
        content,
        sequence,
        status: 'queued',
        createdAt,
      }).returning()
      const inserted = insertedRows[0]
      if (!inserted) throw new Error(`智能体消息 '${input.messageId}' 写入失败`)
      const claimed = await tx.update(platformRuns).set({
        nextAgentMessageSequence: sequence + 1,
        updatedAt: createdAt,
      }).where(and(
        eq(platformRuns.runId, receiver.runId),
        eq(platformRuns.nextAgentMessageSequence, sequence),
      )).returning()
      if (!claimed[0]) throw new Error(`运行 '${receiver.runId}' 的智能体邮箱序号 CAS 失败`)
      return mapAgentMessage(inserted)
    })
  }

  async listMessages(receiverRunId: string): Promise<AgentMessage[]> {
    const rows = await this.db.select().from(platformAgentMessages)
      .where(eq(platformAgentMessages.receiverRunId, receiverRunId))
      .orderBy(asc(platformAgentMessages.sequence))
    return rows.map(mapAgentMessage)
  }

  async markMessageDelivered(receiverRunId: string, messageId: string): Promise<AgentMessage> {
    return this.db.transaction(async tx => {
      const rows = await tx.select().from(platformAgentMessages).where(and(
        eq(platformAgentMessages.receiverRunId, receiverRunId),
        eq(platformAgentMessages.messageId, messageId),
      )).for('update').limit(1)
      const current = rows[0]
      if (!current) throw new Error(`智能体消息 '${messageId}' 不存在`)
      if (current.status === 'delivered' || current.status === 'checkpointed') {
        return mapAgentMessage(current)
      }
      const updated = await tx.update(platformAgentMessages).set({
        status: 'delivered',
        deliveredAt: new Date(),
      }).where(and(
        eq(platformAgentMessages.messageId, messageId),
        eq(platformAgentMessages.status, 'queued'),
      )).returning()
      if (!updated[0]) throw new Error(`智能体消息 '${messageId}' 的交付状态 CAS 冲突`)
      return mapAgentMessage(updated[0])
    })
  }

  async deliverQueuedMessages(receiverRunId: string): Promise<AgentMessage[]> {
    return this.db.transaction(async tx => {
      const receiverRows = await tx.select().from(platformRuns)
        .where(eq(platformRuns.runId, receiverRunId)).for('update').limit(1)
      if (!receiverRows[0]) throw new Error(`运行 '${receiverRunId}' 不存在`)
      const queued = await tx.select().from(platformAgentMessages).where(and(
        eq(platformAgentMessages.receiverRunId, receiverRunId),
        eq(platformAgentMessages.status, 'queued'),
      )).orderBy(asc(platformAgentMessages.sequence)).for('update')
      if (!queued.length) return []
      const deliveredAt = new Date()
      const updated = await tx.update(platformAgentMessages).set({
        status: 'delivered',
        deliveredAt,
      }).where(inArray(platformAgentMessages.messageId, queued.map(message => message.messageId)))
        .returning()
      updated.sort((left, right) => left.sequence - right.sequence)
      return updated.map(mapAgentMessage)
    })
  }

  async checkpointMessages(receiverRunId: string, messageIds: readonly string[]): Promise<AgentMessage[]> {
    if (!messageIds.length) return []
    return this.db.transaction(async tx => {
      const rows = await tx.select().from(platformAgentMessages).where(and(
        eq(platformAgentMessages.receiverRunId, receiverRunId),
        inArray(platformAgentMessages.messageId, [...messageIds]),
      )).orderBy(asc(platformAgentMessages.sequence)).for('update')
      if (rows.length !== new Set(messageIds).size) throw new Error('待 checkpoint 的智能体消息不完整')
      if (rows.some(message => message.status !== 'delivered')) {
        throw new Error('只有 delivered 智能体消息可以 checkpoint')
      }
      const checkpointedAt = new Date()
      const updated = await tx.update(platformAgentMessages).set({
        status: 'checkpointed',
        checkpointedAt,
      }).where(inArray(platformAgentMessages.messageId, [...messageIds])).returning()
      updated.sort((left, right) => left.sequence - right.sequence)
      return updated.map(mapAgentMessage)
    })
  }

  async checkpointDeliveredMessages(receiverRunId: string): Promise<AgentMessage[]> {
    const delivered = (await this.listMessages(receiverRunId))
      .filter(message => message.status === 'delivered')
    return this.checkpointMessages(receiverRunId, delivered.map(message => message.messageId))
  }

  private selectChildRuns() {
    return this.db.select({ run: platformRuns, snapshot: platformRunSnapshots })
      .from(platformRuns)
      .leftJoin(platformRunSnapshots, eq(platformRunSnapshots.runId, platformRuns.runId))
  }
}

function mapChildRun(
  row: typeof platformRuns.$inferSelect,
  snapshot: RunDomainSnapshot,
): ChildRunDescriptor {
  return childRunDescriptorSchema.parse({
    runId: row.runId,
    rootRunId: row.rootRunId,
    parentRunId: row.parentRunId,
    parentTurnId: row.parentTurnId,
    rootTurnId: row.rootTurnId,
    spawnCallId: row.spawnCallId,
    agentPath: row.agentPath,
    taskName: row.taskName,
    role: row.agentRole,
    status: snapshot.status,
    spawnDepth: row.spawnDepth,
    forkMode: row.forkMode,
    forkTurnCount: row.forkTurnCount,
    modelOverride: row.modelOverride,
    reasoningOverride: row.reasoningOverride,
    budget: {
      maxModelTokens: row.maxModelTokens,
      maxWallClockMs: row.maxWallClockMs,
      usedModelTokens: row.usedModelTokens,
      startedAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

function requireSnapshot(row: {
  run: typeof platformRuns.$inferSelect
  snapshot: typeof platformRunSnapshots.$inferSelect | null
}): RunDomainSnapshot {
  if (!row.snapshot) throw new Error(`运行 '${row.run.runId}' 缺少权威 snapshot`)
  return runDomainSnapshotSchema.parse(row.snapshot.stateJson)
}

function mapRootBudget(row: typeof platformRootRunBudgets.$inferSelect): RootRunBudget {
  return rootRunBudgetSchema.parse({
    rootRunId: row.rootRunId,
    maxConcurrentChildren: row.maxConcurrentChildren,
    maxSpawnDepth: row.maxSpawnDepth,
    maxTotalChildren: row.maxTotalChildren,
    maxTotalModelTokens: row.maxTotalModelTokens,
    maxWallClockMs: row.maxWallClockMs,
    totalChildren: row.totalChildren,
    activeChildren: row.activeChildren,
    usedModelTokens: row.usedModelTokens,
    version: row.version,
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

function mapAgentMessage(row: typeof platformAgentMessages.$inferSelect): AgentMessage {
  return agentMessageSchema.parse({
    messageId: row.messageId,
    rootRunId: row.rootRunId,
    senderRunId: row.senderRunId,
    receiverRunId: row.receiverRunId,
    parentTurnId: row.parentTurnId,
    rootTurnId: row.rootTurnId,
    sequence: row.sequence,
    kind: row.kind,
    content: row.content,
    triggerTurn: row.triggerTurn,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    checkpointedAt: row.checkpointedAt?.toISOString() ?? null,
  })
}

function sameMessageRequest(message: AgentMessage, input: AppendAgentMessageInput): boolean {
  return message.senderRunId === input.senderRunId
    && message.receiverRunId === input.receiverRunId
    && message.parentTurnId === input.parentTurnId
    && message.rootTurnId === input.rootTurnId
    && message.kind === input.kind
    && message.content === input.content
    && message.triggerTurn === input.triggerTurn
}

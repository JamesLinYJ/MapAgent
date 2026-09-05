// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 定义版本仓储
//
//   文件:       automationDefinitionRepository.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { isDeepStrictEqual } from 'node:util'
import { and, desc, eq, ne, or } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { platformAutomationDefinitions, platformAutomationVersions } from '../../db/schema.js'
import {
  automationDefinitionSchema,
  type AutomationDefinition,
  type AutomationVersionRecord,
} from '../../automations/schemas.js'

type AutomationDefinitionRow = typeof platformAutomationDefinitions.$inferSelect
type AutomationVersionRow = typeof platformAutomationVersions.$inferSelect

/** Automation 定义头与不可变修订快照的唯一写入边界。 */
export class AutomationDefinitionRepository {
  constructor(private readonly db: Database) {}

  async syncDefinitions(definitions: AutomationDefinition[]): Promise<void> {
    await this.db.transaction(async tx => {
      for (const definition of definitions) {
        const now = new Date()
        const headRows = await tx
          .select({
            revision: platformAutomationDefinitions.revision,
            source: platformAutomationDefinitions.source,
          })
          .from(platformAutomationDefinitions)
          .where(eq(platformAutomationDefinitions.automationId, definition.automationId))
          .limit(1)
        const head = headRows[0]
        if (head?.source && head.source !== 'builtin') {
          throw new Error(`内置 Automation '${definition.automationId}' 与工作区定义 ID 冲突。`)
        }
        if (head && head.revision > definition.revision) {
          throw new Error(`内置 Automation '${definition.automationId}' 的 revision 不能从 ${head.revision} 回退到 ${definition.revision}。`)
        }
        const versionRows = await tx
          .select({ definitionJson: platformAutomationVersions.definitionJson })
          .from(platformAutomationVersions)
          .where(and(
            eq(platformAutomationVersions.automationId, definition.automationId),
            eq(platformAutomationVersions.revision, definition.revision),
          ))
          .limit(1)
        const existingVersion = versionRows[0]
        if (existingVersion && !isDeepStrictEqual(
          automationDefinitionSchema.parse(existingVersion.definitionJson),
          definition,
        )) {
          throw new Error(`内置 Automation '${definition.automationId}' 修订 ${definition.revision} 的内容已变化；必须提升 revision，不能覆盖不可变快照。`)
        }
        await tx
          .insert(platformAutomationDefinitions)
          .values(definitionInsert(definition, now))
          .onConflictDoUpdate({
            target: platformAutomationDefinitions.automationId,
            set: { ...definitionUpdate(definition, now), publishedRevision: definition.revision },
          })
        if (!existingVersion) {
          await tx
            .update(platformAutomationVersions)
            .set({ lifecycle: 'archived' })
            .where(and(
              eq(platformAutomationVersions.automationId, definition.automationId),
              eq(platformAutomationVersions.lifecycle, 'published'),
              ne(platformAutomationVersions.revision, definition.revision),
            ))
          await tx.insert(platformAutomationVersions).values({
              automationId: definition.automationId,
              revision: definition.revision,
              lifecycle: 'published',
              definitionJson: definitionRecord(definition),
              createdByUserId: definition.createdByUserId,
              createdAt: now,
              publishedAt: now,
            })
        }
      }
    })
  }

  async listDefinitions(workspaceId: string): Promise<AutomationDefinition[]> {
    const rows = await this.db
      .select()
      .from(platformAutomationDefinitions)
      .where(or(
        eq(platformAutomationDefinitions.source, 'builtin'),
        eq(platformAutomationDefinitions.workspaceId, workspaceId),
      ))
      .orderBy(platformAutomationDefinitions.name)
    return rows.map(mapDefinitionRow)
  }

  async getDefinition(automationId: string): Promise<AutomationDefinition | null> {
    const rows = await this.db
      .select()
      .from(platformAutomationDefinitions)
      .where(eq(platformAutomationDefinitions.automationId, automationId))
      .limit(1)
    const row = rows[0]
    return row ? mapDefinitionRow(row) : null
  }

  async getDefinitionVersion(automationId: string, revision: number): Promise<AutomationDefinition | null> {
    const rows = await this.db
      .select()
      .from(platformAutomationVersions)
      .where(and(
        eq(platformAutomationVersions.automationId, automationId),
        eq(platformAutomationVersions.revision, revision),
      ))
      .limit(1)
    const row = rows[0]
    return row ? automationDefinitionSchema.parse(row.definitionJson) : null
  }

  async getPublishedDefinition(automationId: string): Promise<AutomationDefinition | null> {
    const rows = await this.db
      .select({
        publishedRevision: platformAutomationDefinitions.publishedRevision,
        enabled: platformAutomationDefinitions.enabled,
        lifecycle: platformAutomationDefinitions.lifecycle,
      })
      .from(platformAutomationDefinitions)
      .where(eq(platformAutomationDefinitions.automationId, automationId))
      .limit(1)
    const head = rows[0]
    if (!head?.enabled || head.lifecycle === 'disabled') return null
    return head.publishedRevision
      ? this.getDefinitionVersion(automationId, head.publishedRevision)
      : null
  }

  async listDefinitionVersions(automationId: string): Promise<AutomationVersionRecord[]> {
    const rows = await this.db
      .select()
      .from(platformAutomationVersions)
      .where(eq(platformAutomationVersions.automationId, automationId))
      .orderBy(desc(platformAutomationVersions.revision))
    return rows.map(mapVersionRow)
  }

  async createDefinition(definition: AutomationDefinition): Promise<AutomationDefinition> {
    const now = new Date()
    await this.db.transaction(async tx => {
      await tx.insert(platformAutomationDefinitions).values(definitionInsert(definition, now))
      await tx.insert(platformAutomationVersions).values({
        automationId: definition.automationId,
        revision: definition.revision,
        lifecycle: definition.lifecycle === 'published' ? 'published' : 'draft',
        definitionJson: definitionRecord(definition),
        createdByUserId: definition.createdByUserId,
        createdAt: now,
        publishedAt: definition.lifecycle === 'published' ? now : null,
      })
    })
    const stored = await this.getDefinition(definition.automationId)
    if (!stored) throw new Error('Automation 创建后无法读取。')
    return stored
  }

  async saveDefinitionRevision(
    definition: AutomationDefinition,
    expectedRevision: number,
  ): Promise<AutomationDefinition> {
    if (definition.revision !== expectedRevision + 1) {
      throw new Error('Automation 新修订号必须连续递增。')
    }
    const now = new Date()
    await this.db.transaction(async tx => {
      const updated = await tx
        .update(platformAutomationDefinitions)
        .set(definitionUpdate(definition, now))
        .where(and(
          eq(platformAutomationDefinitions.automationId, definition.automationId),
          eq(platformAutomationDefinitions.revision, expectedRevision),
          eq(platformAutomationDefinitions.source, 'workspace'),
        ))
        .returning({ automationId: platformAutomationDefinitions.automationId })
      if (!updated[0]) throw new Error('Automation 已被其他编辑更新，请刷新后再保存。')
      await tx.insert(platformAutomationVersions).values({
        automationId: definition.automationId,
        revision: definition.revision,
        lifecycle: 'draft',
        definitionJson: definitionRecord(definition),
        createdByUserId: definition.createdByUserId,
        createdAt: now,
        publishedAt: null,
      })
    })
    const stored = await this.getDefinition(definition.automationId)
    if (!stored) throw new Error('Automation 保存后无法读取。')
    return stored
  }

  async publishDefinition(automationId: string, revision: number): Promise<AutomationDefinition> {
    const now = new Date()
    await this.db.transaction(async tx => {
      const headRows = await tx
        .select()
        .from(platformAutomationDefinitions)
        .where(and(
          eq(platformAutomationDefinitions.automationId, automationId),
          eq(platformAutomationDefinitions.source, 'workspace'),
        ))
        .limit(1)
      const head = headRows[0]
      if (!head) throw new Error(`工作区 Automation '${automationId}' 不存在。`)
      const versionRows = await tx
        .select()
        .from(platformAutomationVersions)
        .where(and(
          eq(platformAutomationVersions.automationId, automationId),
          eq(platformAutomationVersions.revision, revision),
        ))
        .limit(1)
      const version = versionRows[0]
      if (!version) throw new Error(`Automation '${automationId}' 修订 ${revision} 不存在。`)
      const definition = automationDefinitionSchema.parse(version.definitionJson)
      const publishedDefinition: AutomationDefinition = {
        ...definition,
        revision,
        publishedRevision: revision,
        lifecycle: 'published',
        enabled: true,
        updatedAt: now.toISOString(),
      }
      await tx
        .update(platformAutomationVersions)
        .set({ lifecycle: 'archived' })
        .where(and(
          eq(platformAutomationVersions.automationId, automationId),
          eq(platformAutomationVersions.lifecycle, 'published'),
        ))
      await tx
        .update(platformAutomationVersions)
        .set({
          lifecycle: 'published',
          definitionJson: definitionRecord(publishedDefinition),
          publishedAt: now,
        })
        .where(and(
          eq(platformAutomationVersions.automationId, automationId),
          eq(platformAutomationVersions.revision, revision),
        ))
      const nextHead = head.revision === revision
        ? publishedDefinition
        : automationDefinitionSchema.parse({
          ...automationDefinitionSchema.parse(head.definitionJson),
          publishedRevision: revision,
          lifecycle: 'draft',
          enabled: true,
          updatedAt: now.toISOString(),
        })
      await tx
        .update(platformAutomationDefinitions)
        .set({ ...definitionUpdate(nextHead, now), publishedRevision: revision })
        .where(and(
          eq(platformAutomationDefinitions.automationId, automationId),
          eq(platformAutomationDefinitions.revision, head.revision),
          eq(platformAutomationDefinitions.source, 'workspace'),
        ))
    })
    const stored = await this.getDefinition(automationId)
    if (!stored) throw new Error(`Automation '${automationId}' 发布后无法读取。`)
    return stored
  }

  async disableDefinition(automationId: string): Promise<AutomationDefinition> {
    const rows = await this.db
      .update(platformAutomationDefinitions)
      .set({ lifecycle: 'disabled', enabled: false, updatedAt: new Date() })
      .where(and(
        eq(platformAutomationDefinitions.automationId, automationId),
        eq(platformAutomationDefinitions.source, 'workspace'),
      ))
      .returning()
    const row = rows[0]
    if (!row) throw new Error(`工作区 Automation '${automationId}' 不存在。`)
    return mapDefinitionRow(row)
  }
}

function definitionInsert(
  definition: AutomationDefinition,
  now: Date,
): typeof platformAutomationDefinitions.$inferInsert {
  return {
    automationId: definition.automationId,
    workspaceId: definition.workspaceId,
    createdByUserId: definition.createdByUserId,
    name: definition.name,
    description: definition.description,
    version: definition.version,
    revision: definition.revision,
    publishedRevision: definition.lifecycle === 'published' ? definition.revision : null,
    source: definition.source,
    lifecycle: definition.lifecycle,
    enabled: definition.enabled,
    parametersSchemaJson: definition.parametersSchema,
    defaultParametersJson: definition.defaultParameters,
    requiredToolsJson: definition.requiredTools,
    requiresApproval: definition.requiresApproval,
    timeoutSeconds: definition.timeoutSeconds,
    outputType: definition.outputType,
    definitionJson: definitionRecord(definition),
    createdAt: now,
    updatedAt: now,
  }
}

function definitionUpdate(
  definition: AutomationDefinition,
  now: Date,
): Partial<typeof platformAutomationDefinitions.$inferInsert> {
  return {
    workspaceId: definition.workspaceId,
    createdByUserId: definition.createdByUserId,
    name: definition.name,
    description: definition.description,
    version: definition.version,
    revision: definition.revision,
    source: definition.source,
    lifecycle: definition.lifecycle,
    enabled: definition.enabled,
    parametersSchemaJson: definition.parametersSchema,
    defaultParametersJson: definition.defaultParameters,
    requiredToolsJson: definition.requiredTools,
    requiresApproval: definition.requiresApproval,
    timeoutSeconds: definition.timeoutSeconds,
    outputType: definition.outputType,
    definitionJson: definitionRecord(definition),
    updatedAt: now,
  }
}

function mapDefinitionRow(row: AutomationDefinitionRow): AutomationDefinition {
  const parsed = automationDefinitionSchema.parse(row.definitionJson)
  if (parsed.automationId !== row.automationId || parsed.revision !== row.revision) {
    throw new Error(`Automation '${row.automationId}' 数据库元数据与 definition_json 不一致。`)
  }
  return automationDefinitionSchema.parse({
    ...parsed,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    source: row.source,
    lifecycle: row.lifecycle,
    enabled: row.enabled,
    publishedRevision: row.publishedRevision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

function mapVersionRow(row: AutomationVersionRow): AutomationVersionRecord {
  if (row.lifecycle !== 'draft' && row.lifecycle !== 'published' && row.lifecycle !== 'archived') {
    throw new Error(`Automation 修订 lifecycle '${row.lifecycle}' 无效。`)
  }
  return {
    automationId: row.automationId,
    revision: row.revision,
    lifecycle: row.lifecycle,
    definition: automationDefinitionSchema.parse(row.definitionJson),
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  }
}

function definitionRecord(definition: AutomationDefinition): Record<string, unknown> {
  return structuredClone(definition) as unknown as Record<string, unknown>
}

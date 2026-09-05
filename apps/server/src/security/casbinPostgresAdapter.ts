// +-------------------------------------------------------------------------
//
//   地理智能平台 - Casbin Postgres 策略适配器
//
//   文件:       casbinPostgresAdapter.ts
//
//   日期:       2026年07月02日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { Helper, type Adapter, type Model } from 'casbin'
import { and, asc, eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { Database } from '../db/connection.js'
import { platformRbacPolicies } from '../db/schema.js'

// Casbin 的模型负责执行权限矩阵；Postgres 只保存策略行，
// 让后台管理和审计看到同一份授权事实源。
export class CasbinPostgresAdapter implements Adapter {
  constructor(private readonly db: Database) {}

  async loadPolicy(model: Model): Promise<void> {
    const rows = await this.db
      .select({
        ptype: platformRbacPolicies.ptype,
        v0: platformRbacPolicies.v0,
        v1: platformRbacPolicies.v1,
        v2: platformRbacPolicies.v2,
        v3: platformRbacPolicies.v3,
        v4: platformRbacPolicies.v4,
        v5: platformRbacPolicies.v5,
      })
      .from(platformRbacPolicies)
      .orderBy(
        asc(platformRbacPolicies.ptype),
        asc(platformRbacPolicies.v0),
        asc(platformRbacPolicies.v1),
        asc(platformRbacPolicies.v2),
        asc(platformRbacPolicies.v3),
        asc(platformRbacPolicies.v4),
        asc(platformRbacPolicies.v5),
      )
    for (const row of rows) {
      const fields = [row.ptype, row.v0, row.v1, row.v2, row.v3, row.v4, row.v5]
        .filter(value => typeof value === 'string' && value.length > 0)
        .map(value => String(value))
      if (fields.length) Helper.loadPolicyLine(fields.join(', '), model)
    }
  }

  async savePolicy(model: Model): Promise<boolean> {
    await this.db.transaction(async tx => {
      await tx.delete(platformRbacPolicies)
      for (const [, astMap] of model.model.entries()) {
        for (const [ptype, ast] of astMap.entries()) {
          for (const rule of ast.policy) {
            await tx
              .insert(platformRbacPolicies)
              .values(policyRow(ptype, rule))
              .onConflictDoNothing()
          }
        }
      }
    })
    return true
  }

  async addPolicy(_sec: string, ptype: string, rule: string[]): Promise<void> {
    await this.upsertPolicy(ptype, rule)
  }

  async removePolicy(_sec: string, ptype: string, rule: string[]): Promise<void> {
    const normalized = normalizePolicyRule(rule)
    await this.db
      .delete(platformRbacPolicies)
      .where(and(
        eq(platformRbacPolicies.ptype, ptype),
        eq(platformRbacPolicies.v0, normalized[0]),
        eq(platformRbacPolicies.v1, normalized[1]),
        eq(platformRbacPolicies.v2, normalized[2]),
        eq(platformRbacPolicies.v3, normalized[3]),
        eq(platformRbacPolicies.v4, normalized[4]),
        eq(platformRbacPolicies.v5, normalized[5]),
      ))
  }

  async removeFilteredPolicy(_sec: string, ptype: string, fieldIndex: number, ...fieldValues: string[]): Promise<void> {
    const conditions = [eq(platformRbacPolicies.ptype, ptype)]
    for (const [index, value] of fieldValues.entries()) {
      if (!value) continue
      const column = policyValueColumns[fieldIndex + index]
      if (!column) throw new Error('Casbin 策略过滤字段越界。')
      conditions.push(eq(column, value))
    }
    await this.db.delete(platformRbacPolicies).where(and(...conditions))
  }

  private async upsertPolicy(ptype: string, rule: string[]): Promise<void> {
    await this.db
      .insert(platformRbacPolicies)
      .values(policyRow(ptype, rule))
      .onConflictDoNothing()
  }
}

const policyValueColumns = [
  platformRbacPolicies.v0,
  platformRbacPolicies.v1,
  platformRbacPolicies.v2,
  platformRbacPolicies.v3,
  platformRbacPolicies.v4,
  platformRbacPolicies.v5,
] as const

function policyRow(ptype: string, rule: string[]): typeof platformRbacPolicies.$inferInsert {
  const values = normalizePolicyRule(rule)
  return {
    policyId: policyId(ptype, values),
    ptype,
    v0: values[0],
    v1: values[1],
    v2: values[2],
    v3: values[3],
    v4: values[4],
    v5: values[5],
  }
}

function normalizePolicyRule(rule: string[]): [string, string, string, string, string, string] {
  return [
    rule[0] ?? '',
    rule[1] ?? '',
    rule[2] ?? '',
    rule[3] ?? '',
    rule[4] ?? '',
    rule[5] ?? '',
  ]
}

function policyId(ptype: string, values: readonly string[]): string {
  return `policy_${createHash('sha256').update([ptype, ...values].join('\u001f')).digest('hex').slice(0, 32)}`
}

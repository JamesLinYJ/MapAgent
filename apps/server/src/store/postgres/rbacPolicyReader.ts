// +-------------------------------------------------------------------------
//
//   地理智能平台 - RBAC 策略查询器
//
//   文件:       rbacPolicyReader.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  rbacPolicyRowSchema,
  type RbacPolicyRow,
} from '@geo-agent-platform/shared-types/platform'
import { asc } from 'drizzle-orm'

import type { Database } from '../../db/connection.js'
import { platformRbacPolicies } from '../../db/schema.js'

/** 管理后台只读策略投影；Casbin adapter 仍是策略写入边界。 */
export class RbacPolicyReader {
  constructor(private readonly db: Database) {}

  async list(): Promise<RbacPolicyRow[]> {
    const rows = await this.db.select({
      ptype: platformRbacPolicies.ptype,
      v0: platformRbacPolicies.v0,
      v1: platformRbacPolicies.v1,
      v2: platformRbacPolicies.v2,
      v3: platformRbacPolicies.v3,
      v4: platformRbacPolicies.v4,
      v5: platformRbacPolicies.v5,
    }).from(platformRbacPolicies).orderBy(
      asc(platformRbacPolicies.ptype),
      asc(platformRbacPolicies.v0),
      asc(platformRbacPolicies.v1),
      asc(platformRbacPolicies.v2),
    )
    return rows.map(row => rbacPolicyRowSchema.parse(row))
  }
}

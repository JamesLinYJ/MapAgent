// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostgreSQL GeoWorld CAS 仓储
//
//   文件:       GeoWorldRepository.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { and, asc, desc, eq, gt } from 'drizzle-orm'
import {
  createGeoWorldDiff,
  geoWorldDiffSchema,
  geoWorldStateSchema,
  type GeoWorldDiff,
  type GeoWorldPatch,
  type GeoWorldState,
} from '@geo-agent-platform/shared-types/geo-world'

import type { Database } from '../../db/connection.js'
import {
  platformGeoWorldDiffs,
  platformGeoWorldSnapshots,
  platformRuns,
} from '../../db/schema.js'
import { GeoWorldRevisionConflictError } from '../../store/storeErrors.js'
import { makeId, nowUtc } from '../../utils/ids.js'
import { agentContextDigest } from '../step/agentContextDigest.js'

export interface GeoWorldSnapshotRecord {
  state: GeoWorldState
  stateDigest: string
}

export class GeoWorldRepository {
  constructor(private readonly db: Database) {}

  async ensureBaseline(runId: string, rawBaseline: GeoWorldState): Promise<GeoWorldSnapshotRecord> {
    const baseline = geoWorldStateSchema.parse(rawBaseline)
    if (baseline.revision !== 1) throw new Error('GeoWorld baseline revision 必须为 1')
    return this.db.transaction(async tx => {
      const runRows = await tx.select({
        runId: platformRuns.runId,
        workspaceId: platformRuns.workspaceId,
      }).from(platformRuns).where(eq(platformRuns.runId, runId)).for('update').limit(1)
      const run = runRows[0]
      if (!run) throw new Error(`运行 '${runId}' 不存在`)
      if (!run.workspaceId) throw new Error(`运行 '${runId}' 缺少 workspaceId`)
      if (baseline.workspaceId !== run.workspaceId) {
        throw new Error(`GeoWorld baseline 不属于运行 '${runId}' 的 workspace`)
      }

      const existing = await tx.select().from(platformGeoWorldSnapshots)
        .where(eq(platformGeoWorldSnapshots.runId, runId))
        .orderBy(desc(platformGeoWorldSnapshots.revision))
        .limit(1)
      if (existing[0]) return mapSnapshot(existing[0])

      const stateDigest = agentContextDigest(baseline)
      const now = new Date()
      const inserted = await tx.insert(platformGeoWorldSnapshots).values({
        runId,
        workspaceId: baseline.workspaceId,
        revision: baseline.revision,
        stateSchemaVersion: baseline.schemaVersion,
        stateDigest,
        stateJson: baseline,
        createdAt: now,
      }).returning()
      const row = inserted[0]
      if (!row) throw new Error(`运行 '${runId}' GeoWorld baseline 创建失败`)
      return mapSnapshot(row)
    })
  }

  async get(runId: string): Promise<GeoWorldSnapshotRecord | null> {
    const rows = await this.db.select().from(platformGeoWorldSnapshots)
      .where(eq(platformGeoWorldSnapshots.runId, runId))
      .orderBy(desc(platformGeoWorldSnapshots.revision))
      .limit(1)
    return rows[0] ? mapSnapshot(rows[0]) : null
  }

  async getRevision(runId: string, revision: number): Promise<GeoWorldSnapshotRecord | null> {
    const rows = await this.db.select().from(platformGeoWorldSnapshots)
      .where(and(
        eq(platformGeoWorldSnapshots.runId, runId),
        eq(platformGeoWorldSnapshots.revision, revision),
      ))
      .limit(1)
    return rows[0] ? mapSnapshot(rows[0]) : null
  }

  async require(runId: string): Promise<GeoWorldSnapshotRecord> {
    const record = await this.get(runId)
    if (!record) throw new Error(`运行 '${runId}' 尚未建立 GeoWorld baseline`)
    return record
  }

  async applyPatches(input: {
    runId: string
    expectedRevision: number
    patches: readonly GeoWorldPatch[]
  }): Promise<{ snapshot: GeoWorldSnapshotRecord; diff: GeoWorldDiff }> {
    return this.db.transaction(async tx => {
      const runRows = await tx.select({ runId: platformRuns.runId })
        .from(platformRuns)
        .where(eq(platformRuns.runId, input.runId))
        .for('update')
        .limit(1)
      if (!runRows[0]) throw new Error(`运行 '${input.runId}' 不存在`)
      const rows = await tx.select().from(platformGeoWorldSnapshots)
        .where(eq(platformGeoWorldSnapshots.runId, input.runId))
        .orderBy(desc(platformGeoWorldSnapshots.revision))
        .limit(1)
      const row = rows[0]
      if (!row) throw new Error(`运行 '${input.runId}' 尚未建立 GeoWorld baseline`)
      const current = mapSnapshot(row)
      if (current.state.revision !== input.expectedRevision) {
        throw new GeoWorldRevisionConflictError(
          input.runId,
          input.expectedRevision,
          current.state.revision,
        )
      }
      const createdAt = nowUtc()
      const { state, diff } = createGeoWorldDiff({
        diffId: makeId('world_diff'),
        runId: input.runId,
        current: current.state,
        patches: input.patches,
        createdAt,
      })
      const stateDigest = agentContextDigest(state)
      const inserted = await tx.insert(platformGeoWorldSnapshots).values({
        runId: input.runId,
        workspaceId: row.workspaceId,
        revision: state.revision,
        stateSchemaVersion: state.schemaVersion,
        stateDigest,
        stateJson: state,
        createdAt: new Date(createdAt),
      }).returning({ revision: platformGeoWorldSnapshots.revision })
      if (inserted[0]?.revision !== state.revision) throw new Error(`运行 '${input.runId}' GeoWorld revision 写入失败`)
      await tx.insert(platformGeoWorldDiffs).values({
        diffId: diff.diffId,
        runId: diff.runId,
        fromRevision: diff.fromWorldRevision,
        toRevision: diff.toWorldRevision,
        diffJson: diff,
        createdAt: new Date(diff.createdAt),
      })
      return { snapshot: { state, stateDigest }, diff }
    })
  }

  async listDiffs(runId: string, afterRevision = 1): Promise<GeoWorldDiff[]> {
    const rows = await this.db.select().from(platformGeoWorldDiffs)
      .where(and(
        eq(platformGeoWorldDiffs.runId, runId),
        gt(platformGeoWorldDiffs.toRevision, afterRevision),
      ))
      .orderBy(asc(platformGeoWorldDiffs.toRevision))
    return rows.map(row => geoWorldDiffSchema.parse(row.diffJson))
  }
}

function mapSnapshot(
  row: typeof platformGeoWorldSnapshots.$inferSelect,
): GeoWorldSnapshotRecord {
  const state = geoWorldStateSchema.parse(row.stateJson)
  if (
    state.revision !== row.revision
    || state.schemaVersion !== row.stateSchemaVersion
    || state.workspaceId !== row.workspaceId
  ) {
    throw new Error(`运行 '${row.runId}' GeoWorld 行与 state_json 不一致`)
  }
  const stateDigest = agentContextDigest(state)
  if (stateDigest !== row.stateDigest) {
    throw new Error(`运行 '${row.runId}' GeoWorld state_digest 校验失败`)
  }
  return { state, stateDigest }
}

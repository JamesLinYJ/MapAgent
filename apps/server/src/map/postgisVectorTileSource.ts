// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostGIS 矢量瓦片数据源
//
//   文件:       postgisVectorTileSource.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'

import type { Pool } from 'pg'
import { z } from 'zod'

import type { MapTileExecutionSpec } from '../store/postgres/mapStore.js'
import type { MapTileResponse, VectorTileSource } from './mapTileSource.js'

const vectorTileRowSchema = z.object({
  tile: z.instanceof(Buffer).nullable(),
}).strict()

/**
 * PostGIS 已拥有 MVT 编码能力；该边界只执行参数化的固定数据库函数，
 * 不接受表名、SQL、任意筛选器或客户端路径。
 */
export class PostgisVectorTileSource implements VectorTileSource {
  constructor(
    private readonly pool: Pool,
    private readonly timeoutMs: number,
  ) {}

  async fetchTile(
    spec: MapTileExecutionSpec,
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<MapTileResponse> {
    signal?.throwIfAborted()
    const client = await this.pool.connect()
    let transactionStarted = false
    try {
      await client.query('BEGIN')
      transactionStarted = true
      await client.query(
        `SELECT set_config('statement_timeout', $1, true)`,
        [String(this.timeoutMs)],
      )
      const result = await client.query(
        `SELECT geo_agent_platform_layer_tiles(
          $1::integer,
          $2::integer,
          $3::integer,
          json_build_object('mapLayerId', $4::text)::json
        ) AS tile`,
        [z, x, y, spec.manifest.mapLayerId],
      )
      signal?.throwIfAborted()
      const parsed = vectorTileRowSchema.safeParse(result.rows[0])
      if (!parsed.success) {
        throw new Error('PostGIS 矢量瓦片函数返回了无效结果。')
      }
      await client.query('COMMIT')
      transactionStarted = false
      const bytes = parsed.data.tile ?? Buffer.alloc(0)
      return {
        body: exactArrayBuffer(bytes),
        contentType: 'application/vnd.mapbox-vector-tile',
        cacheControl: 'private, max-age=60',
        etag: strongEtag(bytes),
      }
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

function strongEtag(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('base64url')}"`
}

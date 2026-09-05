// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象数据持久化门面测试
//
//   文件:       platformPersistenceFacade.meteorology.test.ts
//
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import os from 'node:os'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import * as schema from '../db/schema.js'
import type { FileLifecyclePort } from './fileLifecycleService.js'
import { PlatformPersistenceFacade } from './platformPersistenceFacade.js'

describe('MeteorologicalStore domain port', () => {
  it('scopes dataset lists by threadId even when sessionId is not provided', async () => {
    const fixture = createMeteorologicalDb([
      datasetRow('dataset-a', 'session-a', 'thread-a', 'alpha.nc', '2026-07-01T00:00:00.000Z'),
      datasetRow('dataset-b', 'session-a', 'thread-b', 'beta.nc', '2026-07-01T01:00:00.000Z'),
    ])
    const store = new PlatformPersistenceFacade(fixture.db, path.join(os.tmpdir(), 'geo-store-meteorology-thread'), {
      fileLifecycle: emptyFileLifecycle(),
    })

    const rows = await store.meteorology.listMeteorologicalDatasets({ threadId: 'thread-b' })

    expect(rows.map(row => row.datasetId)).toEqual(['dataset-b'])
    expect(fixture.queries[0]?.text).toContain('"thread_id" =')
  })

  it('resolves latest_upload inside the requested thread instead of taking a newer sibling thread upload', async () => {
    const fixture = createMeteorologicalDb([
      datasetRow('dataset-current', 'session-a', 'thread-current', 'current.nc', '2026-07-01T01:00:00.000Z'),
      datasetRow('dataset-sibling', 'session-a', 'thread-sibling', 'sibling.nc', '2026-07-01T02:00:00.000Z'),
    ])
    const store = new PlatformPersistenceFacade(fixture.db, path.join(os.tmpdir(), 'geo-store-meteorology-latest-thread'), {
      fileLifecycle: emptyFileLifecycle(),
    })

    const dataset = await store.meteorology.resolveMeteorologicalDataset({
      sessionId: 'session-a',
      threadId: 'thread-current',
      datasetId: 'latest_upload',
    })

    expect(dataset?.datasetId).toBe('dataset-current')
    expect(fixture.queries[0]?.text).toContain('"thread_id" =')
  })

  it('applies filename filtering inside the thread scope without requiring sessionId', async () => {
    const fixture = createMeteorologicalDb([
      datasetRow('dataset-a', 'session-a', 'thread-a', 'target.nc', '2026-07-01T00:00:00.000Z'),
      datasetRow('dataset-b', 'session-a', 'thread-b', 'target.nc', '2026-07-01T01:00:00.000Z'),
      datasetRow('dataset-c', 'session-a', 'thread-b', 'other.nc', '2026-07-01T02:00:00.000Z'),
    ])
    const store = new PlatformPersistenceFacade(fixture.db, path.join(os.tmpdir(), 'geo-store-meteorology-filename'), {
      fileLifecycle: emptyFileLifecycle(),
    })

    const rows = await store.meteorology.listMeteorologicalDatasets({ threadId: 'thread-b', filename: 'target.nc' })

    expect(rows.map(row => row.datasetId)).toEqual(['dataset-b'])
    expect(fixture.queries[0]?.text).toContain('"thread_id" =')
    expect(fixture.queries[0]?.text).toContain('."filename") = lower')
  })

  it('pushes workspace scope into the dataset list SQL query', async () => {
    const fixture = createMeteorologicalDb([
      datasetRow('dataset-a', 'session-a', 'thread-a', 'target.nc', '2026-07-01T00:00:00.000Z', 'workspace-a'),
      datasetRow('dataset-b', 'session-a', 'thread-a', 'target.nc', '2026-07-01T01:00:00.000Z', 'workspace-b'),
    ])
    const store = new PlatformPersistenceFacade(fixture.db, path.join(os.tmpdir(), 'geo-store-meteorology-workspace'), {
      fileLifecycle: emptyFileLifecycle(),
    })

    const rows = await store.meteorology.listMeteorologicalDatasets({
      workspaceId: 'workspace-b',
      threadId: 'thread-a',
      filename: 'target.nc',
    })

    expect(rows.map(row => row.datasetId)).toEqual(['dataset-b'])
    expect(fixture.queries[0]?.text).toContain('"workspace_id" =')
    expect(fixture.queries[0]?.text).toContain('"thread_id" =')
    expect(fixture.queries[0]?.text).toContain('."filename") = lower')
  })

  it('resolves a requested dataset batch with one IN query and preserves session scope', async () => {
    const fixture = createMeteorologicalDb([
      datasetRow('dataset-a', 'session-a', 'thread-a', 'a.nc', '2026-07-01T00:00:00.000Z'),
      datasetRow('dataset-b', 'session-a', 'thread-a', 'b.nc', '2026-07-01T01:00:00.000Z'),
      datasetRow('dataset-c', 'session-b', 'thread-b', 'c.nc', '2026-07-01T02:00:00.000Z'),
    ])
    const store = new PlatformPersistenceFacade(fixture.db, path.join(os.tmpdir(), 'geo-store-meteorology-batch'), {
      fileLifecycle: emptyFileLifecycle(),
    })

    const rows = await store.meteorology.listMeteorologicalDatasets({
      datasetIds: ['dataset-a', 'dataset-b', 'dataset-a'],
      sessionId: 'session-a',
      limit: 3,
    })

    expect(rows.map(row => row.datasetId).sort()).toEqual(['dataset-a', 'dataset-b'])
    expect(fixture.queries).toHaveLength(1)
    expect(fixture.queries[0]?.text.toLowerCase()).toContain('"dataset_id" in')
    expect(fixture.queries[0]?.text).toContain('"session_id" =')
  })

  it('requires the original session when resolving an explicit dataset without a workspace', async () => {
    const fixture = createMeteorologicalDb([
      datasetRow('dataset-private', 'session-b', 'thread-b', 'private.nc', '2026-07-01T00:00:00.000Z'),
    ])
    const store = new PlatformPersistenceFacade(fixture.db, path.join(os.tmpdir(), 'geo-store-meteorology-explicit-session'), {
      fileLifecycle: emptyFileLifecycle(),
    })

    const dataset = await store.meteorology.resolveMeteorologicalDataset({
      sessionId: 'session-a',
      datasetId: 'dataset-private',
    })

    expect(dataset).toBeNull()
    expect(fixture.queries[0]?.text).toContain('"dataset_id" =')
    expect(fixture.queries[0]?.text).toContain('"session_id" =')
  })

  it('counts only ready datasets inside the declared workspace, session and thread scope', async () => {
    const fixture = createMeteorologicalDb([
      datasetRow('dataset-a', 'session-a', 'thread-a', 'a.nc', '2026-07-01T00:00:00.000Z', 'workspace-a'),
      datasetRow('dataset-b', 'session-a', 'thread-a', 'b.nc', '2026-07-01T01:00:00.000Z', 'workspace-a'),
      { ...datasetRow('dataset-c', 'session-a', 'thread-a', 'c.nc', '2026-07-01T02:00:00.000Z', 'workspace-a'), status: 'failed' },
      datasetRow('dataset-d', 'session-a', 'thread-b', 'd.nc', '2026-07-01T03:00:00.000Z', 'workspace-a'),
    ])
    const store = new PlatformPersistenceFacade(fixture.db, path.join(os.tmpdir(), 'geo-store-meteorology-count'), {
      fileLifecycle: emptyFileLifecycle(),
    })

    const count = await store.meteorology.countMeteorologicalDatasets({
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      threadId: 'thread-a',
      status: 'ready',
    })

    expect(count).toBe(2)
    expect(fixture.queries[0]?.text).toContain('count(*)')
    expect(fixture.queries[0]?.text).toContain('"status" =')
  })
})

function emptyFileLifecycle(): FileLifecyclePort {
  return {
    upload: async () => { throw new Error('测试不应上传文件。') },
    list: async () => [],
    delete: async () => false,
    cloneThreadFiles: async () => [],
    purgeThreadFiles: async () => undefined,
  }
}

interface CapturedQuery {
  text: string
  values: unknown[]
}

type DatasetRow = Record<string, unknown>
interface PgQueryConfig {
  text: string
}

function createMeteorologicalDb(rows: DatasetRow[]): { db: Database; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = []
  const client = {
    query: async (query: PgQueryConfig | string, values: unknown[] = []) => {
      const captured = { text: typeof query === 'string' ? query : query.text, values }
      queries.push(captured)
      const filtered = filterRows(rows, captured)
      return {
        rows: captured.text.includes('count(*)')
          ? [[filtered.length]]
          : filtered.map(datasetRowToArray),
      }
    },
  }
  const db = drizzle(client as never, { schema }) as unknown as Database
  return { db: Object.assign(db, { pool: {}, close: async () => {} }) as Database, queries }
}

// 这里不模拟数据库能力，只解释本模块生成的 SQL 参数顺序；
// 测试目标是确认作用域谓词进入查询，而不是做端到端 SQL 引擎替身。
function filterRows(rows: DatasetRow[], query: CapturedQuery): DatasetRow[] {
  let valueIndex = 0
  const datasetIdsExpression = /"dataset_id"\s+in\s*\(([^)]+)\)/iu.exec(query.text)
  const datasetIdCount = datasetIdsExpression?.[1]?.match(/\$\d+/gu)?.length ?? 0
  const datasetIds = datasetIdCount > 0
    ? new Set(query.values.slice(valueIndex, valueIndex + datasetIdCount).map(String))
    : null
  valueIndex += datasetIdCount
  const workspaceId = query.text.includes('"workspace_id" =') ? String(query.values[valueIndex++]) : null
  const sessionId = query.text.includes('"session_id" =') ? String(query.values[valueIndex++]) : null
  const threadId = query.text.includes('"thread_id" =') ? String(query.values[valueIndex++]) : null
  const status = query.text.includes('"status" =') ? String(query.values[valueIndex++]) : null
  const filename = query.text.includes('."filename") = lower') ? String(query.values[valueIndex++]).toLowerCase() : null
  const limit = Number(query.values.at(-1) ?? rows.length)

  return rows
    .filter(row => !datasetIds || datasetIds.has(String(row.dataset_id)))
    .filter(row => !workspaceId || row.workspace_id === workspaceId)
    .filter(row => !sessionId || row.session_id === sessionId)
    .filter(row => !threadId || row.thread_id === threadId)
    .filter(row => !status || row.status === status)
    .filter(row => !filename || String(row.filename).toLowerCase() === filename)
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
    .slice(0, Number.isFinite(limit) ? limit : rows.length)
}

function datasetRowToArray(row: DatasetRow): unknown[] {
  return [
    row.dataset_id,
    row.workspace_id,
    row.created_by_user_id,
    row.visibility,
    row.session_id,
    row.thread_id,
    row.filename,
    row.original_filename,
    row.file_id,
    row.file_relative_path,
    row.size_bytes,
    row.content_hash,
    row.media_type,
    row.status,
    row.metadata_json,
    row.created_at,
    row.updated_at,
  ]
}

function datasetRow(
  datasetId: string,
  sessionId: string,
  threadId: string,
  filename: string,
  updatedAt: string,
  workspaceId: string | null = null,
): DatasetRow {
  return {
    dataset_id: datasetId,
    workspace_id: workspaceId,
    created_by_user_id: null,
    visibility: 'workspace',
    session_id: sessionId,
    thread_id: threadId,
    filename,
    original_filename: filename,
    file_id: `${datasetId}-file`,
    file_relative_path: `uploads/${filename}`,
    size_bytes: 1,
    content_hash: null,
    media_type: 'application/netcdf',
    status: 'ready',
    metadata_json: {},
    created_at: updatedAt,
    updated_at: updatedAt,
  }
}

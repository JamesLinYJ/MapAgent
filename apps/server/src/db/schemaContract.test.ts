// +-------------------------------------------------------------------------
//
//   地理智能平台 - 数据库 Schema 契约检查测试
//
//   文件:       schemaContract.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import {
  DATABASE_SCHEMA_CONTRACT_VERSION,
  verifyDatabaseSchemaContract,
} from './schemaContract.js'

function currentCapabilities(overrides: Record<string, unknown> = {}) {
  return {
    vector_tile_function: 'geo_agent_platform_layer_tiles(integer,integer,integer,json)',
    model_result_cache_table: 'platform_model_result_cache',
    file_objects_table: 'platform_file_objects',
    model_providers_table: 'platform_model_providers',
    model_provider_api_key_column: true,
    model_provider_revision_column: true,
    runtime_config_revision_column: true,
    configuration_revision_constraints: true,
    run_domain_events_table: 'platform_run_domain_events',
    run_snapshots_table: 'platform_run_snapshots',
    run_snapshot_authority: true,
    geo_world_snapshots_table: 'platform_geo_world_snapshots',
    geo_world_diffs_table: 'platform_geo_world_diffs',
    agent_step_contexts_table: 'platform_agent_step_contexts',
    model_request_records_table: 'platform_model_request_records',
    context_windows_table: 'platform_context_windows',
    tool_invocations_table: 'platform_tool_invocations',
    approval_records_table: 'platform_approval_records',
    geo_world_snapshot_primary_key: true,
    agent_step_world_foreign_key: true,
    context_window_columns: true,
    context_window_active_unique_index: true,
    context_window_generation_unique_index: true,
    context_window_run_foreign_key: true,
    model_request_recovery_binding_columns: true,
    model_request_context_window_foreign_key: true,
    run_input_mailbox: true,
    ...overrides,
  }
}

function databaseWithCapabilities(capabilities: Record<string, unknown>) {
  return {
    execute: vi.fn().mockResolvedValueOnce({ rows: [capabilities] }),
  }
}

describe('verifyDatabaseSchemaContract', () => {
  it('数据库启动契约已升为 v4', () => {
    expect(DATABASE_SCHEMA_CONTRACT_VERSION).toBe(4)
  })

  it('接受由单一权威基线创建的当前结构', async () => {
    const db = databaseWithCapabilities(currentCapabilities())

    await expect(verifyDatabaseSchemaContract(db as never)).resolves.toBeUndefined()
    expect(db.execute).toHaveBeenCalledTimes(1)
  })

  it('拒绝固定瓦片函数缺失的数据库', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ vector_tile_function: null }))

    await expect(verifyDatabaseSchemaContract(db as never))
      .rejects.toThrow(/geo_agent_platform_layer_tiles\(integer, integer, integer, json\)/u)
  })

  it.each([
    ['model_result_cache_table', /platform_model_result_cache/u],
    ['file_objects_table', /platform_file_objects/u],
    ['model_providers_table', /platform_model_providers/u],
  ] as const)('拒绝缺少基线能力 %s 的数据库', async (field, expected) => {
    const db = databaseWithCapabilities(currentCapabilities({ [field]: null }))

    await expect(verifyDatabaseSchemaContract(db as never)).rejects.toThrow(expected)
  })

  it('拒绝 Run input mailbox 列不完整的数据库', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ run_input_mailbox: false }))

    await expect(verifyDatabaseSchemaContract(db as never))
      .rejects.toThrow(/Run input mailbox\/model-request\/terminal claim/u)
  })

  it('拒绝只有旧凭据列而没有 api_key 的数据库', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ model_provider_api_key_column: false }))

    await expect(verifyDatabaseSchemaContract(db as never))
      .rejects.toThrow(/不兼容旧凭据列/u)
  })

  it.each([
    ['model_provider_revision_column', /Provider 或运行配置缺少非空整数 revision/u],
    ['runtime_config_revision_column', /Provider 或运行配置缺少非空整数 revision/u],
    ['configuration_revision_constraints', /Provider 或运行配置缺少非空整数 revision/u],
  ] as const)('拒绝缺少 v4 乐观并发修订号 %s 的数据库', async (field, expected) => {
    const db = databaseWithCapabilities(currentCapabilities({ [field]: false }))

    await expect(verifyDatabaseSchemaContract(db as never)).rejects.toThrow(expected)
  })

  it('拒绝 Run domain journal 表缺失的数据库', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ run_domain_events_table: null }))

    await expect(verifyDatabaseSchemaContract(db as never))
      .rejects.toThrow(/Run domain journal\/snapshot/u)
  })

  it('拒绝仍含 platform_runs.state_json 双事实源的旧数据库', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ run_snapshot_authority: false }))

    await expect(verifyDatabaseSchemaContract(db as never))
      .rejects.toThrow(/platform_run_snapshots.*platform_runs\.state_json/u)
  })

  it('拒绝 GeoWorld 或 StepContext 表缺失的数据库', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ agent_step_contexts_table: null }))

    await expect(verifyDatabaseSchemaContract(db as never))
      .rejects.toThrow(/GeoWorld\/Agent StepContext/u)
  })

  it('拒绝精确 ModelRequest journal 表缺失的数据库', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ model_request_records_table: null }))

    await expect(verifyDatabaseSchemaContract(db as never))
      .rejects.toThrow(/GeoWorld\/Agent StepContext\/ModelRequest/u)
  })

  it.each([
    ['context_windows_table', /ContextWindow/u, null],
    ['context_window_columns', /ContextWindow/u, false],
    ['context_window_active_unique_index', /ContextWindow/u, false],
    ['context_window_generation_unique_index', /ContextWindow/u, false],
    ['context_window_run_foreign_key', /ContextWindow/u, false],
    ['model_request_recovery_binding_columns', /ModelRequest/u, false],
    ['model_request_context_window_foreign_key', /ContextWindow/u, false],
  ] as const)('拒绝不完整的持久上下文窗口和模型请求恢复绑定 %s', async (
    field,
    expected,
    missingValue,
  ) => {
    const db = databaseWithCapabilities(currentCapabilities({ [field]: missingValue }))

    await expect(verifyDatabaseSchemaContract(db as never)).rejects.toThrow(expected)
  })

  it('拒绝缺少持久审批事实表的数据库', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ approval_records_table: null }))

    await expect(verifyDatabaseSchemaContract(db as never))
      .rejects.toThrow(/Approval/u)
  })

  it('拒绝仍会覆盖历史 GeoWorld 的单列主键草案', async () => {
    const db = databaseWithCapabilities(currentCapabilities({ geo_world_snapshot_primary_key: false }))

    await expect(verifyDatabaseSchemaContract(db as never))
      .rejects.toThrow(/追加式主键/u)
  })

  it.each([
    ['vector_tile_function', null],
    ['runtime_config_revision_column', false],
    ['context_window_columns', false],
  ] as const)('所有 v4 错误都指向空库权威基线而不是增量迁移：%s', async (
    field,
    missingValue,
  ) => {
    const db = databaseWithCapabilities(currentCapabilities({ [field]: missingValue }))

    await expect(verifyDatabaseSchemaContract(db as never))
      .rejects.toThrow(/空数据库执行权威基线 infra\/database\/schema\.sql；本版本不提供增量迁移/u)
  })
})

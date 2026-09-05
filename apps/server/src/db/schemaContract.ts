// +-------------------------------------------------------------------------
//
//   地理智能平台 - 数据库 Schema 契约检查
//
//   文件:       schemaContract.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { sql } from 'drizzle-orm'

import type { Database } from './connection.js'

export const DATABASE_SCHEMA_CONTRACT_VERSION = 4

const DATABASE_SCHEMA_REBUILD_INSTRUCTION =
  '请使用空数据库执行权威基线 infra/database/schema.sql；本版本不提供增量迁移或旧结构兼容。'

/**
 * 服务启动只验证数据库结构能力，不在运行时自动执行 DDL。
 * 新数据库由 infra/database/schema.sql 一次初始化；旧结构必须显式导出后重建。
 */
export async function verifyDatabaseSchemaContract(
  db: Pick<Database, 'execute'>,
): Promise<void> {
  const capabilityResult = await db.execute(sql`
    SELECT to_regprocedure(
      'public.geo_agent_platform_layer_tiles(integer,integer,integer,json)'
    ) AS vector_tile_function,
    to_regclass('public.platform_model_result_cache') AS model_result_cache_table,
    to_regclass('public.platform_file_objects') AS file_objects_table,
    to_regclass('public.platform_model_providers') AS model_providers_table,
    EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_model_providers'
        AND column_name = 'api_key'
    ) AS model_provider_api_key_column,
    (
      SELECT COUNT(*) = 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_model_providers'
        AND column_name = 'revision'
        AND data_type = 'integer'
        AND is_nullable = 'NO'
    ) AS model_provider_revision_column,
    (
      SELECT COUNT(*) = 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_runtime_config'
        AND column_name = 'revision'
        AND data_type = 'integer'
        AND is_nullable = 'NO'
    ) AS runtime_config_revision_column,
    (
      SELECT COUNT(*) = 2
      FROM pg_constraint
      WHERE (
        conrelid = to_regclass('public.platform_model_providers')
        AND conname = 'platform_model_providers_revision_check'
        AND contype = 'c'
      ) OR (
        conrelid = to_regclass('public.platform_runtime_config')
        AND conname = 'platform_runtime_config_revision_check'
        AND contype = 'c'
      )
    ) AS configuration_revision_constraints,
    to_regclass('public.platform_run_domain_events') AS run_domain_events_table,
    to_regclass('public.platform_run_snapshots') AS run_snapshots_table,
    NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_runs'
        AND column_name = 'state_json'
    ) AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_run_snapshots'
        AND column_name = 'state_json'
        AND is_nullable = 'NO'
    ) AS run_snapshot_authority,
    to_regclass('public.platform_geo_world_snapshots') AS geo_world_snapshots_table,
    to_regclass('public.platform_geo_world_diffs') AS geo_world_diffs_table,
    to_regclass('public.platform_agent_step_contexts') AS agent_step_contexts_table,
    to_regclass('public.platform_model_request_records') AS model_request_records_table,
    to_regclass('public.platform_context_windows') AS context_windows_table,
    to_regclass('public.platform_tool_invocations') AS tool_invocations_table,
    to_regclass('public.platform_approval_records') AS approval_records_table,
    COALESCE((
      SELECT array_agg(attribute.attname::text ORDER BY key_column.ordinality)
        = ARRAY['run_id', 'revision']::text[]
      FROM pg_constraint constraint_row
      CROSS JOIN LATERAL unnest(constraint_row.conkey)
        WITH ORDINALITY AS key_column(attnum, ordinality)
      JOIN pg_attribute attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attnum = key_column.attnum
      WHERE constraint_row.conrelid = to_regclass('public.platform_geo_world_snapshots')
        AND constraint_row.contype = 'p'
      GROUP BY constraint_row.oid
    ), FALSE) AS geo_world_snapshot_primary_key,
    EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = to_regclass('public.platform_agent_step_contexts')
        AND conname = 'platform_agent_step_contexts_world_snapshot_fk'
        AND contype = 'f'
    ) AS agent_step_world_foreign_key,
    (
      SELECT COUNT(*) = 10
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_context_windows'
        AND column_name IN (
          'context_window_id', 'run_id', 'generation', 'schema_version',
          'prompt_protocol_version', 'source_digest', 'source_summary_json',
          'compaction_json', 'started_at', 'closed_at'
        )
    ) AS context_window_columns,
    EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'platform_context_windows'
        AND indexname = 'idx_context_windows_active_run_unique'
        AND indexdef LIKE '%UNIQUE INDEX%'
        AND indexdef LIKE '%(run_id)%'
        AND indexdef LIKE '%closed_at IS NULL%'
    ) AS context_window_active_unique_index,
    EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'platform_context_windows'
        AND indexname = 'idx_context_windows_run_generation_unique'
        AND indexdef LIKE '%UNIQUE INDEX%'
        AND indexdef LIKE '%(run_id, generation)%'
    ) AS context_window_generation_unique_index,
    EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = to_regclass('public.platform_context_windows')
        AND conname = 'platform_context_windows_run_id_fkey'
        AND contype = 'f'
        AND confrelid = to_regclass('public.platform_runs')
    ) AS context_window_run_foreign_key,
    (
      SELECT COUNT(*) = 6
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_model_request_records'
        AND column_name IN (
          'schema_version', 'objective_revision', 'input_cursor', 'context_window_id',
          'context_digest', 'agent_step_context_schema_version'
        )
        AND is_nullable = 'NO'
    ) AS model_request_recovery_binding_columns,
    EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = to_regclass('public.platform_model_request_records')
        AND conname = 'platform_model_request_records_context_window_id_fkey'
        AND contype = 'f'
        AND confrelid = to_regclass('public.platform_context_windows')
    ) AS model_request_context_window_foreign_key,
    (
      SELECT COUNT(*) = 6
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_run_inputs'
        AND column_name IN (
          'input_sequence', 'lease_id', 'leased_at',
          'model_request_id', 'included_at', 'checkpointed_at'
        )
    ) AND (
      SELECT COUNT(*) = 9
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_runs'
        AND column_name IN (
          'next_input_sequence', 'checkpoint_input_cursor', 'active_input_lease_id',
          'active_input_lease_from', 'active_input_lease_to',
          'terminal_input_claim_id', 'terminal_objective_revision',
          'terminal_input_cursor', 'terminal_claimed_at'
        )
    ) AS run_input_mailbox
  `)
  const vectorTileFunction = (
    capabilityResult.rows[0] as {
      vector_tile_function?: unknown
      model_result_cache_table?: unknown
      file_objects_table?: unknown
      model_providers_table?: unknown
      model_provider_api_key_column?: unknown
      model_provider_revision_column?: unknown
      runtime_config_revision_column?: unknown
      configuration_revision_constraints?: unknown
      run_domain_events_table?: unknown
      run_snapshots_table?: unknown
      run_snapshot_authority?: unknown
      geo_world_snapshots_table?: unknown
      geo_world_diffs_table?: unknown
      agent_step_contexts_table?: unknown
      model_request_records_table?: unknown
      context_windows_table?: unknown
      tool_invocations_table?: unknown
      approval_records_table?: unknown
      geo_world_snapshot_primary_key?: unknown
      agent_step_world_foreign_key?: unknown
      context_window_columns?: unknown
      context_window_active_unique_index?: unknown
      context_window_generation_unique_index?: unknown
      context_window_run_foreign_key?: unknown
      model_request_recovery_binding_columns?: unknown
      model_request_context_window_foreign_key?: unknown
      run_input_mailbox?: unknown
    } | undefined
  )?.vector_tile_function
  if (typeof vectorTileFunction !== 'string') {
    throw new Error(
      '数据库结构与当前应用契约不一致：缺少 '
      + 'geo_agent_platform_layer_tiles(integer, integer, integer, json)。'
      + DATABASE_SCHEMA_REBUILD_INSTRUCTION,
    )
  }
  const modelResultCacheTable = (
    capabilityResult.rows[0] as { model_result_cache_table?: unknown } | undefined
  )?.model_result_cache_table
  if (typeof modelResultCacheTable !== 'string') {
    throw new Error(
      '数据库结构与当前应用契约不一致：缺少 platform_model_result_cache。'
      + DATABASE_SCHEMA_REBUILD_INSTRUCTION,
    )
  }
  const fileObjectsTable = (
    capabilityResult.rows[0] as { file_objects_table?: unknown } | undefined
  )?.file_objects_table
  if (typeof fileObjectsTable !== 'string') {
    throw new Error(
      '数据库结构与当前应用契约不一致：缺少 platform_file_objects。'
      + DATABASE_SCHEMA_REBUILD_INSTRUCTION,
    )
  }
  const modelProvidersTable = (
    capabilityResult.rows[0] as { model_providers_table?: unknown } | undefined
  )?.model_providers_table
  if (typeof modelProvidersTable !== 'string') {
    throw new Error(
      '数据库结构与当前应用契约不一致：缺少 platform_model_providers。'
      + DATABASE_SCHEMA_REBUILD_INSTRUCTION,
    )
  }
  const modelProviderApiKeyColumn = (
    capabilityResult.rows[0] as { model_provider_api_key_column?: unknown } | undefined
  )?.model_provider_api_key_column
  if (modelProviderApiKeyColumn !== true) {
    throw new Error(
      '数据库结构与当前应用契约不一致：platform_model_providers 缺少 api_key。'
      + '不兼容旧凭据列。'
      + DATABASE_SCHEMA_REBUILD_INSTRUCTION,
    )
  }
  const modelProviderRevisionColumn = (
    capabilityResult.rows[0] as { model_provider_revision_column?: unknown } | undefined
  )?.model_provider_revision_column
  const runtimeConfigRevisionColumn = (
    capabilityResult.rows[0] as { runtime_config_revision_column?: unknown } | undefined
  )?.runtime_config_revision_column
  const configurationRevisionConstraints = (
    capabilityResult.rows[0] as { configuration_revision_constraints?: unknown } | undefined
  )?.configuration_revision_constraints
  if (
    modelProviderRevisionColumn !== true
    || runtimeConfigRevisionColumn !== true
    || configurationRevisionConstraints !== true
  ) {
    throw new Error(
      '数据库结构与当前应用契约 v4 不一致：Provider 或运行配置缺少非空整数 revision。'
      + DATABASE_SCHEMA_REBUILD_INSTRUCTION,
    )
  }
  const runInputMailbox = (
    capabilityResult.rows[0] as { run_input_mailbox?: unknown } | undefined
  )?.run_input_mailbox
  if (runInputMailbox !== true) {
    throw new Error(
      '数据库结构与当前应用契约不一致：Run input mailbox/model-request/terminal claim 列不完整。'
      + DATABASE_SCHEMA_REBUILD_INSTRUCTION,
    )
  }
  const runDomainEventsTable = (
    capabilityResult.rows[0] as { run_domain_events_table?: unknown } | undefined
  )?.run_domain_events_table
  const runSnapshotsTable = (
    capabilityResult.rows[0] as { run_snapshots_table?: unknown } | undefined
  )?.run_snapshots_table
  if (typeof runDomainEventsTable !== 'string' || typeof runSnapshotsTable !== 'string') {
    throw new Error(
      '数据库结构与当前应用契约不一致：Run domain journal/snapshot 表不完整。'
      + DATABASE_SCHEMA_REBUILD_INSTRUCTION,
    )
  }
  const runSnapshotAuthority = (
    capabilityResult.rows[0] as { run_snapshot_authority?: unknown } | undefined
  )?.run_snapshot_authority
  if (runSnapshotAuthority !== true) {
    throw new Error(
      '数据库结构与当前应用契约不一致：运行状态必须只保存在 '
      + 'platform_run_snapshots，platform_runs.state_json 旧列必须不存在。'
      + DATABASE_SCHEMA_REBUILD_INSTRUCTION,
    )
  }
  const geoWorldSnapshotsTable = (
    capabilityResult.rows[0] as { geo_world_snapshots_table?: unknown } | undefined
  )?.geo_world_snapshots_table
  const geoWorldDiffsTable = (
    capabilityResult.rows[0] as { geo_world_diffs_table?: unknown } | undefined
  )?.geo_world_diffs_table
  const agentStepContextsTable = (
    capabilityResult.rows[0] as { agent_step_contexts_table?: unknown } | undefined
  )?.agent_step_contexts_table
  const modelRequestRecordsTable = (
    capabilityResult.rows[0] as { model_request_records_table?: unknown } | undefined
  )?.model_request_records_table
  const contextWindowsTable = (
    capabilityResult.rows[0] as { context_windows_table?: unknown } | undefined
  )?.context_windows_table
  const toolInvocationsTable = (
    capabilityResult.rows[0] as { tool_invocations_table?: unknown } | undefined
  )?.tool_invocations_table
  const approvalRecordsTable = (
    capabilityResult.rows[0] as { approval_records_table?: unknown } | undefined
  )?.approval_records_table
  const geoWorldSnapshotPrimaryKey = (
    capabilityResult.rows[0] as { geo_world_snapshot_primary_key?: unknown } | undefined
  )?.geo_world_snapshot_primary_key
  const agentStepWorldForeignKey = (
    capabilityResult.rows[0] as { agent_step_world_foreign_key?: unknown } | undefined
  )?.agent_step_world_foreign_key
  const contextWindowColumns = (
    capabilityResult.rows[0] as { context_window_columns?: unknown } | undefined
  )?.context_window_columns
  const contextWindowActiveUniqueIndex = (
    capabilityResult.rows[0] as { context_window_active_unique_index?: unknown } | undefined
  )?.context_window_active_unique_index
  const contextWindowGenerationUniqueIndex = (
    capabilityResult.rows[0] as { context_window_generation_unique_index?: unknown } | undefined
  )?.context_window_generation_unique_index
  const contextWindowRunForeignKey = (
    capabilityResult.rows[0] as { context_window_run_foreign_key?: unknown } | undefined
  )?.context_window_run_foreign_key
  const modelRequestRecoveryBindingColumns = (
    capabilityResult.rows[0] as { model_request_recovery_binding_columns?: unknown } | undefined
  )?.model_request_recovery_binding_columns
  const modelRequestContextWindowForeignKey = (
    capabilityResult.rows[0] as { model_request_context_window_foreign_key?: unknown } | undefined
  )?.model_request_context_window_foreign_key
  if (
    typeof geoWorldSnapshotsTable !== 'string'
    || typeof geoWorldDiffsTable !== 'string'
    || typeof agentStepContextsTable !== 'string'
    || typeof modelRequestRecordsTable !== 'string'
    || typeof contextWindowsTable !== 'string'
    || typeof toolInvocationsTable !== 'string'
    || typeof approvalRecordsTable !== 'string'
    || geoWorldSnapshotPrimaryKey !== true
    || agentStepWorldForeignKey !== true
    || contextWindowColumns !== true
    || contextWindowActiveUniqueIndex !== true
    || contextWindowGenerationUniqueIndex !== true
    || contextWindowRunForeignKey !== true
    || modelRequestRecoveryBindingColumns !== true
    || modelRequestContextWindowForeignKey !== true
  ) {
    throw new Error(
      '数据库结构与当前应用契约 v4 不一致：GeoWorld/Agent StepContext/'
      + 'ModelRequest/ContextWindow/ToolInvocation/Approval 表、追加式主键或恢复绑定契约不完整。'
      + DATABASE_SCHEMA_REBUILD_INSTRUCTION,
    )
  }
}

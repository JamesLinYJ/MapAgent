// +-------------------------------------------------------------------------
//
//   地理智能平台 - Schema 验证单元测试
//
//   文件:       database.test.ts
//
//   日期:       2026年07月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   verifySchema / ensureSecurityTables 在缺表/缺列时抛出的错误必须
//   包含权威 schema.sql 指引，不连接真实数据库。
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { Database } from '../db/connection.js'
import { verifySchema, ensureSecurityTables } from './database.js'

// ---------------------------------------------------------------------------
// 假 DB：根据预置的 table → columns 映射响应对 information_schema 的查询
// ---------------------------------------------------------------------------

interface FakeDbConfig {
  tables: Record<string, string[]> // table → existing columns
  executedSql?: string[]
}

function fakeDb(config: FakeDbConfig): Database {
  return {
    execute: async (query: unknown) => {
      const text = sqlText(query)
      config.executedSql?.push(text)
      if (text.includes('information_schema.tables')) {
        return { rows: Object.keys(config.tables).map(t => ({ table_name: t })) }
      }
      if (text.includes('information_schema.columns')) {
        // Single param: the table name
        const tableName = String(paramValues(query)[0] ?? '')
        const columns = config.tables[tableName] ?? []
        return { rows: columns.map(c => ({ column_name: c })) }
      }
      // INSERT / other: succeed silently
      return { rows: [] }
    },
  } as unknown as Database
}

function completeSecurityTables(): Record<string, string[]> {
  return {
    auth_user: ['id', 'name', 'email', 'email_verified', 'image', 'role', 'banned', 'ban_reason', 'ban_expires', 'created_at', 'updated_at'],
    auth_session: ['id', 'expires_at', 'token', 'created_at', 'updated_at', 'ip_address', 'user_agent', 'impersonated_by', 'user_id'],
    auth_account: ['id', 'account_id', 'provider_id', 'user_id', 'access_token', 'refresh_token', 'id_token', 'access_token_expires_at', 'refresh_token_expires_at', 'scope', 'password', 'created_at', 'updated_at'],
    auth_verification: ['id', 'identifier', 'value', 'expires_at', 'created_at', 'updated_at'],
    platform_users: ['user_id', 'subject', 'email', 'display_name', 'status', 'last_login_at', 'created_at', 'updated_at'],
    platform_workspaces: ['workspace_id', 'name', 'description', 'status', 'created_by_user_id', 'created_at', 'updated_at'],
    platform_memberships: ['membership_id', 'workspace_id', 'user_id', 'role', 'created_at'],
    platform_sessions: ['session_id', 'workspace_id', 'created_by_user_id', 'visibility', 'status', 'latest_thread_id', 'latest_run_id', 'latest_uploaded_layer_key', 'latest_meteorological_dataset_id', 'created_at', 'updated_at'],
    platform_threads: ['thread_id', 'session_id', 'workspace_id', 'created_by_user_id', 'visibility', 'title', 'status', 'latest_run_id', 'latest_user_query', 'latest_assistant_summary', 'latest_run_status', 'latest_artifact_id', 'latest_artifact_name', 'history_preview', 'run_count', 'next_entry_sequence', 'active_leaf_entry_id', 'transcript_entry_count', 'estimated_context_tokens', 'latest_compaction_id', 'memory_version', 'memory_based_on_tokens', 'forked_from_thread_id', 'forked_from_entry_id', 'quarantined', 'quarantine_reason', 'deleted_at', 'purge_after', 'created_at', 'updated_at'],
    platform_runs: ['run_id', 'session_id', 'thread_id', 'workspace_id', 'created_by_user_id', 'visibility', 'user_query', 'model_provider', 'model_name', 'status', 'runtime_config_json', 'active_entry_id', 'pending_tool_call_ids', 'recovery_status', 'orchestration_engine', 'sdk_state_content_hash', 'sdk_version', 'runtime_config_digest', 'sdk_state_schema_version', 'sdk_state_updated_at', 'next_record_sequence', 'next_input_sequence', 'checkpoint_input_cursor', 'active_input_lease_id', 'active_input_lease_from', 'active_input_lease_to', 'terminal_input_claim_id', 'terminal_objective_revision', 'terminal_input_cursor', 'terminal_claimed_at', 'created_at', 'updated_at'],
    platform_conversation_entries: ['entry_id', 'session_id', 'thread_id', 'run_id', 'turn_id', 'sequence', 'parent_entry_id', 'logical_parent_entry_id', 'kind', 'payload_json', 'trace_id', 'created_at'],
    platform_thread_memory_versions: ['thread_id', 'version', 'content_hash', 'source', 'based_on_entry_id', 'estimated_tokens', 'created_at'],
    platform_thread_compactions: ['compaction_id', 'thread_id', 'boundary_entry_id', 'summary_entry_id', 'first_compacted_entry_id', 'last_compacted_entry_id', 'preserved_from_entry_id', 'source_digest', 'source_entry_ids_json', 'source_unit_ids_json', 'source_object_hashes_json', 'summary', 'strategy', 'summary_provider', 'summary_model', 'prompt_version', 'pre_tokens', 'post_tokens', 'created_at'],
    platform_run_records: ['record_id', 'run_id', 'thread_id', 'sequence', 'record_type', 'payload_json', 'trace_id', 'created_at'],
    platform_agent_step_contexts: ['step_id', 'run_id', 'turn_id', 'segment_id', 'model_request_index', 'objective_revision', 'input_cursor', 'world_revision', 'runtime_config_digest', 'tool_plan_digest', 'context_digest', 'context_json', 'created_at'],
    platform_model_request_records: ['request_id', 'schema_version', 'run_id', 'turn_id', 'step_id', 'segment_id', 'objective_revision', 'input_cursor', 'context_window_id', 'context_digest', 'agent_step_context_schema_version', 'provider', 'model_id', 'input_object_hash', 'input_digest', 'instructions_digest', 'tool_plan_digest', 'world_revision', 'input_entry_ids', 'summary_object_hashes', 'created_at'],
    platform_run_inputs: ['input_id', 'run_id', 'thread_id', 'entry_id', 'item_id', 'kind', 'content', 'input_sequence', 'status', 'queued_at', 'lease_id', 'leased_at', 'model_request_id', 'included_at', 'checkpointed_at'],
    platform_tool_invocations: ['invocation_id', 'run_id', 'turn_id', 'call_id', 'step_id', 'tool_name', 'tool_kind', 'execution_surface', 'objective_revision', 'tool_plan_digest', 'descriptor_digest', 'args_digest', 'effect', 'replay_policy', 'idempotency_key', 'approval_action', 'approval_decision', 'status', 'terminal_outcome', 'result_id', 'error', 'prepared_at', 'running_at', 'terminal_at', 'checkpointed_at', 'version'],
    platform_approval_records: ['approval_id', 'run_id', 'thread_id', 'session_id', 'workspace_id', 'invocation_id', 'call_id', 'step_id', 'context_digest', 'action_key', 'action_json', 'status', 'decision', 'decision_scope', 'decision_reason', 'decided_by_user_id', 'source_approval_id', 'created_at', 'resolved_at', 'consumed_at', 'version'],
    platform_run_domain_events: ['event_id', 'run_id', 'sequence', 'event_type', 'schema_version', 'objective_revision', 'turn_id', 'step_id', 'causation_id', 'correlation_id', 'actor_kind', 'actor_id', 'payload_json', 'occurred_at'],
    platform_run_snapshots: ['run_id', 'sequence', 'snapshot_schema_version', 'state_json', 'updated_at'],
    platform_event_outbox: ['outbox_id', 'aggregate_type', 'aggregate_id', 'event_type', 'payload_json', 'trace_id', 'attempt_count', 'created_at', 'published_at'],
    platform_rbac_policies: ['policy_id', 'ptype', 'v0', 'v1', 'v2', 'v3', 'v4', 'v5'],
    platform_audit_events: ['audit_event_id', 'actor_user_id', 'workspace_id', 'action', 'object_type', 'object_id', 'outcome', 'metadata_json', 'created_at'],
    platform_artifacts: ['artifact_id', 'run_id', 'artifact_type', 'name', 'uri', 'metadata_json', 'content_relative_path', 'created_at', 'workspace_id', 'created_by_user_id', 'visibility'],
    platform_automation_definitions: ['automation_id', 'workspace_id', 'created_by_user_id', 'name', 'description', 'version', 'revision', 'published_revision', 'source', 'lifecycle', 'enabled', 'parameters_schema_json', 'default_parameters_json', 'required_tools_json', 'requires_approval', 'timeout_seconds', 'output_type', 'definition_json', 'created_at', 'updated_at'],
    platform_automation_versions: ['automation_id', 'revision', 'lifecycle', 'definition_json', 'created_by_user_id', 'created_at', 'published_at'],
    platform_scheduled_tasks: ['task_id', 'target_kind', 'target_id', 'workspace_id', 'created_by_user_id', 'title', 'prompt', 'parameters_json', 'cron', 'timezone', 'recurring', 'enabled', 'status', 'last_fired_at', 'next_fire_at', 'last_run_id', 'queue_job_id', 'failure_count', 'last_error_message', 'created_at', 'updated_at'],
    platform_automation_runs: ['automation_run_id', 'automation_id', 'automation_revision', 'scheduled_task_id', 'workspace_id', 'created_by_user_id', 'run_id', 'status', 'current_step', 'trigger_kind', 'error_message', 'metadata_json', 'node_runs_json', 'pending_approval_json', 'outputs_json', 'started_at', 'completed_at'],
  }
}

// ---------------------------------------------------------------------------
// helpers — extract text and param values from drizzle SQL query chunks
// ---------------------------------------------------------------------------

function sqlText(query: unknown): string {
  const parts: string[] = []
  for (const chunk of queryChunks(query)) appendSqlText(chunk, parts)
  return parts.join('')
}

function paramValues(query: unknown): unknown[] {
  const values: unknown[] = []
  for (const chunk of queryChunks(query)) appendParamValues(chunk, values)
  return values
}

function queryChunks(value: unknown): unknown[] {
  const qc = (value as { queryChunks?: unknown[] })?.queryChunks
  return Array.isArray(qc) ? qc : []
}

function appendSqlText(chunk: unknown, parts: string[]): void {
  if (typeof chunk === 'object' && chunk !== null && Array.isArray((chunk as { value?: unknown }).value)) {
    const arr = (chunk as { value: unknown[] }).value
    if (arr.every(item => typeof item === 'string')) parts.push(arr.join(''))
    return
  }
  if (typeof chunk === 'object' && chunk !== null && Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)) {
    for (const nested of (chunk as { queryChunks: unknown[] }).queryChunks) appendSqlText(nested, parts)
  }
}

function appendParamValues(chunk: unknown, values: unknown[]): void {
  if (typeof chunk === 'object' && chunk !== null && Array.isArray((chunk as { value?: unknown }).value)) return
  if (typeof chunk === 'object' && chunk !== null && Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)) {
    for (const nested of (chunk as { queryChunks: unknown[] }).queryChunks) appendParamValues(nested, values)
    return
  }
  values.push(chunk)
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('verifySchema', () => {
  it('succeeds when all tables and columns exist', async () => {
    const db = fakeDb({
      tables: {
        auth_user: ['id', 'name', 'email'],
        platform_users: ['user_id', 'subject'],
      },
    })
    await expect(
      verifySchema(db, {
        auth_user: ['id', 'name', 'email'],
        platform_users: ['user_id', 'subject'],
      }),
    ).resolves.toBeUndefined()
  })

  it('throws when a required table is missing', async () => {
    const db = fakeDb({
      tables: {
        auth_user: ['id', 'name', 'email'],
      },
    })
    await expect(
      verifySchema(db, {
        auth_user: ['id', 'name', 'email'],
        platform_users: ['user_id'],
      }),
    ).rejects.toThrow(/Schema 验证失败/)
  })

  it('error message points to the authoritative empty-database schema', async () => {
    const db = fakeDb({ tables: {} })
    await expect(
      verifySchema(db, { missing_table: ['col_a'] }),
    ).rejects.toThrow(/infra\/database\/schema\.sql/)
  })

  it('throws when a column is missing on an existing table', async () => {
    const db = fakeDb({
      tables: {
        auth_user: ['id', 'name'], // missing 'email'
      },
    })
    await expect(
      verifySchema(db, {
        auth_user: ['id', 'name', 'email'],
      }),
    ).rejects.toThrow(/缺少列/)
  })

  it('lists all missing tables in the error', async () => {
    const db = fakeDb({ tables: {} })
    await expect(
      verifySchema(db, {
        table_a: ['col_a'],
        table_b: ['col_b'],
      }),
    ).rejects.toThrow(/table_a/)
  })

  it('lists all missing columns in the error', async () => {
    const db = fakeDb({
      tables: { auth_user: ['id'] },
    })
    await expect(
      verifySchema(db, {
        auth_user: ['id', 'name', 'email'],
      }),
    ).rejects.toThrow(/auth_user\.name/)
  })

  it('uses an IN parameter list instead of casting a record to text array', async () => {
    const executedSql: string[] = []
    const db = fakeDb({
      tables: {
        auth_user: ['id'],
        platform_users: ['user_id'],
      },
      executedSql,
    })

    await verifySchema(db, {
      auth_user: ['id'],
      platform_users: ['user_id'],
    })

    expect(executedSql[0]).toContain('table_name IN')
    expect(executedSql[0]).not.toContain('ANY((')
  })
})

describe('ensureSecurityTables', () => {
  it('passes when all security tables and columns exist', async () => {
    const db = fakeDb({
      tables: completeSecurityTables(),
    })
    await expect(ensureSecurityTables(db)).resolves.toBeUndefined()
  })

  it('拒绝缺少模型请求自身 schema 版本的数据库', async () => {
    const tables = completeSecurityTables()
    tables.platform_model_request_records = tables.platform_model_request_records!
      .filter(column => column !== 'schema_version')
    const db = fakeDb({ tables })

    await expect(ensureSecurityTables(db))
      .rejects.toThrow(/platform_model_request_records\.schema_version/u)
  })

  it('does not execute DDL during startup schema verification', async () => {
    const executedSql: string[] = []
    const db = fakeDb({
      tables: completeSecurityTables(),
      executedSql,
    })
    await ensureSecurityTables(db)
    expect(executedSql.join('\n')).not.toMatch(/\b(CREATE|ALTER|DROP)\b/i)
  })

  it('throws when a security table is missing', async () => {
    const db = fakeDb({
      tables: {
        // missing auth_user entirely
        auth_session: ['id', 'expires_at', 'token', 'created_at', 'updated_at', 'ip_address', 'user_agent', 'user_id'],
        auth_account: ['id', 'account_id', 'provider_id', 'user_id', 'access_token', 'refresh_token', 'id_token', 'access_token_expires_at', 'refresh_token_expires_at', 'scope', 'password', 'created_at', 'updated_at'],
        auth_verification: ['id', 'identifier', 'value', 'expires_at', 'created_at', 'updated_at'],
        platform_users: ['user_id', 'subject', 'email', 'display_name', 'status', 'last_login_at', 'created_at', 'updated_at'],
        platform_workspaces: ['workspace_id', 'name', 'description', 'status', 'created_by_user_id', 'created_at', 'updated_at'],
        platform_memberships: ['membership_id', 'workspace_id', 'user_id', 'role', 'created_at'],
        platform_rbac_policies: ['policy_id', 'ptype', 'v0', 'v1', 'v2', 'v3', 'v4', 'v5'],
        platform_audit_events: ['audit_event_id', 'actor_user_id', 'workspace_id', 'action', 'object_type', 'object_id', 'outcome', 'metadata_json', 'created_at'],
        platform_artifacts: ['artifact_id', 'run_id', 'artifact_type', 'name', 'uri', 'metadata_json', 'content_relative_path', 'created_at', 'workspace_id', 'created_by_user_id', 'visibility'],
        platform_automation_definitions: ['automation_id', 'workspace_id', 'created_by_user_id', 'name', 'description', 'version', 'revision', 'published_revision', 'source', 'lifecycle', 'enabled', 'parameters_schema_json', 'default_parameters_json', 'required_tools_json', 'requires_approval', 'timeout_seconds', 'output_type', 'definition_json', 'created_at', 'updated_at'],
        platform_automation_versions: ['automation_id', 'revision', 'lifecycle', 'definition_json', 'created_by_user_id', 'created_at', 'published_at'],
        platform_scheduled_tasks: ['task_id', 'target_kind', 'target_id', 'workspace_id', 'created_by_user_id', 'title', 'prompt', 'parameters_json', 'cron', 'timezone', 'recurring', 'enabled', 'status', 'last_fired_at', 'next_fire_at', 'last_run_id', 'queue_job_id', 'failure_count', 'last_error_message', 'created_at', 'updated_at'],
        platform_automation_runs: ['automation_run_id', 'automation_id', 'automation_revision', 'scheduled_task_id', 'workspace_id', 'created_by_user_id', 'run_id', 'status', 'current_step', 'trigger_kind', 'error_message', 'metadata_json', 'node_runs_json', 'pending_approval_json', 'outputs_json', 'started_at', 'completed_at'],
      },
    })
    await expect(ensureSecurityTables(db)).rejects.toThrow(/缺少表/)
  })
})

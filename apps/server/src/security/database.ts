// +-------------------------------------------------------------------------
//
//   地理智能平台 - 安全表 Schema 验证与默认策略种子
//
//   文件:       database.ts
//
//   日期:       2026年07月02日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   P0 重构 (2026-07-03):
//     作者: Claude Code
//     启动期不再执行任何 CREATE/ALTER/INDEX/ADD COLUMN。
//     改为纯校验：缺表或缺列时抛出明确错误，提示从空库执行权威基线。
//     保留 RBAC 默认 policy 的 INSERT seed（数据级，非 DDL）。
// --------------------------------------------------------------------------

import { sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { Database } from '../db/connection.js'

const DEFAULT_POLICIES = [
  ['platform_admin', '*', '*', '*', 'allow'],
  ['workspace_admin', '*', 'workspace', 'read|update|admin', 'allow'],
  ['workspace_admin', '*', 'session', 'read|create|update|delete|admin', 'allow'],
  ['workspace_admin', '*', 'thread', 'read|create|update|delete|admin', 'allow'],
  ['workspace_admin', '*', 'run', 'read|create|update|delete|execute|approve|admin', 'allow'],
  ['workspace_admin', '*', 'artifact', 'read|create|update|delete|admin', 'allow'],
  ['workspace_admin', '*', 'dataset', 'read|create|update|delete|execute|admin', 'allow'],
  ['workspace_admin', '*', 'layer', 'read|create|update|delete|admin', 'allow'],
  ['workspace_admin', '*', 'tool', 'read|execute|approve', 'allow'],
  ['workspace_admin', '*', 'memory', 'read|create|update|delete|execute', 'allow'],
  ['workspace_admin', '*', 'speech', 'read|execute', 'allow'],
  ['workspace_admin', '*', 'automation', 'read|create|update|delete|execute|admin', 'allow'],
  ['workspace_admin', '*', 'scheduled_task', 'read|create|update|delete|execute|admin', 'allow'],
  ['analyst', '*', 'workspace', 'read', 'allow'],
  ['analyst', '*', 'session', 'read|create|update', 'allow'],
  ['analyst', '*', 'thread', 'read|create|update|delete', 'allow'],
  ['analyst', '*', 'run', 'read|create|execute|approve', 'allow'],
  ['analyst', '*', 'artifact', 'read|create', 'allow'],
  ['analyst', '*', 'dataset', 'read|create|execute', 'allow'],
  ['analyst', '*', 'layer', 'read|create|update', 'allow'],
  ['analyst', '*', 'tool', 'read|execute', 'allow'],
  ['analyst', '*', 'memory', 'read|create|update|delete', 'allow'],
  ['analyst', '*', 'speech', 'read|execute', 'allow'],
  ['analyst', '*', 'automation', 'read|create|update|delete|execute', 'allow'],
  ['analyst', '*', 'scheduled_task', 'read|create|update|delete|execute', 'allow'],
  ['viewer', '*', 'workspace', 'read', 'allow'],
  ['viewer', '*', 'session', 'read', 'allow'],
  ['viewer', '*', 'thread', 'read', 'allow'],
  ['viewer', '*', 'run', 'read', 'allow'],
  ['viewer', '*', 'artifact', 'read', 'allow'],
  ['viewer', '*', 'dataset', 'read', 'allow'],
  ['viewer', '*', 'layer', 'read', 'allow'],
  ['viewer', '*', 'tool', 'read', 'allow'],
  ['viewer', '*', 'memory', 'read', 'allow'],
  ['viewer', '*', 'speech', 'read', 'allow'],
  ['viewer', '*', 'automation', 'read', 'allow'],
  ['viewer', '*', 'scheduled_task', 'read', 'allow'],
] as const

// 核心安全/平台表 schema 定义（table → required columns）
const SECURITY_TABLES: Record<string, string[]> = {
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
  platform_tool_invocations: ['invocation_id', 'run_id', 'turn_id', 'call_id', 'step_id', 'tool_name', 'tool_kind', 'execution_surface', 'objective_revision', 'tool_plan_digest', 'descriptor_digest', 'args_digest', 'effect', 'replay_policy', 'idempotency_key', 'approval_action', 'approval_decision', 'status', 'terminal_outcome', 'result_id', 'error', 'prepared_at', 'running_at', 'terminal_at', 'checkpointed_at', 'version'],
  platform_approval_records: ['approval_id', 'run_id', 'thread_id', 'session_id', 'workspace_id', 'invocation_id', 'call_id', 'step_id', 'context_digest', 'action_key', 'action_json', 'status', 'decision', 'decision_scope', 'decision_reason', 'decided_by_user_id', 'source_approval_id', 'created_at', 'resolved_at', 'consumed_at', 'version'],
  platform_run_inputs: ['input_id', 'run_id', 'thread_id', 'entry_id', 'item_id', 'kind', 'content', 'input_sequence', 'status', 'queued_at', 'lease_id', 'leased_at', 'model_request_id', 'included_at', 'checkpointed_at'],
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

// ensureSecurityTables 校验安全/平台核心表和关键列存在，缺即抛错。
// 不再执行任何 CREATE / ALTER / CREATE INDEX / ADD COLUMN。
// RBAC 默认 policy 的 INSERT seed 属于数据初始化，保留。
export async function ensureSecurityTables(db: Database): Promise<void> {
  await verifySchema(db, SECURITY_TABLES)

  // 数据级 seed：默认 RBAC policies（INSERT ... ON CONFLICT DO NOTHING）
  for (const policy of DEFAULT_POLICIES) {
    const policyId = hashPolicy(policy)
    await db.execute(sql`
      INSERT INTO platform_rbac_policies (policy_id, ptype, v0, v1, v2, v3, v4, v5)
      VALUES (${policyId}, 'p', ${policy[0]}, ${policy[1]}, ${policy[2]}, ${policy[3]}, ${policy[4]}, '')
      ON CONFLICT DO NOTHING
    `)
  }
}

// verifySchema 校验 public schema 下 table→columns 均存在。
// 缺表或缺列时抛出指向唯一 schema.sql 的明确错误。
export async function verifySchema(db: Database, required: Record<string, string[]>): Promise<void> {
  const tableNames = Object.keys(required)

  // 一次查询获取所有已存在表
  const tableResult = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (${sql.join(tableNames.map(table => sql`${table}`), sql`, `)})
  `)
  const existingTables = new Set(
    (tableResult.rows as Array<{ table_name: string }>).map(r => r.table_name),
  )
  const missingTables = tableNames.filter(t => !existingTables.has(t))

  // 逐表校验列（仅对已存在的表）
  const missingColumns: string[] = []
  for (const [table, columns] of Object.entries(required)) {
    if (!existingTables.has(table)) continue
    const colResult = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table}
    `)
    const existingCols = new Set(
      (colResult.rows as Array<{ column_name: string }>).map(r => r.column_name),
    )
    for (const col of columns) {
      if (!existingCols.has(col)) {
        missingColumns.push(`${table}.${col}`)
      }
    }
  }

  const errors: string[] = []
  if (missingTables.length) {
    errors.push(`缺少表: ${missingTables.join(', ')}`)
  }
  if (missingColumns.length) {
    errors.push(`缺少列: ${missingColumns.join(', ')}`)
  }
  if (errors.length) {
    throw new Error(
      `Schema 验证失败。请备份需要保留的数据后，从空数据库执行 infra/database/schema.sql。\n${errors.join('\n')}`,
    )
  }
}

function hashPolicy(parts: readonly string[]): string {
  return `policy_${createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 32)}`
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 数据库 Schema（Drizzle ORM）
//
//   文件:       schema.ts
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { sql } from 'drizzle-orm'
import { boolean, check, customType, foreignKey, pgTable, text, timestamp, jsonb, index, integer, primaryKey, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core'

const geometry4326 = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geometry(Geometry, 4326)'
  },
})

export const authUser = pgTable('auth_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  role: text('role').notNull().default('user'),
  banned: boolean('banned').notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  emailIdx: uniqueIndex('idx_auth_user_email_unique').on(table.email),
}))

export const authSession = pgTable('auth_session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  impersonatedBy: text('impersonated_by'),
  userId: text('user_id').notNull().references(() => authUser.id, { onDelete: 'cascade' }),
}, (table) => ({
  tokenIdx: uniqueIndex('idx_auth_session_token_unique').on(table.token),
  userIdx: index('idx_auth_session_user_id').on(table.userId),
}))

export const authAccount = pgTable('auth_account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => authUser.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userIdx: index('idx_auth_account_user_id').on(table.userId),
}))

export const authVerification = pgTable('auth_verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  identifierIdx: index('idx_auth_verification_identifier').on(table.identifier),
}))

export const platformUsers = pgTable('platform_users', {
  userId: text('user_id').primaryKey(),
  subject: text('subject').notNull(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  status: text('status').notNull().default('active'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  subjectIdx: uniqueIndex('idx_platform_users_subject_unique').on(table.subject),
  emailIdx: uniqueIndex('idx_platform_users_email_unique').on(table.email),
}))

export const platformWorkspaces = pgTable('platform_workspaces', {
  workspaceId: text('workspace_id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  status: text('status').notNull().default('active'),
  createdByUserId: text('created_by_user_id').notNull().references(() => platformUsers.userId, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const platformMemberships = pgTable('platform_memberships', {
  membershipId: text('membership_id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => platformUsers.userId, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  memberRoleIdx: uniqueIndex('idx_platform_memberships_member_role_unique').on(table.workspaceId, table.userId, table.role),
  workspaceIdx: index('idx_platform_memberships_workspace').on(table.workspaceId),
  userIdx: index('idx_platform_memberships_user').on(table.userId),
}))

// 会话、线程与运行是 PostgreSQL 中的在线事实源。文件系统只保存通过 contentRef
// 引用的大对象，不再保存另一套可写 session/thread/run manifest。
export const platformSessions = pgTable('platform_sessions', {
  sessionId: text('session_id').primaryKey(),
  workspaceId: text('workspace_id').references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  createdByUserId: text('created_by_user_id').references(() => platformUsers.userId, { onDelete: 'set null' }),
  visibility: text('visibility').notNull().default('workspace'),
  status: text('status').notNull().default('active'),
  latestThreadId: text('latest_thread_id'),
  latestRunId: text('latest_run_id'),
  latestUploadedLayerKey: text('latest_uploaded_layer_key'),
  latestMeteorologicalDatasetId: text('latest_meteorological_dataset_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceUpdatedIdx: index('idx_platform_sessions_workspace_updated').on(table.workspaceId, table.updatedAt),
  ownerUpdatedIdx: index('idx_platform_sessions_owner_updated').on(table.createdByUserId, table.updatedAt),
}))

export const platformThreads = pgTable('platform_threads', {
  threadId: text('thread_id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => platformSessions.sessionId, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  createdByUserId: text('created_by_user_id').references(() => platformUsers.userId, { onDelete: 'set null' }),
  visibility: text('visibility').notNull().default('workspace'),
  title: text('title').notNull(),
  status: text('status').notNull().default('active'),
  latestRunId: text('latest_run_id'),
  latestUserQuery: text('latest_user_query'),
  latestAssistantSummary: text('latest_assistant_summary'),
  latestRunStatus: text('latest_run_status'),
  latestArtifactId: text('latest_artifact_id'),
  latestArtifactName: text('latest_artifact_name'),
  historyPreview: text('history_preview'),
  runCount: integer('run_count').notNull().default(0),
  nextEntrySequence: integer('next_entry_sequence').notNull().default(1),
  activeLeafEntryId: text('active_leaf_entry_id'),
  transcriptEntryCount: integer('transcript_entry_count').notNull().default(0),
  estimatedContextTokens: integer('estimated_context_tokens').notNull().default(0),
  latestCompactionId: text('latest_compaction_id'),
  memoryVersion: integer('memory_version').notNull().default(0),
  memoryBasedOnTokens: integer('memory_based_on_tokens').notNull().default(0),
  forkedFromThreadId: text('forked_from_thread_id'),
  forkedFromEntryId: text('forked_from_entry_id'),
  quarantined: boolean('quarantined').notNull().default(false),
  quarantineReason: text('quarantine_reason'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sessionUpdatedIdx: index('idx_platform_threads_session_updated').on(table.sessionId, table.updatedAt),
  workspaceUpdatedIdx: index('idx_platform_threads_workspace_updated').on(table.workspaceId, table.updatedAt),
}))

export const platformRuns = pgTable('platform_runs', {
  runId: text('run_id').primaryKey(),
  runKind: text('run_kind').notNull().default('root'),
  rootRunId: text('root_run_id').notNull().references((): AnyPgColumn => platformRuns.runId, { onDelete: 'cascade' }),
  parentRunId: text('parent_run_id').references((): AnyPgColumn => platformRuns.runId, { onDelete: 'cascade' }),
  parentTurnId: text('parent_turn_id'),
  rootTurnId: text('root_turn_id'),
  spawnCallId: text('spawn_call_id'),
  agentPath: text('agent_path').notNull().default('/root'),
  taskName: text('task_name'),
  agentRole: text('agent_role'),
  spawnDepth: integer('spawn_depth').notNull().default(0),
  forkMode: text('fork_mode').notNull().default('none'),
  forkTurnCount: integer('fork_turn_count'),
  modelOverride: text('model_override'),
  reasoningOverride: text('reasoning_override'),
  maxModelTokens: integer('max_model_tokens'),
  maxWallClockMs: integer('max_wall_clock_ms'),
  usedModelTokens: integer('used_model_tokens').notNull().default(0),
  nextAgentMessageSequence: integer('next_agent_message_sequence').notNull().default(1),
  sessionId: text('session_id').notNull().references(() => platformSessions.sessionId, { onDelete: 'cascade' }),
  threadId: text('thread_id').references(() => platformThreads.threadId, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  createdByUserId: text('created_by_user_id').references(() => platformUsers.userId, { onDelete: 'set null' }),
  visibility: text('visibility').notNull().default('workspace'),
  userQuery: text('user_query').notNull(),
  modelProvider: text('model_provider'),
  modelName: text('model_name'),
  status: text('status').notNull().default('queued'),
  runtimeConfigJson: jsonb('runtime_config_json').$type<Record<string, unknown>>(),
  activeEntryId: text('active_entry_id'),
  pendingToolCallIds: jsonb('pending_tool_call_ids').notNull().$type<string[]>().default([]),
  recoveryStatus: text('recovery_status').notNull().default('clean'),
  orchestrationEngine: text('orchestration_engine'),
  sdkStateContentHash: text('sdk_state_content_hash'),
  sdkVersion: text('sdk_version'),
  runtimeConfigDigest: text('runtime_config_digest'),
  sdkStateSchemaVersion: integer('sdk_state_schema_version'),
  sdkStateUpdatedAt: timestamp('sdk_state_updated_at', { withTimezone: true }),
  nextRecordSequence: integer('next_record_sequence').notNull().default(1),
  nextInputSequence: integer('next_input_sequence').notNull().default(1),
  checkpointInputCursor: integer('checkpoint_input_cursor').notNull().default(0),
  activeInputLeaseId: text('active_input_lease_id'),
  activeInputLeaseFrom: integer('active_input_lease_from'),
  activeInputLeaseTo: integer('active_input_lease_to'),
  terminalInputClaimId: text('terminal_input_claim_id'),
  terminalObjectiveRevision: integer('terminal_objective_revision'),
  terminalInputCursor: integer('terminal_input_cursor'),
  terminalClaimedAt: timestamp('terminal_claimed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  threadUpdatedIdx: index('idx_platform_runs_thread_updated').on(table.threadId, table.updatedAt),
  sessionUpdatedIdx: index('idx_platform_runs_session_updated').on(table.sessionId, table.updatedAt),
  workspaceUpdatedIdx: index('idx_platform_runs_workspace_updated').on(table.workspaceId, table.updatedAt),
  statusUpdatedIdx: index('idx_platform_runs_status_updated').on(table.status, table.updatedAt),
  parentSpawnIdx: uniqueIndex('idx_platform_runs_parent_spawn_unique').on(table.parentRunId, table.spawnCallId),
  rootAgentPathIdx: uniqueIndex('idx_platform_runs_root_agent_path_unique').on(table.rootRunId, table.agentPath),
  identityCheck: check(
    'platform_runs_identity_check',
    sql`(
      ${table.runKind} = 'root'
      AND ${table.rootRunId} = ${table.runId}
      AND ${table.parentRunId} IS NULL
      AND ${table.parentTurnId} IS NULL
      AND ${table.rootTurnId} IS NULL
      AND ${table.spawnCallId} IS NULL
      AND ${table.agentPath} = '/root'
      AND ${table.taskName} IS NULL
      AND ${table.agentRole} IS NULL
      AND ${table.spawnDepth} = 0
      AND ${table.forkMode} = 'none'
      AND ${table.forkTurnCount} IS NULL
    ) OR (
      ${table.runKind} = 'child'
      AND ${table.rootRunId} <> ${table.runId}
      AND ${table.parentRunId} IS NOT NULL
      AND ${table.parentRunId} <> ${table.runId}
      AND ${table.parentTurnId} IS NOT NULL
      AND ${table.rootTurnId} IS NOT NULL
      AND ${table.spawnCallId} IS NOT NULL
      AND ${table.agentPath} ~ '^/root(/[a-z0-9_]+)+$'
      AND ${table.taskName} ~ '^[a-z0-9_]+$'
      AND ${table.agentRole} IS NOT NULL
      AND ${table.spawnDepth} > 0
      AND ${table.forkMode} IN ('none', 'full_history', 'last_n_turns')
      AND ((${table.forkMode} = 'last_n_turns') = (${table.forkTurnCount} IS NOT NULL))
    )`,
  ),
  budgetCheck: check(
    'platform_runs_budget_check',
    sql`${table.usedModelTokens} >= 0
      AND (${table.maxModelTokens} IS NULL OR ${table.maxModelTokens} > 0)
      AND (${table.maxWallClockMs} IS NULL OR ${table.maxWallClockMs} > 0)
      AND (${table.maxModelTokens} IS NULL OR ${table.usedModelTokens} <= ${table.maxModelTokens})
      AND ${table.nextAgentMessageSequence} > 0`,
  ),
  inputCursorCheck: check(
    'platform_runs_input_cursor_check',
    sql`${table.nextInputSequence} > 0
      AND ${table.checkpointInputCursor} >= 0
      AND ${table.checkpointInputCursor} < ${table.nextInputSequence}
      AND (
        (${table.activeInputLeaseId} IS NULL AND ${table.activeInputLeaseFrom} IS NULL AND ${table.activeInputLeaseTo} IS NULL)
        OR (
          ${table.activeInputLeaseId} IS NOT NULL
          AND ${table.activeInputLeaseFrom} = ${table.checkpointInputCursor} + 1
          AND ${table.activeInputLeaseTo} >= ${table.activeInputLeaseFrom}
          AND ${table.activeInputLeaseTo} < ${table.nextInputSequence}
        )
      )`,
  ),
  terminalClaimCheck: check(
    'platform_runs_terminal_input_claim_check',
    sql`(
      ${table.terminalInputClaimId} IS NULL
      AND ${table.terminalObjectiveRevision} IS NULL
      AND ${table.terminalInputCursor} IS NULL
      AND ${table.terminalClaimedAt} IS NULL
    ) OR (
      ${table.terminalInputClaimId} IS NOT NULL
      AND ${table.terminalObjectiveRevision} = ${table.nextInputSequence}
      AND ${table.terminalInputCursor} = ${table.checkpointInputCursor}
      AND ${table.activeInputLeaseId} IS NULL
      AND ${table.terminalClaimedAt} IS NOT NULL
    )`,
  ),
}))

export const platformRootRunBudgets = pgTable('platform_root_run_budgets', {
  rootRunId: text('root_run_id').primaryKey().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  maxConcurrentChildren: integer('max_concurrent_children').notNull().default(3),
  maxSpawnDepth: integer('max_spawn_depth').notNull().default(3),
  maxTotalChildren: integer('max_total_children').notNull().default(12),
  maxTotalModelTokens: integer('max_total_model_tokens'),
  maxWallClockMs: integer('max_wall_clock_ms'),
  totalChildren: integer('total_children').notNull().default(0),
  activeChildren: integer('active_children').notNull().default(0),
  usedModelTokens: integer('used_model_tokens').notNull().default(0),
  version: integer('version').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  countersCheck: check(
    'platform_root_run_budgets_counters_check',
    sql`${table.maxConcurrentChildren} > 0
      AND ${table.maxSpawnDepth} >= 0
      AND ${table.maxTotalChildren} > 0
      AND ${table.totalChildren} >= 0
      AND ${table.activeChildren} >= 0
      AND ${table.activeChildren} <= ${table.totalChildren}
      AND ${table.activeChildren} <= ${table.maxConcurrentChildren}
      AND ${table.totalChildren} <= ${table.maxTotalChildren}
      AND ${table.usedModelTokens} >= 0
      AND (${table.maxTotalModelTokens} IS NULL OR ${table.maxTotalModelTokens} > 0)
      AND (${table.maxWallClockMs} IS NULL OR ${table.maxWallClockMs} > 0)
      AND (${table.maxTotalModelTokens} IS NULL OR ${table.usedModelTokens} <= ${table.maxTotalModelTokens})
      AND ${table.version} >= 0`,
  ),
}))

export const platformAgentMessages = pgTable('platform_agent_messages', {
  messageId: text('message_id').primaryKey(),
  rootRunId: text('root_run_id').notNull().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  senderRunId: text('sender_run_id').notNull().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  receiverRunId: text('receiver_run_id').notNull().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  parentTurnId: text('parent_turn_id').notNull(),
  rootTurnId: text('root_turn_id').notNull(),
  sequence: integer('sequence').notNull(),
  kind: text('kind').notNull(),
  content: text('content').notNull(),
  triggerTurn: boolean('trigger_turn').notNull().default(false),
  status: text('status').notNull().default('queued'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  checkpointedAt: timestamp('checkpointed_at', { withTimezone: true }),
}, (table) => ({
  receiverSequenceIdx: uniqueIndex('idx_platform_agent_messages_receiver_sequence_unique')
    .on(table.receiverRunId, table.sequence),
  receiverStatusIdx: index('idx_platform_agent_messages_receiver_status')
    .on(table.receiverRunId, table.status, table.sequence),
  messageCheck: check(
    'platform_agent_messages_state_check',
    sql`${table.senderRunId} <> ${table.receiverRunId}
      AND ${table.sequence} > 0
      AND length(${table.content}) > 0
      AND ${table.kind} IN ('input', 'message', 'completion')
      AND ${table.status} IN ('queued', 'delivered', 'checkpointed')
      AND (
        (${table.status} = 'queued' AND ${table.deliveredAt} IS NULL AND ${table.checkpointedAt} IS NULL)
        OR (${table.status} = 'delivered' AND ${table.deliveredAt} IS NOT NULL AND ${table.checkpointedAt} IS NULL)
        OR (${table.status} = 'checkpointed' AND ${table.deliveredAt} IS NOT NULL AND ${table.checkpointedAt} IS NOT NULL)
      )`,
  ),
}))

// Agent control plane 的 append-only 领域事件与 reducer snapshot。
// platform_run_snapshots 是运行状态、checkpoint 与输入投影的唯一权威读源；
// platform_runs 仅保留身份、归属、预算和查询投影。
export const platformRunDomainEvents = pgTable('platform_run_domain_events', {
  eventId: text('event_id').primaryKey(),
  runId: text('run_id').notNull().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  eventType: text('event_type').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  objectiveRevision: integer('objective_revision').notNull(),
  turnId: text('turn_id'),
  stepId: text('step_id'),
  causationId: text('causation_id'),
  correlationId: text('correlation_id').notNull(),
  actorKind: text('actor_kind').notNull(),
  actorId: text('actor_id'),
  payloadJson: jsonb('payload_json').notNull().$type<Record<string, unknown>>(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
}, (table) => ({
  runSequenceIdx: uniqueIndex('idx_run_domain_events_run_sequence_unique').on(table.runId, table.sequence),
  runTypeIdx: index('idx_run_domain_events_run_type').on(table.runId, table.eventType, table.sequence),
  objectiveRevisionCheck: check(
    'platform_run_domain_events_objective_revision_check',
    sql`${table.objectiveRevision} > 0`,
  ),
  sequenceCheck: check('platform_run_domain_events_sequence_check', sql`${table.sequence} > 0`),
  schemaVersionCheck: check(
    'platform_run_domain_events_schema_version_check',
    sql`${table.schemaVersion} > 0`,
  ),
}))

export const platformRunSnapshots = pgTable('platform_run_snapshots', {
  runId: text('run_id').primaryKey().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull().default(0),
  snapshotSchemaVersion: integer('snapshot_schema_version').notNull(),
  stateJson: jsonb('state_json').notNull().$type<Record<string, unknown>>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sequenceCheck: check('platform_run_snapshots_sequence_check', sql`${table.sequence} >= 0`),
  schemaVersionCheck: check(
    'platform_run_snapshots_schema_version_check',
    sql`${table.snapshotSchemaVersion} > 0`,
  ),
}))

// ContextWindow 跨越同一运行内的多次模型请求。只有真实压缩或换窗才关闭
// 当前行并创建下一代；活动窗口由每个 run 唯一的 partial index 约束。
export const platformContextWindows = pgTable('platform_context_windows', {
  contextWindowId: text('context_window_id').primaryKey(),
  runId: text('run_id').notNull().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  generation: integer('generation').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  promptProtocolVersion: text('prompt_protocol_version').notNull(),
  sourceDigest: text('source_digest').notNull(),
  sourceSummaryJson: jsonb('source_summary_json').notNull().$type<Record<string, unknown>>(),
  compactionJson: jsonb('compaction_json').$type<Record<string, unknown>>(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (table) => ({
  runGenerationIdx: uniqueIndex('idx_context_windows_run_generation_unique')
    .on(table.runId, table.generation),
  activeRunIdx: uniqueIndex('idx_context_windows_active_run_unique')
    .on(table.runId)
    .where(sql`${table.closedAt} IS NULL`),
  generationCheck: check('platform_context_windows_generation_check', sql`${table.generation} > 0`),
  schemaVersionCheck: check('platform_context_windows_schema_version_check', sql`${table.schemaVersion} > 0`),
}))

// 每个 Run 的 GIS 世界快照与显式 patch diff。revision 是该世界的唯一
// 乐观并发令牌；真实图层、数据集、文件和 Artifact 仍由各自业务表拥有。
export const platformGeoWorldSnapshots = pgTable('platform_geo_world_snapshots', {
  runId: text('run_id').notNull().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  revision: integer('revision').notNull().default(1),
  stateSchemaVersion: integer('state_schema_version').notNull(),
  stateDigest: text('state_digest').notNull(),
  stateJson: jsonb('state_json').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  primaryKey: primaryKey({
    columns: [table.runId, table.revision],
    name: 'platform_geo_world_snapshots_pk',
  }),
  workspaceCreatedIdx: index('idx_geo_world_snapshots_workspace_created').on(table.workspaceId, table.createdAt),
  revisionCheck: check('platform_geo_world_snapshots_revision_check', sql`${table.revision} > 0`),
  schemaVersionCheck: check('platform_geo_world_snapshots_schema_version_check', sql`${table.stateSchemaVersion} > 0`),
}))

export const platformGeoWorldDiffs = pgTable('platform_geo_world_diffs', {
  diffId: text('diff_id').primaryKey(),
  runId: text('run_id').notNull().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  fromRevision: integer('from_revision').notNull(),
  toRevision: integer('to_revision').notNull(),
  diffJson: jsonb('diff_json').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, (table) => ({
  runToRevisionIdx: uniqueIndex('idx_geo_world_diffs_run_to_revision_unique').on(table.runId, table.toRevision),
  fromRevisionCheck: check('platform_geo_world_diffs_from_revision_check', sql`${table.fromRevision} > 0`),
  revisionStepCheck: check('platform_geo_world_diffs_revision_step_check', sql`${table.toRevision} = ${table.fromRevision} + 1`),
}))

// StepContext 是模型请求级不可变事实。模型可见工具计划、授权和世界 revision
// 都由同一记录绑定；后续配置变化只能生成下一条 context。
export const platformAgentStepContexts = pgTable('platform_agent_step_contexts', {
  stepId: text('step_id').primaryKey(),
  runId: text('run_id').notNull().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  turnId: text('turn_id').notNull(),
  segmentId: text('segment_id').notNull(),
  modelRequestIndex: integer('model_request_index').notNull(),
  objectiveRevision: integer('objective_revision').notNull(),
  inputCursor: integer('input_cursor').notNull(),
  worldRevision: integer('world_revision').notNull(),
  runtimeConfigDigest: text('runtime_config_digest').notNull(),
  toolPlanDigest: text('tool_plan_digest').notNull(),
  contextDigest: text('context_digest').notNull(),
  contextJson: jsonb('context_json').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, (table) => ({
  worldSnapshotFk: foreignKey({
    columns: [table.runId, table.worldRevision],
    foreignColumns: [platformGeoWorldSnapshots.runId, platformGeoWorldSnapshots.revision],
    name: 'platform_agent_step_contexts_world_snapshot_fk',
  }).onDelete('cascade'),
  runRequestIdx: uniqueIndex('idx_agent_step_contexts_run_request_unique').on(table.runId, table.modelRequestIndex),
  turnRequestIdx: index('idx_agent_step_contexts_turn_request').on(table.turnId, table.modelRequestIndex),
  requestIndexCheck: check('platform_agent_step_contexts_request_index_check', sql`${table.modelRequestIndex} > 0`),
  objectiveRevisionCheck: check('platform_agent_step_contexts_objective_revision_check', sql`${table.objectiveRevision} > 0`),
  inputCursorCheck: check('platform_agent_step_contexts_input_cursor_check', sql`${table.inputCursor} >= 0`),
  worldRevisionCheck: check('platform_agent_step_contexts_world_revision_check', sql`${table.worldRevision} > 0`),
}))

// Provider 发包前提交的精确模型请求日志。完整请求正文保存在内容寻址对象中，
// 此表只保存恢复、归属和一致性校验所需的结构化摘要。
export const platformModelRequestRecords = pgTable('platform_model_request_records', {
  requestId: text('request_id').primaryKey(),
  schemaVersion: integer('schema_version').notNull(),
  runId: text('run_id').notNull().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  turnId: text('turn_id').notNull(),
  stepId: text('step_id').notNull().references(() => platformAgentStepContexts.stepId, { onDelete: 'cascade' }),
  segmentId: text('segment_id').notNull(),
  objectiveRevision: integer('objective_revision').notNull(),
  inputCursor: integer('input_cursor').notNull(),
  contextWindowId: text('context_window_id').notNull().references(
    () => platformContextWindows.contextWindowId,
    { onDelete: 'restrict' },
  ),
  contextDigest: text('context_digest').notNull(),
  agentStepContextSchemaVersion: integer('agent_step_context_schema_version').notNull(),
  provider: text('provider').notNull(),
  modelId: text('model_id').notNull(),
  inputObjectHash: text('input_object_hash').notNull(),
  inputDigest: text('input_digest').notNull(),
  instructionsDigest: text('instructions_digest').notNull(),
  toolPlanDigest: text('tool_plan_digest').notNull(),
  worldRevision: integer('world_revision').notNull(),
  inputEntryIds: jsonb('input_entry_ids').notNull().$type<string[]>().default([]),
  summaryObjectHashes: jsonb('summary_object_hashes').notNull().$type<string[]>().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, (table) => ({
  runStepIdx: uniqueIndex('idx_model_request_records_run_step_unique').on(table.runId, table.stepId),
  runCreatedIdx: index('idx_model_request_records_run_created').on(table.runId, table.createdAt),
  schemaVersionCheck: check(
    'platform_model_request_records_schema_version_check',
    sql`${table.schemaVersion} > 0`,
  ),
  worldRevisionCheck: check('platform_model_request_records_world_revision_check', sql`${table.worldRevision} > 0`),
  objectiveRevisionCheck: check('platform_model_request_records_objective_revision_check', sql`${table.objectiveRevision} > 0`),
  inputCursorCheck: check('platform_model_request_records_input_cursor_check', sql`${table.inputCursor} >= 0`),
  stepContextSchemaVersionCheck: check(
    'platform_model_request_records_step_context_schema_version_check',
    sql`${table.agentStepContextSchemaVersion} > 0`,
  ),
}))

// 纯辅助模型结果缓存不是对话事实源；删除或过期不会影响 Run/Thread 恢复。
// 仅保存内容哈希与已校验的小型结果，避免持久化原始提示词。
export const platformModelResultCache = pgTable('platform_model_result_cache', {
  cacheKey: text('cache_key').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  purpose: text('purpose').notNull(),
  content: text('content').notNull(),
  usageJson: jsonb('usage_json').notNull().$type<Record<string, number>>().default({}),
  hitCount: integer('hit_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceExpiryIdx: index('idx_model_result_cache_workspace_expiry').on(table.workspaceId, table.expiresAt),
  expiryIdx: index('idx_model_result_cache_expiry').on(table.expiresAt),
  hitCountCheck: check('platform_model_result_cache_hit_count_check', sql`${table.hitCount} >= 0`),
}))

export const platformConversationEntries = pgTable('platform_conversation_entries', {
  entryId: text('entry_id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => platformSessions.sessionId, { onDelete: 'cascade' }),
  threadId: text('thread_id').notNull().references(() => platformThreads.threadId, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => platformRuns.runId, { onDelete: 'set null' }),
  turnId: text('turn_id'),
  sequence: integer('sequence').notNull(),
  parentEntryId: text('parent_entry_id').references((): AnyPgColumn => platformConversationEntries.entryId, { onDelete: 'set null' }),
  logicalParentEntryId: text('logical_parent_entry_id').references((): AnyPgColumn => platformConversationEntries.entryId, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  payloadJson: jsonb('payload_json').notNull().$type<Record<string, unknown>>(),
  traceId: text('trace_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  threadSequenceIdx: uniqueIndex('idx_conversation_entries_thread_sequence_unique').on(table.threadId, table.sequence),
  runCreatedIdx: index('idx_conversation_entries_run_created').on(table.runId, table.createdAt),
  parentIdx: index('idx_conversation_entries_parent').on(table.parentEntryId),
}))

export const platformThreadMemoryVersions = pgTable('platform_thread_memory_versions', {
  threadId: text('thread_id').notNull().references(() => platformThreads.threadId, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  contentHash: text('content_hash').notNull(),
  source: text('source').notNull(),
  basedOnEntryId: text('based_on_entry_id').references(() => platformConversationEntries.entryId, { onDelete: 'set null' }),
  estimatedTokens: integer('estimated_tokens').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  primaryKey: primaryKey({ columns: [table.threadId, table.version] }),
  threadCreatedIdx: index('idx_thread_memory_versions_thread_created').on(table.threadId, table.createdAt),
}))

export const platformThreadCompactions = pgTable('platform_thread_compactions', {
  compactionId: text('compaction_id').primaryKey(),
  threadId: text('thread_id').notNull().references(() => platformThreads.threadId, { onDelete: 'cascade' }),
  boundaryEntryId: text('boundary_entry_id').notNull().references(() => platformConversationEntries.entryId, { onDelete: 'cascade' }),
  summaryEntryId: text('summary_entry_id').notNull().references(() => platformConversationEntries.entryId, { onDelete: 'cascade' }),
  firstCompactedEntryId: text('first_compacted_entry_id').notNull().references(() => platformConversationEntries.entryId, { onDelete: 'cascade' }),
  lastCompactedEntryId: text('last_compacted_entry_id').notNull().references(() => platformConversationEntries.entryId, { onDelete: 'cascade' }),
  preservedFromEntryId: text('preserved_from_entry_id').references(() => platformConversationEntries.entryId, { onDelete: 'set null' }),
  sourceDigest: text('source_digest').notNull(),
  sourceEntryIdsJson: jsonb('source_entry_ids_json').notNull().$type<string[]>(),
  sourceUnitIdsJson: jsonb('source_unit_ids_json').notNull().$type<string[]>(),
  sourceObjectHashesJson: jsonb('source_object_hashes_json').notNull().$type<string[]>(),
  summary: text('summary').notNull(),
  strategy: text('strategy').notNull(),
  summaryProvider: text('summary_provider').notNull(),
  summaryModel: text('summary_model').notNull(),
  promptVersion: text('prompt_version').notNull(),
  preTokens: integer('pre_tokens').notNull(),
  postTokens: integer('post_tokens').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  threadCreatedIdx: index('idx_thread_compactions_thread_created').on(table.threadId, table.createdAt),
  sourceDigestCheck: check(
    'platform_thread_compactions_source_digest_check',
    sql`${table.sourceDigest} ~ '^[a-f0-9]{64}$'`,
  ),
  sourceEntryIdsCheck: check(
    'platform_thread_compactions_source_entry_ids_json_check',
    sql`jsonb_typeof(${table.sourceEntryIdsJson}) = 'array' AND jsonb_array_length(${table.sourceEntryIdsJson}) > 0`,
  ),
  sourceUnitIdsCheck: check(
    'platform_thread_compactions_source_unit_ids_json_check',
    sql`jsonb_typeof(${table.sourceUnitIdsJson}) = 'array' AND jsonb_array_length(${table.sourceUnitIdsJson}) > 0`,
  ),
  sourceObjectHashesCheck: check(
    'platform_thread_compactions_source_object_hashes_json_check',
    sql`jsonb_typeof(${table.sourceObjectHashesJson}) = 'array' AND jsonb_array_length(${table.sourceObjectHashesJson}) > 0`,
  ),
  preTokensCheck: check('platform_thread_compactions_pre_tokens_check', sql`${table.preTokens} >= 0`),
  postTokensCheck: check('platform_thread_compactions_post_tokens_check', sql`${table.postTokens} >= 0`),
}))

// 运行记录统一保存 UI item、进度事件、工具 value 和诊断事件；recordType 决定
// 对应的 Zod payload schema，避免继续为每一种记录增加 JSONL 文件。
export const platformRunRecords = pgTable('platform_run_records', {
  recordId: text('record_id').primaryKey(),
  runId: text('run_id').notNull().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  threadId: text('thread_id').references(() => platformThreads.threadId, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  recordType: text('record_type').notNull(),
  payloadJson: jsonb('payload_json').notNull().$type<Record<string, unknown>>(),
  traceId: text('trace_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runSequenceIdx: uniqueIndex('idx_run_records_run_sequence_unique').on(table.runId, table.sequence),
  runTypeCreatedIdx: index('idx_run_records_run_type_created').on(table.runId, table.recordType, table.createdAt),
  traceIdx: index('idx_run_records_trace').on(table.traceId),
}))

export const platformToolInvocations = pgTable('platform_tool_invocations', {
  invocationId: text('invocation_id').primaryKey(),
  runId: text('run_id').notNull().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  turnId: text('turn_id').notNull(),
  callId: text('call_id').notNull(),
  stepId: text('step_id'),
  toolName: text('tool_name').notNull(),
  toolKind: text('tool_kind').notNull(),
  executionSurface: text('execution_surface').notNull(),
  objectiveRevision: integer('objective_revision').notNull(),
  toolPlanDigest: text('tool_plan_digest').notNull(),
  descriptorDigest: text('descriptor_digest').notNull(),
  argsDigest: text('args_digest').notNull(),
  effect: text('effect').notNull(),
  replayPolicy: text('replay_policy').notNull(),
  idempotencyKey: text('idempotency_key'),
  approvalAction: text('approval_action'),
  approvalDecision: text('approval_decision'),
  status: text('status').notNull(),
  terminalOutcome: text('terminal_outcome'),
  resultId: text('result_id'),
  error: text('error'),
  preparedAt: timestamp('prepared_at', { withTimezone: true }).notNull().defaultNow(),
  runningAt: timestamp('running_at', { withTimezone: true }),
  terminalAt: timestamp('terminal_at', { withTimezone: true }),
  checkpointedAt: timestamp('checkpointed_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
}, (table) => ({
  runCallIdx: uniqueIndex('idx_tool_invocations_run_call_unique').on(table.runId, table.callId),
  runStatusIdx: index('idx_tool_invocations_run_status').on(table.runId, table.status, table.preparedAt),
  objectiveRevisionCheck: check(
    'platform_tool_invocations_objective_revision_check',
    sql`${table.objectiveRevision} > 0`,
  ),
  versionCheck: check('platform_tool_invocations_version_check', sql`${table.version} > 0`),
  kindCheck: check(
    'platform_tool_invocations_kind_check',
    sql`${table.toolKind} IN ('platform', 'subagent', 'handoff', 'mcp', 'hosted', 'sandbox', 'unavailable')`,
  ),
  surfaceCheck: check(
    'platform_tool_invocations_surface_check',
    sql`${table.executionSurface} IN ('agent', 'automation', 'developer')`,
  ),
  effectCheck: check(
    'platform_tool_invocations_effect_check',
    sql`${table.effect} IN ('read', 'world_write', 'external_write', 'destructive')`,
  ),
  replayPolicyCheck: check(
    'platform_tool_invocations_replay_policy_check',
    sql`${table.replayPolicy} IN ('safe', 'idempotency_key', 'manual_recovery')`,
  ),
  approvalDecisionCheck: check(
    'platform_tool_invocations_approval_decision_check',
    sql`${table.approvalDecision} IS NULL OR ${table.approvalDecision} IN ('not_required', 'approved', 'rejected')`,
  ),
  statusCheck: check(
    'platform_tool_invocations_status_check',
    sql`${table.status} IN ('prepared', 'running', 'succeeded', 'failed', 'rejected', 'aborted', 'checkpointed')`,
  ),
  stateCheck: check(
    'platform_tool_invocations_state_check',
    sql`(
      ${table.status} = 'prepared'
      AND ${table.runningAt} IS NULL
      AND ${table.terminalAt} IS NULL
      AND ${table.checkpointedAt} IS NULL
      AND ${table.resultId} IS NULL
      AND ${table.error} IS NULL
      AND ${table.terminalOutcome} IS NULL
    ) OR (
      ${table.status} = 'running'
      AND ${table.runningAt} IS NOT NULL
      AND ${table.terminalAt} IS NULL
      AND ${table.checkpointedAt} IS NULL
      AND ${table.resultId} IS NULL
      AND ${table.error} IS NULL
      AND ${table.terminalOutcome} IS NULL
    ) OR (
      ${table.status} = 'succeeded'
      AND ${table.runningAt} IS NOT NULL
      AND ${table.terminalAt} IS NOT NULL
      AND ${table.checkpointedAt} IS NULL
      AND ${table.error} IS NULL
      AND ${table.terminalOutcome} = 'succeeded'
    ) OR (
      ${table.status} IN ('failed', 'rejected', 'aborted')
      AND ${table.terminalAt} IS NOT NULL
      AND ${table.checkpointedAt} IS NULL
      AND ${table.resultId} IS NULL
      AND ${table.error} IS NOT NULL
      AND ${table.terminalOutcome} = ${table.status}
    ) OR (
      ${table.status} = 'checkpointed'
      AND ${table.terminalAt} IS NOT NULL
      AND ${table.checkpointedAt} IS NOT NULL
      AND ${table.terminalOutcome} IN ('succeeded', 'failed', 'rejected', 'aborted')
      AND (
        (${table.terminalOutcome} = 'succeeded' AND ${table.error} IS NULL)
        OR (${table.terminalOutcome} <> 'succeeded' AND ${table.error} IS NOT NULL)
      )
    )`,
  ),
}))

export const platformApprovalRecords = pgTable('platform_approval_records', {
  approvalId: text('approval_id').primaryKey(),
  runId: text('run_id').notNull().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  threadId: text('thread_id').notNull().references(() => platformThreads.threadId, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().references(() => platformSessions.sessionId, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  invocationId: text('invocation_id').notNull().references(() => platformToolInvocations.invocationId, { onDelete: 'cascade' }),
  callId: text('call_id').notNull(),
  stepId: text('step_id').notNull(),
  contextDigest: text('context_digest').notNull(),
  actionKey: text('action_key').notNull(),
  actionJson: jsonb('action_json').notNull().$type<Record<string, unknown>>(),
  status: text('status').notNull(),
  decision: text('decision'),
  decisionScope: text('decision_scope'),
  decisionReason: text('decision_reason'),
  decidedByUserId: text('decided_by_user_id').references(() => platformUsers.userId, { onDelete: 'set null' }),
  sourceApprovalId: text('source_approval_id').references(
    (): AnyPgColumn => platformApprovalRecords.approvalId,
    { onDelete: 'set null' },
  ),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
}, (table) => ({
  runCallIdx: uniqueIndex('idx_approval_records_run_call_unique').on(table.runId, table.callId),
  sessionActionIdx: index('idx_approval_records_session_action').on(
    table.sessionId,
    table.actionKey,
    table.status,
    table.createdAt,
  ),
  runStatusIdx: index('idx_approval_records_run_status').on(table.runId, table.status, table.createdAt),
  statusCheck: check(
    'platform_approval_records_status_check',
    sql`${table.status} IN ('pending', 'resolved', 'consumed')`,
  ),
  decisionCheck: check(
    'platform_approval_records_decision_check',
    sql`${table.decision} IS NULL OR ${table.decision} IN ('approved', 'rejected')`,
  ),
  scopeCheck: check(
    'platform_approval_records_scope_check',
    sql`${table.decisionScope} IS NULL OR ${table.decisionScope} IN ('exact_call', 'session')`,
  ),
  versionCheck: check('platform_approval_records_version_check', sql`${table.version} > 0`),
  stateCheck: check(
    'platform_approval_records_state_check',
    sql`(
      ${table.status} = 'pending'
      AND ${table.decision} IS NULL
      AND ${table.decisionScope} IS NULL
      AND ${table.resolvedAt} IS NULL
      AND ${table.consumedAt} IS NULL
    ) OR (
      ${table.status} = 'resolved'
      AND ${table.decision} IS NOT NULL
      AND ${table.decisionScope} IS NOT NULL
      AND ${table.resolvedAt} IS NOT NULL
      AND ${table.consumedAt} IS NULL
    ) OR (
      ${table.status} = 'consumed'
      AND ${table.decision} IS NOT NULL
      AND ${table.decisionScope} IS NOT NULL
      AND ${table.resolvedAt} IS NOT NULL
      AND ${table.consumedAt} IS NOT NULL
    )`,
  ),
  rejectedScopeCheck: check(
    'platform_approval_records_rejected_scope_check',
    sql`${table.decision} <> 'rejected' OR (
      ${table.decisionScope} = 'exact_call' AND ${table.decisionReason} IS NOT NULL
    )`,
  ),
}))

export const platformToolResultCommits = pgTable('platform_tool_result_commits', {
  runId: text('run_id').notNull().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  invocationId: text('invocation_id').notNull().references(
    () => platformToolInvocations.invocationId,
    { onDelete: 'cascade' },
  ),
  resultId: text('result_id').notNull(),
  committedAt: timestamp('committed_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  primaryKey: primaryKey({ columns: [table.runId, table.invocationId] }),
}))

export const platformRunInputs = pgTable('platform_run_inputs', {
  inputId: text('input_id').primaryKey(),
  runId: text('run_id').notNull().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  threadId: text('thread_id').notNull().references(() => platformThreads.threadId, { onDelete: 'cascade' }),
  turnId: text('turn_id').notNull(),
  entryId: text('entry_id').notNull().references(() => platformConversationEntries.entryId, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull(),
  kind: text('kind').notNull().default('steering'),
  content: text('content').notNull(),
  inputSequence: integer('input_sequence').notNull(),
  status: text('status').notNull().default('queued'),
  queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
  leaseId: text('lease_id'),
  leasedAt: timestamp('leased_at', { withTimezone: true }),
  modelRequestId: text('model_request_id').references(() => platformModelRequestRecords.requestId, { onDelete: 'restrict' }),
  includedAt: timestamp('included_at', { withTimezone: true }),
  checkpointedAt: timestamp('checkpointed_at', { withTimezone: true }),
}, (table) => ({
  runStatusQueuedIdx: index('idx_run_inputs_run_status_queued').on(table.runId, table.status, table.inputSequence),
  runModelRequestIdx: index('idx_run_inputs_run_model_request').on(table.runId, table.modelRequestId),
  entryIdx: uniqueIndex('idx_run_inputs_entry_unique').on(table.entryId),
  sequenceCheck: check('platform_run_inputs_sequence_check', sql`${table.inputSequence} > 0`),
  contentCheck: check('platform_run_inputs_content_check', sql`length(btrim(${table.content})) > 0`),
  statusCheck: check(
    'platform_run_inputs_status_check',
    sql`${table.status} IN ('queued', 'leased', 'included', 'checkpointed')`,
  ),
  deliveryStateCheck: check(
    'platform_run_inputs_delivery_state_check',
    sql`(
      ${table.status} = 'queued'
      AND ${table.leaseId} IS NULL
      AND ${table.leasedAt} IS NULL
      AND ${table.modelRequestId} IS NULL
      AND ${table.includedAt} IS NULL
      AND ${table.checkpointedAt} IS NULL
    ) OR (
      ${table.status} = 'leased'
      AND ${table.leaseId} IS NOT NULL
      AND ${table.leasedAt} IS NOT NULL
      AND ${table.modelRequestId} IS NULL
      AND ${table.includedAt} IS NULL
      AND ${table.checkpointedAt} IS NULL
    ) OR (
      ${table.status} = 'included'
      AND ${table.leaseId} IS NOT NULL
      AND ${table.leasedAt} IS NOT NULL
      AND ${table.modelRequestId} IS NOT NULL
      AND ${table.includedAt} IS NOT NULL
      AND ${table.checkpointedAt} IS NULL
    ) OR (
      ${table.status} = 'checkpointed'
      AND ${table.leaseId} IS NOT NULL
      AND ${table.leasedAt} IS NOT NULL
      AND ${table.modelRequestId} IS NOT NULL
      AND ${table.includedAt} IS NOT NULL
      AND ${table.checkpointedAt} IS NOT NULL
    )`,
  ),
}))

export const platformEventOutbox = pgTable('platform_event_outbox', {
  outboxId: text('outbox_id').primaryKey(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  payloadJson: jsonb('payload_json').notNull().$type<Record<string, unknown>>(),
  traceId: text('trace_id'),
  attemptCount: integer('attempt_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (table) => ({
  unpublishedIdx: index('idx_event_outbox_unpublished').on(table.publishedAt, table.createdAt),
  aggregateIdx: index('idx_event_outbox_aggregate').on(table.aggregateType, table.aggregateId, table.createdAt),
}))

export const platformRbacPolicies = pgTable('platform_rbac_policies', {
  policyId: text('policy_id').primaryKey(),
  ptype: text('ptype').notNull(),
  v0: text('v0').notNull().default(''),
  v1: text('v1').notNull().default(''),
  v2: text('v2').notNull().default(''),
  v3: text('v3').notNull().default(''),
  v4: text('v4').notNull().default(''),
  v5: text('v5').notNull().default(''),
}, (table) => ({
  policyIdx: uniqueIndex('idx_platform_rbac_policy_unique').on(table.ptype, table.v0, table.v1, table.v2, table.v3, table.v4, table.v5),
}))

export const platformAuditEvents = pgTable('platform_audit_events', {
  auditEventId: text('audit_event_id').primaryKey(),
  actorUserId: text('actor_user_id').references(() => platformUsers.userId, { onDelete: 'set null' }),
  workspaceId: text('workspace_id').references(() => platformWorkspaces.workspaceId, { onDelete: 'set null' }),
  action: text('action').notNull(),
  objectType: text('object_type').notNull(),
  objectId: text('object_id'),
  outcome: text('outcome').notNull().default('allowed'),
  metadataJson: jsonb('metadata_json').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceCreatedIdx: index('idx_platform_audit_workspace_created').on(table.workspaceId, table.createdAt),
  actorCreatedIdx: index('idx_platform_audit_actor_created').on(table.actorUserId, table.createdAt),
}))

export const platformArtifacts = pgTable('platform_artifacts', {
  artifactId: text('artifact_id').primaryKey(),
  runId: text('run_id').notNull().references(() => platformRuns.runId, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  createdByUserId: text('created_by_user_id').references(() => platformUsers.userId, { onDelete: 'set null' }),
  visibility: text('visibility').notNull().default('workspace'),
  artifactType: text('artifact_type').notNull(),
  name: text('name').notNull(),
  uri: text('uri').notNull(),
  displayJson: jsonb('display_json').notNull().$type<Record<string, unknown>>(),
  metadataJson: jsonb('metadata_json').notNull().default({}),
  contentRelativePath: text('content_relative_path').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runIdIdx: index('idx_platform_artifacts_run_id').on(table.runId),
}))

export const platformRuntimeConfig = pgTable('platform_runtime_config', {
  configKey: text('config_key').primaryKey(),
  revision: integer('revision').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  payloadJson: jsonb('payload_json').notNull().$type<Record<string, unknown>>(),
}, (table) => ({
  revisionCheck: check('platform_runtime_config_revision_check', sql`${table.revision} > 0`),
}))

export const platformModelProviders = pgTable('platform_model_providers', {
  providerId: text('provider_id').primaryKey(),
  revision: integer('revision').notNull().default(1),
  displayName: text('display_name').notNull(),
  baseUrl: text('base_url').notNull(),
  protocol: text('protocol').notNull(),
  modelsJson: jsonb('models_json').notNull().$type<unknown[]>(),
  defaultModel: text('default_model').notNull(),
  toolSchemaMode: text('tool_schema_mode').notNull(),
  apiKey: text('api_key'),
  createdByUserId: text('created_by_user_id').notNull().references(() => platformUsers.userId, { onDelete: 'restrict' }),
  lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  createdByIdx: index('idx_platform_model_providers_created_by').on(table.createdByUserId),
  revisionCheck: check('platform_model_providers_revision_check', sql`${table.revision} > 0`),
}))

export const toolCatalogEntries = pgTable('tool_catalog_entries', {
  toolName: text('tool_name').notNull(),
  toolKind: text('tool_kind').notNull(),
  payloadJson: jsonb('payload_json').notNull().$type<Record<string, unknown>>(),
  sortOrder: integer('sort_order').notNull().default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.toolName, table.toolKind] }),
}))

export const platformMapLayers = pgTable('platform_map_layers', {
  mapLayerId: text('map_layer_id').primaryKey(),
  ownershipScope: text('ownership_scope').notNull(),
  workspaceId: text('workspace_id').references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  threadId: text('thread_id').references(() => platformThreads.threadId, { onDelete: 'cascade' }),
  artifactId: text('artifact_id').references(() => platformArtifacts.artifactId, { onDelete: 'cascade' }),
  managedLayerKey: text('managed_layer_key'),
  title: text('title').notNull(),
  replacementGroup: text('replacement_group'),
  sourceType: text('source_type').notNull().default('artifact'),
  geometryType: text('geometry_type').notNull().default('unknown'),
  srid: integer('srid').notNull().default(4326),
  description: text('description').notNull().default(''),
  featureCount: integer('feature_count'),
  propertySchemaJson: jsonb('property_schema_json').notNull().$type<Array<Record<string, unknown>>>().default([]),
  category: text('category').notNull().default('general'),
  tagsJson: jsonb('tags_json').notNull().$type<string[]>().default([]),
  analysisCapabilitiesJson: jsonb('analysis_capabilities_json').notNull().$type<string[]>().default([]),
  sourceConfigSummary: text('source_config_summary'),
  sessionId: text('session_id').references(() => platformSessions.sessionId, { onDelete: 'cascade' }),
  createdByUserId: text('created_by_user_id').references(() => platformUsers.userId, { onDelete: 'set null' }),
  visibility: text('visibility').notNull().default('workspace'),
  readonly: boolean('readonly').notNull().default(false),
  status: text('status').notNull().default('ready'),
  errorMessage: text('error_message'),
  boundsJson: jsonb('bounds_json').notNull().$type<[number, number, number, number]>(),
  crs: text('crs').notNull(),
  minZoom: integer('min_zoom').notNull().default(0),
  maxZoom: integer('max_zoom').notNull().default(22),
  sourceJson: jsonb('source_json').notNull().$type<Record<string, unknown>>(),
  styleJson: jsonb('style_json').notNull().$type<Record<string, unknown>>(),
  legendJson: jsonb('legend_json').$type<Record<string, unknown> | null>(),
  temporalJson: jsonb('temporal_json').$type<Record<string, unknown> | null>(),
  capabilitiesJson: jsonb('capabilities_json').notNull().$type<Record<string, boolean>>(),
  dataVersion: integer('data_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  artifactIdx: uniqueIndex('idx_platform_map_layers_artifact_unique').on(table.artifactId),
  managedLayerIdx: uniqueIndex('idx_platform_map_layers_managed_unique').on(table.managedLayerKey),
  threadUpdatedIdx: index('idx_platform_map_layers_thread_updated').on(table.threadId, table.updatedAt),
  threadReplacementIdx: index('idx_platform_map_layers_thread_replacement').on(table.threadId, table.replacementGroup, table.updatedAt),
  workspaceUpdatedIdx: index('idx_platform_map_layers_workspace_updated').on(table.workspaceId, table.updatedAt),
}))

// 上传资源的结构化事实。文件字节只存在内容寻址对象存储；这张表拥有资源
// 归属、请求幂等键和 pending/ready/deleted 生命周期，避免文件系统元数据成为
// 第二套可写事实源。
export const platformFileObjects = pgTable('platform_file_objects', {
  fileId: text('file_id').primaryKey(),
  workspaceId: text('workspace_id').references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().references(() => platformSessions.sessionId, { onDelete: 'cascade' }),
  threadId: text('thread_id').notNull().references(() => platformThreads.threadId, { onDelete: 'cascade' }),
  createdByUserId: text('created_by_user_id').references(() => platformUsers.userId, { onDelete: 'set null' }),
  name: text('name').notNull(),
  sourceKey: text('source_key').notNull(),
  sourceRelativePath: text('source_relative_path'),
  relativePath: text('relative_path').notNull(),
  contentHash: text('content_hash').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  mediaType: text('media_type').notNull(),
  requestId: text('request_id'),
  status: text('status').notNull().default('pending'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  requestIdx: uniqueIndex('idx_platform_file_objects_thread_request_unique')
    .on(table.threadId, table.requestId)
    .where(sql`${table.requestId} IS NOT NULL`),
  readySourceIdx: uniqueIndex('idx_platform_file_objects_thread_source_ready_unique')
    .on(table.threadId, table.sourceKey)
    .where(sql`${table.status} = 'ready'`),
  threadStatusIdx: index('idx_platform_file_objects_thread_status_updated')
    .on(table.threadId, table.status, table.updatedAt),
  contentHashIdx: index('idx_platform_file_objects_content_hash').on(table.contentHash),
  statusCheck: check('platform_file_objects_status_check', sql`${table.status} IN ('pending', 'ready', 'deleted')`),
  sizeCheck: check('platform_file_objects_size_bytes_check', sql`${table.sizeBytes} >= 0`),
}))

export const platformMapScenes = pgTable('platform_map_scenes', {
  sceneId: text('scene_id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  threadId: text('thread_id').notNull().references(() => platformThreads.threadId, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  defaultLayersInitialized: boolean('default_layers_initialized').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  threadIdx: uniqueIndex('idx_platform_map_scenes_thread_unique').on(table.threadId),
  workspaceUpdatedIdx: index('idx_platform_map_scenes_workspace_updated').on(table.workspaceId, table.updatedAt),
}))

export const platformMapSceneLayers = pgTable('platform_map_scene_layers', {
  sceneId: text('scene_id').notNull().references(() => platformMapScenes.sceneId, { onDelete: 'cascade' }),
  mapLayerId: text('map_layer_id').notNull().references(() => platformMapLayers.mapLayerId, { onDelete: 'cascade' }),
  layerOrder: integer('layer_order').notNull(),
  visible: boolean('visible').notNull().default(true),
  opacity: integer('opacity_percent').notNull().default(100),
  styleOverrideJson: jsonb('style_override_json').$type<Record<string, unknown> | null>(),
  labelJson: jsonb('label_json').$type<Record<string, unknown> | null>(),
  currentFrameId: text('current_frame_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  pk: primaryKey({ columns: [table.sceneId, table.mapLayerId] }),
  orderIdx: uniqueIndex('idx_platform_map_scene_layers_order_unique').on(table.sceneId, table.layerOrder),
}))

export const platformLayerFeatures = pgTable('platform_layer_features', {
  mapLayerId: text('map_layer_id').notNull().references(() => platformMapLayers.mapLayerId, { onDelete: 'cascade' }),
  featureId: text('feature_id').notNull(),
  propertiesJson: jsonb('properties_json').notNull().$type<Record<string, unknown>>().default({}),
  geometry: geometry4326('geometry').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  pk: primaryKey({ columns: [table.mapLayerId, table.featureId] }),
  layerIdx: index('idx_platform_layer_features_layer').on(table.mapLayerId),
  geometryIdx: index('idx_platform_layer_features_geometry').using('gist', table.geometry),
}))

export const platformMeteorologicalDatasets = pgTable('platform_meteorological_datasets', {
  datasetId: text('dataset_id').primaryKey(),
  workspaceId: text('workspace_id').references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  createdByUserId: text('created_by_user_id').references(() => platformUsers.userId, { onDelete: 'set null' }),
  visibility: text('visibility').notNull().default('workspace'),
  sessionId: text('session_id').notNull().references(() => platformSessions.sessionId, { onDelete: 'cascade' }),
  threadId: text('thread_id').references(() => platformThreads.threadId, { onDelete: 'set null' }),
  filename: text('filename').notNull(),
  originalFilename: text('original_filename').notNull(),
  fileId: text('file_id'),
  fileRelativePath: text('file_relative_path').notNull(),
  sizeBytes: integer('size_bytes').notNull().default(0),
  contentHash: text('content_hash'),
  mediaType: text('media_type').notNull().default('application/octet-stream'),
  status: text('status').notNull().default('ready'),
  metadataJson: jsonb('metadata_json').notNull().$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sessionUpdatedIdx: index('idx_meteorological_datasets_session_updated').on(table.sessionId, table.updatedAt),
  threadUpdatedIdx: index('idx_meteorological_datasets_thread_updated').on(table.threadId, table.updatedAt),
}))

export const platformMeteorologicalJobs = pgTable('platform_meteorological_jobs', {
  jobId: text('job_id').primaryKey(),
  datasetId: text('dataset_id').notNull().references(() => platformMeteorologicalDatasets.datasetId, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  createdByUserId: text('created_by_user_id').references(() => platformUsers.userId, { onDelete: 'set null' }),
  sessionId: text('session_id').notNull().references(() => platformSessions.sessionId, { onDelete: 'cascade' }),
  threadId: text('thread_id').references(() => platformThreads.threadId, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  status: text('status').notNull(),
  message: text('message'),
  payloadJson: jsonb('payload_json').notNull().$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => ({
  datasetUpdatedIdx: index('idx_meteorological_jobs_dataset_updated').on(table.datasetId, table.updatedAt),
  sessionUpdatedIdx: index('idx_meteorological_jobs_session_updated').on(table.sessionId, table.updatedAt),
}))

export const platformAutomationDefinitions = pgTable('platform_automation_definitions', {
  automationId: text('automation_id').primaryKey(),
  workspaceId: text('workspace_id').references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  createdByUserId: text('created_by_user_id').references(() => platformUsers.userId, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  version: text('version').notNull(),
  revision: integer('revision').notNull().default(1),
  publishedRevision: integer('published_revision'),
  source: text('source').notNull().default('builtin'),
  lifecycle: text('lifecycle').notNull().default('published'),
  enabled: boolean('enabled').notNull().default(true),
  parametersSchemaJson: jsonb('parameters_schema_json').notNull().$type<Record<string, unknown>>().default({}),
  defaultParametersJson: jsonb('default_parameters_json').notNull().$type<Record<string, unknown>>().default({}),
  requiredToolsJson: jsonb('required_tools_json').notNull().$type<string[]>().default([]),
  requiresApproval: boolean('requires_approval').notNull().default(false),
  timeoutSeconds: integer('timeout_seconds').notNull().default(900),
  outputType: text('output_type').notNull().default('conversation'),
  definitionJson: jsonb('definition_json').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceUpdatedIdx: index('idx_automation_definitions_workspace_updated').on(table.workspaceId, table.updatedAt),
  sourceLifecycleIdx: index('idx_automation_definitions_source_lifecycle').on(table.source, table.lifecycle),
  sourceCheck: check('platform_automation_definitions_source_check', sql`${table.source} IN ('builtin', 'workspace')`),
  lifecycleCheck: check('platform_automation_definitions_lifecycle_check', sql`${table.lifecycle} IN ('draft', 'published', 'disabled')`),
  revisionCheck: check('platform_automation_definitions_revision_check', sql`${table.revision} > 0`),
  timeoutCheck: check('platform_automation_definitions_timeout_check', sql`${table.timeoutSeconds} > 0`),
  ownershipCheck: check('platform_automation_definitions_ownership_check', sql`(${table.source} = 'builtin' AND ${table.workspaceId} IS NULL) OR (${table.source} = 'workspace' AND ${table.workspaceId} IS NOT NULL)`),
}))

export const platformAutomationVersions = pgTable('platform_automation_versions', {
  automationId: text('automation_id').notNull().references(() => platformAutomationDefinitions.automationId, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  lifecycle: text('lifecycle').notNull(),
  definitionJson: jsonb('definition_json').notNull().$type<Record<string, unknown>>(),
  createdByUserId: text('created_by_user_id').references(() => platformUsers.userId, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (table) => ({
  pk: primaryKey({ columns: [table.automationId, table.revision], name: 'platform_automation_versions_pk' }),
  lifecycleIdx: index('idx_automation_versions_lifecycle').on(table.automationId, table.lifecycle),
  lifecycleCheck: check('platform_automation_versions_lifecycle_check', sql`${table.lifecycle} IN ('draft', 'published', 'archived')`),
  revisionCheck: check('platform_automation_versions_revision_check', sql`${table.revision} > 0`),
}))

export const platformScheduledTasks = pgTable('platform_scheduled_tasks', {
  taskId: text('task_id').primaryKey(),
  targetKind: text('target_kind').notNull(),
  targetId: text('target_id').notNull().references(() => platformAutomationDefinitions.automationId, { onDelete: 'restrict' }),
  workspaceId: text('workspace_id').notNull().references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  createdByUserId: text('created_by_user_id').notNull().references(() => platformUsers.userId, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  prompt: text('prompt').notNull(),
  parametersJson: jsonb('parameters_json').notNull().$type<Record<string, unknown>>().default({}),
  cron: text('cron').notNull(),
  timezone: text('timezone').notNull(),
  recurring: boolean('recurring').notNull().default(true),
  enabled: boolean('enabled').notNull().default(true),
  status: text('status').notNull().default('active'),
  lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
  nextFireAt: timestamp('next_fire_at', { withTimezone: true }),
  lastRunId: text('last_run_id').references(() => platformRuns.runId, { onDelete: 'set null' }),
  queueJobId: text('queue_job_id'),
  failureCount: integer('failure_count').notNull().default(0),
  lastErrorMessage: text('last_error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  workspaceNextIdx: index('idx_scheduled_tasks_workspace_next').on(table.workspaceId, table.nextFireAt),
  targetIdx: index('idx_scheduled_tasks_target').on(table.targetKind, table.targetId),
  targetKindCheck: check('platform_scheduled_tasks_target_kind_check', sql`${table.targetKind} = 'automation'`),
  statusCheck: check('platform_scheduled_tasks_status_check', sql`${table.status} IN ('active', 'paused', 'missed', 'failed', 'deleted')`),
  failureCountCheck: check('platform_scheduled_tasks_failure_count_check', sql`${table.failureCount} >= 0`),
}))

export const platformAutomationRuns = pgTable('platform_automation_runs', {
  automationRunId: text('automation_run_id').primaryKey(),
  automationId: text('automation_id').notNull(),
  automationRevision: integer('automation_revision').notNull(),
  scheduledTaskId: text('scheduled_task_id').references(() => platformScheduledTasks.taskId, { onDelete: 'set null' }),
  workspaceId: text('workspace_id').notNull().references(() => platformWorkspaces.workspaceId, { onDelete: 'cascade' }),
  createdByUserId: text('created_by_user_id').notNull().references(() => platformUsers.userId, { onDelete: 'restrict' }),
  runId: text('run_id').references(() => platformRuns.runId, { onDelete: 'set null' }),
  status: text('status').notNull().default('queued'),
  currentStep: text('current_step'),
  triggerKind: text('trigger_kind').notNull().default('manual'),
  errorMessage: text('error_message'),
  metadataJson: jsonb('metadata_json').notNull().$type<Record<string, unknown>>().default({}),
  nodeRunsJson: jsonb('node_runs_json').notNull().$type<Array<Record<string, unknown>>>().default([]),
  pendingApprovalJson: jsonb('pending_approval_json').$type<Record<string, unknown>>(),
  outputsJson: jsonb('outputs_json').notNull().$type<Record<string, unknown>>().default({}),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => ({
  workspaceStartedIdx: index('idx_automation_runs_workspace_started').on(table.workspaceId, table.startedAt),
  scheduledTaskStartedIdx: index('idx_automation_runs_scheduled_task_started').on(table.scheduledTaskId, table.startedAt),
  definitionRevisionFk: foreignKey({
    columns: [table.automationId, table.automationRevision],
    foreignColumns: [platformAutomationVersions.automationId, platformAutomationVersions.revision],
    name: 'platform_automation_runs_definition_revision_fk',
  }).onDelete('restrict'),
  statusCheck: check('platform_automation_runs_status_check', sql`${table.status} IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')`),
  triggerKindCheck: check('platform_automation_runs_trigger_kind_check', sql`${table.triggerKind} IN ('manual', 'schedule', 'agent')`),
}))

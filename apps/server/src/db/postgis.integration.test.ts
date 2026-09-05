// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostGIS 真实集成回归
//
//   该文件默认不启动容器；通过 `npm run test:postgis` 显式运行。
//   单元测试不应隐式依赖 Docker，集成测试则必须连接真实 PostGIS。
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { sql } from 'drizzle-orm'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDb, type Database } from './connection.js'
import { verifyDatabaseSchemaContract } from './schemaContract.js'
import { ManagedLayerService } from '../gis/managedLayers/managedLayerService.js'
import {
  agentStateSchema,
  analysisRunSchema,
} from '../schemas/types.js'
import {
  GeoWorldRevisionConflictError,
} from '../store/storeErrors.js'
import { GeoWorldRepository } from '../agent-runtime/world/GeoWorldRepository.js'
import { GeoWorldBaselineBuilder } from '../agent-runtime/world/GeoWorldBaselineBuilder.js'
import { AgentStepContextRepository } from '../agent-runtime/step/AgentStepContextRepository.js'
import { AgentStepContextFactory } from '../agent-runtime/step/AgentStepContextFactory.js'
import { agentContextDigest } from '../agent-runtime/step/agentContextDigest.js'
import { defaultRuntimeConfig } from '../agent/defaultRuntimeConfig.js'
import { PostgresConversationPersistence } from '../store/postgres/conversationPersistence.js'
import { PostgresChildRunRepository } from '../store/postgres/childRunRepository.js'
import { PostgresContextWindowRepository } from '../store/postgres/contextWindowRepository.js'
import { PostgresRunDomainJournalRepository } from '../store/postgres/runDomainJournalRepository.js'
import { buildRunCreatedEvents } from '../store/runDomainProjection.js'
import {
  replayGeoWorldDiff,
} from '@geo-agent-platform/shared-types/geo-world'

const integrationEnabled = process.env.RUN_POSTGIS_INTEGRATION === '1'
const externalDatabaseUrl = process.env.POSTGIS_TEST_DATABASE_URL?.trim() || null
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

describe.skipIf(!integrationEnabled)('真实 PostgreSQL/PostGIS 集成', () => {
  let container: StartedPostgreSqlContainer | null = null
  let client: Client
  let db: Database

  beforeAll(async () => {
    const connectionString = externalDatabaseUrl ?? await startPostgresContainer()
    client = new Client({ connectionString })
    await client.connect()
    await applyDatabaseSchema(client)

    db = createDb(connectionString)
    await verifyDatabaseSchemaContract(db)
  }, 180_000)

  afterAll(async () => {
    await db?.close()
    await client?.end()
    await container?.stop()
  }, 30_000)

  it('从单一权威基线初始化并验证 PostGIS 能力', async () => {
    const result = await db.execute<{ version: string }>(sql`
      SELECT postgis_full_version() AS version
    `)
    expect(result.rows[0]?.version).toMatch(/POSTGIS/u)
    const legacyRunStateColumn = await client.query(`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_runs'
        AND column_name = 'state_json'
    `)
    expect(legacyRunStateColumn.rowCount).toBe(0)
  })

  it('权威基线直接创建追加式 GeoWorld 主键', async () => {
    const primaryKey = await client.query<{ column_name: string }>(`
      SELECT attribute.attname AS column_name
      FROM pg_constraint constraint_row
      CROSS JOIN LATERAL unnest(constraint_row.conkey)
        WITH ORDINALITY AS key_column(attnum, ordinality)
      JOIN pg_attribute attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attnum = key_column.attnum
      WHERE constraint_row.conrelid = 'platform_geo_world_snapshots'::regclass
        AND constraint_row.contype = 'p'
      ORDER BY key_column.ordinality
    `)
    const legacyColumn = await client.query(`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_geo_world_snapshots'
        AND column_name = 'updated_at'
    `)

    expect(primaryKey.rows.map(row => row.column_name)).toEqual(['run_id', 'revision'])
    expect(legacyColumn.rowCount).toBe(0)
    await verifyDatabaseSchemaContract(db)
  })

  it('以真实行锁串行化 GeoWorld CAS 并保存不可变 StepContext', async () => {
    const userId = 'user_step_context'
    const workspaceId = 'workspace_step_context'
    const sessionId = 'session_step_context'
    const threadId = 'thread_step_context'
    const runId = 'run_step_context'
    const now = new Date('2026-08-21T00:00:00.000Z')
    const persistence = new PostgresConversationPersistence(db)
    const capabilities = {
      toolNames: ['list_layers'],
      mcpServerNames: [],
      sandboxBackend: 'disabled',
      writableRoots: [],
      networkPolicy: 'provider_and_registered_tools',
    }
    const artifact = {
      artifactId: 'artifact_step',
      runId,
      artifactType: 'geojson',
      name: '步骤上下文图层',
      uri: 'artifact://artifact_step',
      display: {
        surfaces: ['download'] as const,
        primarySurface: 'download' as const,
        map: null,
      },
      metadata: { contentHash: 'sha256:artifact-step' },
      isIntermediate: false,
    }
    const valueRef = {
      refId: 'value_step_count',
      kind: 'feature_count',
      label: '对象数',
      value: 13,
      unit: null,
      sourceTool: 'query_layer',
      sourceResultId: 'result_step',
      metadata: { layerId: 'layer_step' },
      createdAt: now.toISOString(),
    }

    try {
      await client.query(
        `INSERT INTO platform_users
           (user_id, subject, email, display_name, created_at, updated_at)
         VALUES ($1, $2, $3, '步骤上下文测试', $4, $4)`,
        [userId, userId, `${userId}@example.test`, now],
      )
      await client.query(
        `INSERT INTO platform_workspaces
           (workspace_id, name, created_by_user_id, created_at, updated_at)
         VALUES ($1, '步骤上下文工作区', $2, $3, $3)`,
        [workspaceId, userId, now],
      )
      await client.query(
        `INSERT INTO platform_sessions
           (session_id, workspace_id, created_by_user_id, visibility, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'private', 'active', $4, $4)`,
        [sessionId, workspaceId, userId, now],
      )
      await client.query(
        `INSERT INTO platform_threads
           (thread_id, session_id, workspace_id, created_by_user_id, visibility, title, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'private', '步骤上下文测试', $5, $5)`,
        [threadId, sessionId, workspaceId, userId, now],
      )
      await client.query(
        `INSERT INTO platform_runs
           (run_id, root_run_id, session_id, thread_id, workspace_id, created_by_user_id, visibility,
            user_query, status, created_at, updated_at)
         VALUES ($1, $1, $2, $3, $4, $5, 'private', '验证 GeoWorld CAS', 'running', $6, $6)`,
        [
          runId,
          sessionId,
          threadId,
          workspaceId,
          userId,
          now,
        ],
      )
      const persistedRun = analysisRunSchema.parse({
        id: runId,
        sessionId,
        threadId,
        workspaceId,
        createdByUserId: userId,
        visibility: 'private',
        userQuery: '验证 GeoWorld CAS',
        status: 'running',
        state: agentStateSchema.parse({
          sessionId,
          threadId,
          userQuery: '验证 GeoWorld CAS',
          artifacts: [artifact],
          toolValueRefs: [valueRef],
        }),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })
      await persistence.appendRunDomainEvents({
        runId,
        expectedSequence: 0,
        events: buildRunCreatedEvents(persistedRun, {
          activeEntryId: null,
          pendingToolCallIds: [],
          recoveryStatus: 'clean',
          orchestrationEngine: null,
          sdkStateContentHash: null,
          agentsSdkVersion: null,
          runtimeConfigDigest: null,
          sdkStateSchemaVersion: null,
          sdkStateUpdatedAt: null,
          nextInputSequence: 1,
          checkpointInputCursor: 0,
          activeInputLeaseId: null,
          activeInputLeaseFrom: null,
          activeInputLeaseTo: null,
          terminalInputClaimId: null,
          terminalObjectiveRevision: null,
          terminalInputCursor: null,
          terminalClaimedAt: null,
        }, 0),
      })

      await client.query(
        `INSERT INTO platform_artifacts
           (artifact_id, run_id, workspace_id, created_by_user_id, visibility,
            artifact_type, name, uri, display_json, metadata_json,
            content_relative_path, created_at)
         VALUES ($1, $2, $3, $4, 'private', $5, $6, $7, $8, $9, $10, $11)`,
        [
          artifact.artifactId,
          runId,
          workspaceId,
          userId,
          artifact.artifactType,
          artifact.name,
          artifact.uri,
          JSON.stringify(artifact.display),
          JSON.stringify(artifact.metadata),
          'artifacts/run_step_context/layer_step.geojson',
          now,
        ],
      )
      await client.query(
        `INSERT INTO platform_map_layers
           (map_layer_id, ownership_scope, workspace_id, thread_id, artifact_id,
            title, source_type, geometry_type, feature_count, property_schema_json,
            session_id, created_by_user_id, visibility, status, bounds_json, crs,
            source_json, style_json, capabilities_json, created_at, updated_at)
         VALUES ($1, 'thread', $2, $3, $4, $5, 'artifact', 'MultiPolygon', 13, $6,
                 $7, $8, 'private', 'ready', $9, 'OGC:CRS84', $10, $11, $12, $13, $13)`,
        [
          'layer_step',
          workspaceId,
          threadId,
          artifact.artifactId,
          artifact.name,
          JSON.stringify([{ name: 'district', type: 'string' }]),
          sessionId,
          userId,
          JSON.stringify([119, 29, 121, 31]),
          JSON.stringify({ type: 'geojson', contentHash: 'sha256:layer-step' }),
          JSON.stringify({ fillColor: '#2f9e8f' }),
          JSON.stringify({ queryable: true, exportable: true }),
          now,
        ],
      )
      await client.query(
        `INSERT INTO platform_map_scenes
           (scene_id, workspace_id, thread_id, version, created_at, updated_at)
         VALUES ('scene_step', $1, $2, 1, $3, $3)`,
        [workspaceId, threadId, now],
      )
      await client.query(
        `INSERT INTO platform_map_scene_layers
           (scene_id, map_layer_id, layer_order, visible, opacity_percent, updated_at)
         VALUES ('scene_step', 'layer_step', 0, TRUE, 100, $1)`,
        [now],
      )
      await client.query(
        `INSERT INTO platform_file_objects
           (file_id, workspace_id, session_id, thread_id, created_by_user_id,
            name, source_key, relative_path, content_hash, size_bytes, media_type,
            request_id, status, created_at, ready_at, updated_at)
         VALUES ('file_step', $1, $2, $3, $4, 'forecast.nc', 'forecast.nc',
                 'objects/sha256/file-step.nc', 'sha256:file-step', 2048,
                 'application/x-netcdf', 'request_step', 'ready', $5, $5, $5)`,
        [workspaceId, sessionId, threadId, userId, now],
      )
      await client.query(
        `INSERT INTO platform_meteorological_datasets
           (dataset_id, workspace_id, created_by_user_id, visibility, session_id,
            thread_id, filename, original_filename, file_id, file_relative_path,
            size_bytes, content_hash, media_type, status, metadata_json,
            created_at, updated_at)
         VALUES ('dataset_step', $1, $2, 'private', $3, $4, 'forecast.nc',
                 'forecast.nc', 'file_step', 'objects/sha256/file-step.nc', 2048,
                 'sha256:dataset-step', 'application/x-netcdf', 'ready', $5, $6, $6)`,
        [
          workspaceId,
          userId,
          sessionId,
          threadId,
          JSON.stringify({
            schemaHash: 'sha256:dataset-schema',
            temporalExtent: {
              start: '2026-08-21T00:00:00.000Z',
              end: '2026-08-21T06:00:00.000Z',
            },
            spatialExtent: [119, 29, 121, 31],
          }),
          now,
        ],
      )

      const worlds = new GeoWorldRepository(db)
      const baseline = await new GeoWorldBaselineBuilder(db).build(runId, capabilities)
      expect(baseline.map.selectedLayerIds).toEqual(['layer_step'])
      expect(baseline.layers).toHaveLength(1)
      expect(baseline.datasets).toEqual([
        expect.objectContaining({
          datasetId: 'dataset_step',
          contentHash: 'sha256:dataset-step',
          schemaHash: 'sha256:dataset-schema',
        }),
      ])
      expect(baseline.files).toEqual([
        expect.objectContaining({ fileId: 'file_step', contentHash: 'sha256:file-step' }),
      ])
      expect(baseline.artifacts).toEqual([artifact])
      expect(baseline.values).toEqual([valueRef])
      await worlds.ensureBaseline(runId, baseline)
      const baselineLayer = baseline.layers[0]!
      const competing = await Promise.allSettled([
        worlds.applyPatches({
          runId,
          expectedRevision: 1,
          patches: [{
            type: 'layer.updated',
            layerId: 'layer_step',
            expectedRevision: baselineLayer.revision,
            next: { ...baselineLayer, revision: 'layer_step@2a' },
          }],
        }),
        worlds.applyPatches({
          runId,
          expectedRevision: 1,
          patches: [{
            type: 'layer.updated',
            layerId: 'layer_step',
            expectedRevision: baselineLayer.revision,
            next: { ...baselineLayer, revision: 'layer_step@2b' },
          }],
        }),
      ])
      expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(competing.find(result => result.status === 'rejected')).toMatchObject({
        reason: expect.any(GeoWorldRevisionConflictError),
      })
      const snapshot = await worlds.require(runId)
      const baselineSnapshot = await worlds.getRevision(runId, 1)
      const currentSnapshot = await worlds.getRevision(runId, 2)
      const diffs = await worlds.listDiffs(runId, 1)
      expect(diffs).toHaveLength(1)
      expect(baselineSnapshot?.state).toEqual(baseline)
      expect(currentSnapshot).toEqual(snapshot)
      expect(replayGeoWorldDiff(baseline, diffs[0]!)).toEqual(snapshot.state)
      await expect(worlds.applyPatches({
        runId,
        expectedRevision: 2,
        patches: [{
          type: 'layer.updated',
          layerId: 'layer_step',
          expectedRevision: baselineLayer.revision,
          next: { ...baselineLayer, revision: 'layer_step@3' },
        }],
      })).rejects.toThrow(/revision 冲突/u)
      expect((await worlds.require(runId)).state.revision).toBe(2)

      const config = defaultRuntimeConfig()
      const entries = [{
        name: 'list_layers',
        namespace: 'layers',
        kind: 'platform' as const,
        providerId: 'layers',
        schemaDigest: 'sha256:list-layers-schema',
        definitionDigest: 'sha256:list-layers-definition',
        exposure: 'immediate' as const,
        effect: 'read' as const,
        parallelism: 'shared' as const,
        approvalAction: null,
        replayPolicy: 'safe' as const,
        requiredCapabilities: [],
        requiredValueRefKinds: [],
        executionSurfaces: ['agent' as const],
        deferLoading: false,
      }]
      const toolPlanWithoutDigest = {
        entries,
        namespaces: [],
        deferredCatalogObjectHash: null,
        unavailableReasons: {},
      }
      const toolPlan = {
        ...toolPlanWithoutDigest,
        catalogDigest: agentContextDigest(toolPlanWithoutDigest),
      }
      const stepContexts = new AgentStepContextFactory(
        new AgentStepContextRepository(db),
        worlds,
        { build: async () => { throw new Error('既有 baseline 不应重建') } },
        new PostgresContextWindowRepository(
          db,
          new PostgresRunDomainJournalRepository(db),
        ),
      )
      const capture = () => stepContexts.capture({
        runId,
        turnId: 'turn_step',
        segmentId: 'segment_step',
        objectiveRevision: 1,
        inputCursor: 0,
        provider: 'deepseek',
        modelId: 'deepseek-v4-flash',
        transport: 'deepseek_responses',
        modelCapabilities: {
          modelId: 'deepseek-v4-flash',
          contextWindowTokens: 1_000_000,
          capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
          modalities: ['text'],
        },
        reasoningEffort: 'none',
        serviceTier: null,
        timeoutMs: 0,
        runtimeConfig: config,
        runtimeConfigDigest: agentContextDigest(config),
        toolPlan,
        activeMcpServers: [],
        mcpToolServers: new Map(),
        mcpBinding: {
          bindingId: 'mcp_binding_disabled',
          catalogRevision: 0,
          configDigest: agentContextDigest(config.sdk.mcp),
          authDigest: agentContextDigest([]),
          capabilityRootDigest: agentContextDigest([]),
          toolCatalogDigest: agentContextDigest([]),
          resourceCatalogDigest: agentContextDigest([]),
          refreshReasons: ['initial'],
          servers: [],
        },
        activeSkills: [],
        skillInvocations: [],
        pluginSnapshot: {
          pluginIds: [],
          bindings: [],
          catalogDigest: agentContextDigest([]),
        },
        auth: null,
      })
      const contexts = await Promise.all([capture(), capture()])
      expect(contexts.map(context => context.identity.modelRequestIndex).sort()).toEqual([1, 2])
      expect(contexts.every(context => context.worldRevision === 2)).toBe(true)
      expect(new Set(contexts.map(context => context.contextWindowId)).size).toBe(1)
      expect(contexts.every(context => Object.isFrozen(context))).toBe(true)
      expect(contexts.every(context => Object.isFrozen(context.tools.entries))).toBe(true)
      await expect(stepContexts.getActiveContextWindow(runId)).resolves.toMatchObject({
        contextWindowId: contexts[0]!.contextWindowId,
        generation: 1,
        schemaVersion: 1,
        promptProtocolVersion: '1',
        closedAt: null,
      })
      const storedContexts = await new AgentStepContextRepository(db).list(runId)
      expect(storedContexts.every(context => Object.isFrozen(context))).toBe(true)
      expect(storedContexts).toEqual(contexts.sort((left, right) => (
        left.identity.modelRequestIndex - right.identity.modelRequestIndex
      )))
      const requestContext = storedContexts[0]!
      const committed = await persistence.commitModelRequest({
        schemaVersion: 2,
        requestId: 'model_request_no_lease',
        runId,
        turnId: requestContext.turnId,
        stepId: requestContext.identity.stepId,
        segmentId: requestContext.identity.segmentId,
        objectiveRevision: requestContext.objectiveRevision,
        inputCursor: requestContext.inputCursor,
        contextWindowId: requestContext.contextWindowId,
        contextDigest: requestContext.contextDigest,
        agentStepContextSchemaVersion: requestContext.schemaVersion,
        provider: requestContext.model.provider,
        modelId: requestContext.model.modelId,
        inputObjectHash: 'd'.repeat(64),
        inputDigest: `sha256:${'a'.repeat(64)}`,
        instructionsDigest: `sha256:${'b'.repeat(64)}`,
        toolPlanDigest: requestContext.toolPlanDigest,
        worldRevision: requestContext.worldRevision,
        summaryObjectHashes: [],
        createdAt: '2026-08-21T00:00:01.000Z',
      })
      expect(committed.record.inputEntryIds).toEqual([])
      const modelRequestVersion = await client.query<{ schema_version: number }>(
        `SELECT schema_version
           FROM platform_model_request_records
          WHERE request_id = $1`,
        [committed.record.requestId],
      )
      expect(modelRequestVersion.rows[0]?.schema_version).toBe(2)
      expect(await persistence.getActiveModelRequest(runId)).toEqual(committed.record)
      await persistence.saveAgentsSdkCheckpoint(runId, {
        contentHash: 'e'.repeat(64),
        agentsSdkVersion: '0.17.0',
        runtimeConfigDigest: 'runtime_no_lease',
        sdkStateSchemaVersion: 7,
        checkpointModelRequestStepId: null,
      })
      const restartedPersistence = new PostgresConversationPersistence(db)
      expect(await restartedPersistence.getActiveModelRequest(runId)).toEqual(committed.record)
      await restartedPersistence.saveAgentsSdkCheckpoint(runId, {
        contentHash: 'f'.repeat(64),
        agentsSdkVersion: '0.17.0',
        runtimeConfigDigest: 'runtime_no_lease',
        sdkStateSchemaVersion: 7,
        checkpointModelRequestStepId: requestContext.identity.stepId,
      })
      expect(await restartedPersistence.getActiveModelRequest(runId)).toBeNull()
      expect((await restartedPersistence.listRunDomainEvents(runId)).map(event => event.type))
        .toEqual(expect.arrayContaining([
          'context.window_started',
          'step.model_request_committed',
          'step.model_request_checkpointed',
        ]))

      const snapshotRows = await client.query<{ revision: number }>(
        `SELECT revision
           FROM platform_geo_world_snapshots
          WHERE run_id = $1
          ORDER BY revision`,
        [runId],
      )
      expect(snapshotRows.rows.map(row => row.revision)).toEqual([1, 2])
      await expect(client.query(
        `UPDATE platform_agent_step_contexts
            SET world_revision = 99
          WHERE step_id = $1`,
        [storedContexts[0]!.identity.stepId],
      )).rejects.toMatchObject({ code: '23503' })
      await client.query(
        `UPDATE platform_agent_step_contexts
            SET context_json = jsonb_set(
              context_json,
              '{contextDigest}',
              '"sha256:tampered"'::jsonb
            )
          WHERE step_id = $1`,
        [storedContexts[0]!.identity.stepId],
      )
      await expect(new AgentStepContextRepository(db).list(runId))
        .rejects.toThrow(/行与 context_json 不一致/u)
    } finally {
      await client.query('DELETE FROM platform_workspaces WHERE workspace_id = $1', [workspaceId])
      await client.query('DELETE FROM platform_users WHERE user_id = $1', [userId])
    }
  })

  it('追加运行记录时只锁定运行身份行并读取权威快照', async () => {
    const userId = 'user_run_record_lock'
    const workspaceId = 'workspace_run_record_lock'
    const sessionId = 'session_run_record_lock'
    const threadId = 'thread_run_record_lock'
    const runId = 'run_record_lock'
    const now = new Date('2026-08-23T00:00:00.000Z')
    const persistence = new PostgresConversationPersistence(db)

    try {
      await client.query(
        `INSERT INTO platform_users
           (user_id, subject, email, display_name, created_at, updated_at)
         VALUES ($1, $1, $2, '运行记录锁测试', $3, $3)`,
        [userId, `${userId}@example.test`, now],
      )
      await client.query(
        `INSERT INTO platform_workspaces
           (workspace_id, name, created_by_user_id, created_at, updated_at)
         VALUES ($1, '运行记录锁工作区', $2, $3, $3)`,
        [workspaceId, userId, now],
      )
      await client.query(
        `INSERT INTO platform_sessions
           (session_id, workspace_id, created_by_user_id, visibility, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'private', 'active', $4, $4)`,
        [sessionId, workspaceId, userId, now],
      )
      await client.query(
        `INSERT INTO platform_threads
           (thread_id, session_id, workspace_id, created_by_user_id, visibility, title, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'private', '运行记录锁', $5, $5)`,
        [threadId, sessionId, workspaceId, userId, now],
      )

      await persistence.createRunLifecycle(integrationRun({
        runId,
        rootRunId: runId,
        threadId,
        sessionId,
        workspaceId,
        userId,
        userQuery: '验证运行记录行锁',
        now,
      }))
      await persistence.appendConversationItem({
        itemId: 'item_run_record_lock',
        itemType: 'result',
        runId,
        threadId,
        role: null,
        body: null,
        status: 'completed',
        timestamp: new Date(now.getTime() + 1_000).toISOString(),
      })

      const projection = await client.query<{ latest_run_status: string | null }>(
        'SELECT latest_run_status FROM platform_threads WHERE thread_id = $1',
        [threadId],
      )
      const records = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM platform_run_records WHERE run_id = $1',
        [runId],
      )
      const outbox = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM platform_event_outbox
          WHERE aggregate_id = $1 AND event_type = 'run.item'`,
        [runId],
      )
      expect(projection.rows[0]?.latest_run_status).toBe('queued')
      expect(records.rows[0]?.count).toBe('1')
      expect(outbox.rows[0]?.count).toBe('1')
    } finally {
      await client.query('DELETE FROM platform_workspaces WHERE workspace_id = $1', [workspaceId])
      await client.query('DELETE FROM platform_users WHERE user_id = $1', [userId])
    }
  })

  it('以根预算原子创建 child Run 并持久交付 mailbox', async () => {
    const userId = 'user_child_control'
    const workspaceId = 'workspace_child_control'
    const sessionId = 'session_child_control'
    const rootThreadId = 'thread_child_root'
    const firstThreadId = 'thread_child_first'
    const secondThreadId = 'thread_child_second'
    const rootRunId = 'run_child_root'
    const rootTurnId = 'turn_child_root'
    const now = new Date('2026-08-24T00:00:00.000Z')
    const persistence = new PostgresConversationPersistence(db)
    const children = new PostgresChildRunRepository(db)

    try {
      await client.query(
        `INSERT INTO platform_users
           (user_id, subject, email, display_name, created_at, updated_at)
         VALUES ($1, $1, $2, '子运行测试', $3, $3)`,
        [userId, `${userId}@example.test`, now],
      )
      await client.query(
        `INSERT INTO platform_workspaces
           (workspace_id, name, created_by_user_id, created_at, updated_at)
         VALUES ($1, '子运行工作区', $2, $3, $3)`,
        [workspaceId, userId, now],
      )
      await client.query(
        `INSERT INTO platform_sessions
           (session_id, workspace_id, created_by_user_id, visibility, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'private', 'active', $4, $4)`,
        [sessionId, workspaceId, userId, now],
      )
      for (const [threadId, title] of [
        [rootThreadId, '根运行'],
        [firstThreadId, '第一个子运行'],
        [secondThreadId, '第二个子运行'],
      ] as const) {
        await client.query(
          `INSERT INTO platform_threads
             (thread_id, session_id, workspace_id, created_by_user_id, visibility, title, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'private', $5, $6, $6)`,
          [threadId, sessionId, workspaceId, userId, title, now],
        )
      }

      await persistence.appendConversationEntry({
        threadId: rootThreadId,
        turnId: 'turn_history_1',
        kind: 'message',
        payload: { role: 'user', content: '第一问' },
      })
      await persistence.appendConversationEntry({
        threadId: rootThreadId,
        turnId: 'turn_history_1',
        kind: 'message',
        payload: { role: 'assistant', content: '第一答' },
      })
      await persistence.appendConversationEntry({
        threadId: rootThreadId,
        turnId: 'turn_history_2',
        kind: 'message',
        payload: { role: 'user', content: '第二问' },
      })
      const historyLeaf = await persistence.appendConversationEntry({
        threadId: rootThreadId,
        turnId: 'turn_history_2',
        kind: 'message',
        payload: { role: 'assistant', content: '第二答' },
      })
      await persistence.forkConversation(rootThreadId, firstThreadId, historyLeaf.entryId, 1)
      const recentHistory = await persistence.readActiveConversation(firstThreadId)
      expect(recentHistory.map(entry => entry.payload.content)).toEqual(['第二问', '第二答'])
      expect(recentHistory.map(entry => entry.turnId)).toEqual(['turn_history_2', 'turn_history_2'])
      await persistence.forkConversation(
        firstThreadId,
        secondThreadId,
        recentHistory.at(-1)!.entryId,
        1,
      )
      expect((await persistence.readActiveConversation(secondThreadId)).map(entry => entry.turnId))
        .toEqual(['turn_history_2', 'turn_history_2'])

      const root = integrationRun({
        runId: rootRunId,
        rootRunId,
        threadId: rootThreadId,
        sessionId,
        workspaceId,
        userId,
        userQuery: '协调子运行',
        now,
      })
      const createdRoot = (await persistence.createRunLifecycle(root)).run
      const runningRoot = {
        ...createdRoot,
        status: 'running' as const,
        updatedAt: new Date(now.getTime() + 1_000).toISOString(),
      }
      await persistence.saveRun(runningRoot)
      const presentationItem = {
        itemId: 'item_projection_root',
        itemType: 'message' as const,
        runId: rootRunId,
        threadId: rootThreadId,
        role: 'assistant',
        body: '处理中',
        status: 'running',
        timestamp: new Date(now.getTime() + 1_100).toISOString(),
      }
      await persistence.appendConversationItem(presentationItem)
      await persistence.appendConversationItem({
        ...presentationItem,
        body: '处理完成',
        status: 'completed',
      })
      const presentationEvent = {
        eventId: 'event_projection_root',
        runId: rootRunId,
        threadId: rootThreadId,
        type: 'trace.recorded' as const,
        message: '投影测试',
        timestamp: new Date(now.getTime() + 1_200).toISOString(),
        payload: {},
      }
      await persistence.appendRunEvent(presentationEvent)
      await persistence.appendRunEvent(presentationEvent)
      expect(await persistence.loadRunPresentation(rootRunId)).toMatchObject({
        runId: rootRunId,
        sourceSequence: 4,
        items: [{ itemId: presentationItem.itemId, body: '处理完成', status: 'completed' }],
        events: [{ eventId: presentationEvent.eventId }],
      })
      await client.query(
        `UPDATE platform_runs
            SET next_record_sequence = next_record_sequence + 1
          WHERE run_id = $1`,
        [rootRunId],
      )
      await expect(persistence.loadRunPresentation(rootRunId)).rejects.toThrow(/投影游标落后/u)
      await client.query(
        `UPDATE platform_runs
            SET next_record_sequence = next_record_sequence - 1
          WHERE run_id = $1`,
        [rootRunId],
      )
      expect(await persistence.inspectRunDomainProjection(rootRunId)).toMatchObject({
        status: 'verified',
        reason: 'verified',
        sequenceDistance: 0,
      })
      await client.query(
        `UPDATE platform_runs
            SET status = 'failed',
                recovery_status = 'requires_action',
                pending_tool_call_ids = '["tampered"]'::jsonb
          WHERE run_id = $1`,
        [rootRunId],
      )
      const tamperRestart = new PostgresConversationPersistence(db)
      expect((await tamperRestart.loadSnapshot()).runs.find(run => run.id === rootRunId))
        .toMatchObject({ status: 'running' })
      expect(await tamperRestart.getRunCheckpoint(rootRunId)).toMatchObject({
        run: { status: 'running' },
        recoveryStatus: 'clean',
        pendingToolCallIds: [],
      })
      await client.query(
        `UPDATE platform_runs
            SET status = 'running',
                recovery_status = 'clean',
                pending_tool_call_ids = '[]'::jsonb
          WHERE run_id = $1`,
        [rootRunId],
      )

      const beforeFailedMutation = await persistence.getRunDomainSnapshot(rootRunId)
      const beforeFailedEvents = await persistence.listRunDomainEvents(rootRunId)
      await client.query(`
        CREATE FUNCTION fail_run_snapshot_update() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.run_id = '${rootRunId}' THEN
            RAISE EXCEPTION 'injected run snapshot failure';
          END IF;
          RETURN NEW;
        END
        $$
      `)
      await client.query(`
        CREATE TRIGGER fail_run_snapshot_update_trigger
        BEFORE UPDATE ON platform_run_snapshots
        FOR EACH ROW EXECUTE FUNCTION fail_run_snapshot_update()
      `)
      let injectedError: unknown = null
      try {
        await persistence.saveRun({
          ...runningRoot,
          status: 'completed',
          updatedAt: new Date(now.getTime() + 1_500).toISOString(),
          state: { ...runningRoot.state, warnings: ['不应提交'] },
        })
      } catch (error) {
        injectedError = error
      } finally {
        await client.query('DROP TRIGGER fail_run_snapshot_update_trigger ON platform_run_snapshots')
        await client.query('DROP FUNCTION fail_run_snapshot_update()')
      }
      expect(errorCauseMessages(injectedError)).toContain('injected run snapshot failure')
      expect(await persistence.getRunDomainSnapshot(rootRunId)).toEqual(beforeFailedMutation)
      expect(await persistence.listRunDomainEvents(rootRunId)).toEqual(beforeFailedEvents)
      expect((await client.query<{ status: string }>(
        'SELECT status FROM platform_runs WHERE run_id = $1',
        [rootRunId],
      )).rows[0]?.status).toBe('running')
      await client.query(
        `UPDATE platform_run_snapshots
            SET sequence = sequence + 1
          WHERE run_id = $1`,
        [rootRunId],
      )
      expect(await persistence.inspectRunDomainProjection(rootRunId)).toMatchObject({
        status: 'failed',
        reason: 'snapshot',
        sequenceDistance: 1,
      })
      await client.query(
        `UPDATE platform_run_snapshots
            SET sequence = sequence - 1
          WHERE run_id = $1`,
        [rootRunId],
      )
      await children.configureRootBudget(rootRunId, {
        maxConcurrentChildren: 1,
        maxSpawnDepth: 2,
        maxTotalChildren: 3,
        maxTotalModelTokens: 150,
        maxWallClockMs: null,
      })

      const first = integrationRun({
        runId: 'run_child_first',
        rootRunId,
        parentRunId: rootRunId,
        parentTurnId: rootTurnId,
        rootTurnId,
        spawnCallId: 'call_spawn_first',
        agentPath: '/root/first',
        taskName: 'first',
        agentRole: '验证 mailbox',
        spawnDepth: 1,
        forkMode: 'none',
        maxModelTokens: 100,
        threadId: firstThreadId,
        sessionId,
        workspaceId,
        userId,
        userQuery: '完成第一个任务',
        now: new Date(now.getTime() + 2_000),
      })
      const createdFirst = (await persistence.createRunLifecycle(first)).run
      expect(await children.getDescriptor(createdFirst.id)).toEqual(expect.objectContaining({
        runId: createdFirst.id,
        rootRunId,
        parentRunId: rootRunId,
        status: 'queued',
      }))
      expect(await children.getRootBudget(rootRunId)).toEqual(expect.objectContaining({
        totalChildren: 1,
        activeChildren: 1,
      }))

      const second = integrationRun({
        runId: 'run_child_second',
        rootRunId,
        parentRunId: rootRunId,
        parentTurnId: rootTurnId,
        rootTurnId,
        spawnCallId: 'call_spawn_second',
        agentPath: '/root/second',
        taskName: 'second',
        agentRole: '验证并发预算',
        spawnDepth: 1,
        forkMode: 'none',
        threadId: secondThreadId,
        sessionId,
        workspaceId,
        userId,
        userQuery: '完成第二个任务',
        now: new Date(now.getTime() + 3_000),
      })
      await expect(persistence.createRunLifecycle(second)).rejects.toThrow(/并发 child 数预算已耗尽/u)

      const queued = await children.appendMessage({
        messageId: 'message_child_first',
        senderRunId: rootRunId,
        receiverRunId: createdFirst.id,
        parentTurnId: rootTurnId,
        rootTurnId,
        kind: 'input',
        content: '补充持久输入',
        triggerTurn: true,
      })
      expect(queued).toEqual(expect.objectContaining({ sequence: 1, status: 'queued' }))
      expect(await children.appendMessage({
        messageId: 'message_child_first',
        senderRunId: rootRunId,
        receiverRunId: createdFirst.id,
        parentTurnId: rootTurnId,
        rootTurnId,
        kind: 'input',
        content: '补充持久输入',
        triggerTurn: true,
      })).toEqual(queued)
      await expect(children.appendMessage({
        messageId: 'message_child_first',
        senderRunId: rootRunId,
        receiverRunId: createdFirst.id,
        parentTurnId: rootTurnId,
        rootTurnId,
        kind: 'input',
        content: '同一幂等键的不同内容',
        triggerTurn: true,
      })).rejects.toThrow(/已用于不同请求/u)
      expect(await children.markMessageDelivered(createdFirst.id, queued.messageId))
        .toEqual(expect.objectContaining({ status: 'delivered' }))
      expect(await children.checkpointDeliveredMessages(createdFirst.id))
        .toEqual([expect.objectContaining({ status: 'checkpointed' })])

      const firstWithUsage = {
        ...createdFirst,
        usedModelTokens: 60,
        state: agentStateSchema.parse({
          ...createdFirst.state,
          runtimeStats: { ...createdFirst.state.runtimeStats, modelTotalTokens: 60 },
        }),
        updatedAt: new Date(now.getTime() + 3_500).toISOString(),
      }
      await persistence.saveRunWithModelUsage(firstWithUsage, 60)
      await expect(persistence.saveRunWithModelUsage({
        ...firstWithUsage,
        usedModelTokens: 110,
        state: agentStateSchema.parse({
          ...firstWithUsage.state,
          runtimeStats: { ...firstWithUsage.state.runtimeStats, modelTotalTokens: 110 },
        }),
      }, 50)).rejects.toThrow(/模型词元预算已耗尽/u)
      expect(await children.getRootBudget(rootRunId)).toEqual(expect.objectContaining({ usedModelTokens: 60 }))

      await persistence.saveRun({
        ...firstWithUsage,
        status: 'completed',
        updatedAt: new Date(now.getTime() + 4_000).toISOString(),
      })
      expect(await children.getRootBudget(rootRunId)).toEqual(expect.objectContaining({
        totalChildren: 1,
        activeChildren: 0,
      }))
      await persistence.createRunLifecycle(second)
      expect(await children.getRootBudget(rootRunId)).toEqual(expect.objectContaining({
        totalChildren: 2,
        activeChildren: 1,
      }))
    } finally {
      await client.query('DELETE FROM platform_workspaces WHERE workspace_id = $1', [workspaceId])
      await client.query('DELETE FROM platform_users WHERE user_id = $1', [userId])
    }
  })

  it('通过真实空间表完成图层导入、筛选、计数和删除', async () => {
    const service = new ManagedLayerService(db)
    const importInput = {
      layerKey: 'postgis_integration_points',
      name: 'PostGIS 集成点',
      sourceType: 'system',
      collection: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [120.1, 30.2] },
            properties: { category: 'alpha', value: 1 },
          },
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [120.2, 30.3] },
            properties: { category: 'beta', value: 2 },
          },
        ],
      },
    } as const
    const layer = await service.importGeoJsonLayer(importInput)

    expect(layer.layerKey).toBe('postgis_integration_points')
    expect(await service.featureCount(layer.layerKey)).toBe(2)
    expect(await service.featureCount(layer.layerKey, {
      propertyFilter: { property: 'category', values: ['beta'] },
    })).toBe(1)
    const features = await service.queryFeatures(layer.layerKey, { limit: 2 })
    expect(features).toHaveLength(2)
    expect(features[0]?.geometry.type).toBe('Point')

    const firstImportState = await managedLayerImportState(client, layer.layerKey)
    await service.importGeoJsonLayer(importInput)
    const repeatedImportState = await managedLayerImportState(client, layer.layerKey)
    expect(repeatedImportState).toEqual(firstImportState)

    await client.query(`
      UPDATE platform_map_layers
      SET source_json = source_json
        - 'fingerprintSchemaVersion'
        - 'importFingerprint'
        - 'contentHash',
          property_schema_json = (
            SELECT jsonb_agg(entry.value ORDER BY entry.ordinality DESC)
            FROM jsonb_array_elements(property_schema_json)
              WITH ORDINALITY AS entry(value, ordinality)
          )
      WHERE managed_layer_key = $1
    `, [layer.layerKey])
    const legacyImportState = await managedLayerImportState(client, layer.layerKey)
    expect(legacyImportState.importFingerprint).toBeNull()
    expect(legacyImportState.contentHash).toBeNull()
    await service.importGeoJsonLayer(importInput)
    const backfilledImportState = await managedLayerImportState(client, layer.layerKey)
    expect(backfilledImportState.dataVersion).toBe(legacyImportState.dataVersion)
    expect(backfilledImportState.layerUpdatedAt).toBe(legacyImportState.layerUpdatedAt)
    expect(backfilledImportState.featureUpdatedAt).toBe(legacyImportState.featureUpdatedAt)
    expect(backfilledImportState.worldRevision).toBe(legacyImportState.worldRevision)
    expect(backfilledImportState.importFingerprint).toMatch(/^sha256:/u)
    expect(backfilledImportState.contentHash).toBeNull()

    await service.importGeoJsonLayer({
      ...importInput,
      collection: {
        ...importInput.collection,
        features: importInput.collection.features.map((feature, index) => index === 1
          ? { ...feature, properties: { category: 'beta', value: 3 } }
          : feature),
      },
    })
    const changedImportState = await managedLayerImportState(client, layer.layerKey)
    expect(changedImportState.dataVersion).toBe(firstImportState.dataVersion + 1)
    expect(changedImportState.importFingerprint).not.toBe(firstImportState.importFingerprint)
    expect(await service.queryFeatures(layer.layerKey, {
      propertyFilter: { property: 'value', values: [3] },
    })).toHaveLength(1)

    expect(await service.deleteLayer(layer.layerKey)).toBe(true)
    expect(await service.getLayer(layer.layerKey)).toBeNull()
  })

  async function startPostgresContainer(): Promise<string> {
    container = await new PostgreSqlContainer('postgis/postgis:16-3.5')
      .withDatabase('geo_agent_integration')
      .withUsername('geo_agent')
      .withPassword('integration-only-password')
      .start()
    return container.getConnectionUri()
  }
})

async function managedLayerImportState(client: Client, layerKey: string): Promise<{
  dataVersion: number
  layerUpdatedAt: string
  featureUpdatedAt: string | null
  importFingerprint: string | null
  contentHash: string | null
  worldRevision: string
}> {
  const result = await client.query<{
    map_layer_id: string
    data_version: number
    layer_updated_at: string
    feature_updated_at: string | null
    import_fingerprint: string | null
    content_hash: string | null
    property_schema_json: unknown
    crs: string
    geometry_type: string
    feature_count: number | null
    bounds_json: unknown
    style_json: unknown
  }>(`
    SELECT layer.map_layer_id,
           layer.data_version,
           layer.updated_at::text AS layer_updated_at,
           max(feature.updated_at)::text AS feature_updated_at,
           layer.source_json->>'importFingerprint' AS import_fingerprint,
           layer.source_json->>'contentHash' AS content_hash,
           layer.property_schema_json,
           layer.crs,
           layer.geometry_type,
           layer.feature_count,
           layer.bounds_json,
           layer.style_json
    FROM platform_map_layers layer
    LEFT JOIN platform_layer_features feature ON feature.map_layer_id = layer.map_layer_id
    WHERE layer.managed_layer_key = $1
    GROUP BY layer.map_layer_id
  `, [layerKey])
  const row = result.rows[0]
  if (!row) throw new Error(`图层 '${layerKey}' 导入后未写入 PostGIS`)
  const schemaHash = Array.isArray(row.property_schema_json) && row.property_schema_json.length > 0
    ? agentContextDigest(row.property_schema_json)
    : null
  const styleRevision = agentContextDigest(row.style_json)
  const worldRevision = agentContextDigest({
    layerId: row.map_layer_id,
    dataVersion: row.data_version,
    sourceRef: `managed:${layerKey}`,
    schemaHash,
    contentHash: row.content_hash,
    crs: row.crs,
    geometryType: row.geometry_type,
    featureCount: row.feature_count,
    extent: row.bounds_json,
    styleRevision,
  })
  return {
    dataVersion: row.data_version,
    layerUpdatedAt: row.layer_updated_at,
    featureUpdatedAt: row.feature_updated_at,
    importFingerprint: row.import_fingerprint,
    contentHash: row.content_hash,
    worldRevision,
  }
}

function errorCauseMessages(error: unknown): string[] {
  const messages: string[] = []
  const visited = new Set<Error>()
  let current = error
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current)
    messages.push(current.message)
    current = current.cause
  }
  return messages
}

async function applyDatabaseSchema(client: Client): Promise<void> {
  const content = (await readFile(
    path.join(repositoryRoot, 'infra', 'database', 'schema.sql'),
    'utf8',
  )).replace(/\r\n?/gu, '\n')
  await client.query(content)
}

function integrationRun(input: {
  runId: string
  rootRunId: string
  parentRunId?: string
  parentTurnId?: string
  rootTurnId?: string
  spawnCallId?: string
  agentPath?: string
  taskName?: string
  agentRole?: string
  spawnDepth?: number
  forkMode?: 'none' | 'full_history' | 'last_n_turns'
  maxModelTokens?: number
  threadId: string
  sessionId: string
  workspaceId: string
  userId: string
  userQuery: string
  now: Date
}) {
  const child = Boolean(input.parentRunId)
  const createdAt = input.now.toISOString()
  return analysisRunSchema.parse({
    id: input.runId,
    runKind: child ? 'child' : 'root',
    rootRunId: input.rootRunId,
    parentRunId: input.parentRunId ?? null,
    parentTurnId: input.parentTurnId ?? null,
    rootTurnId: input.rootTurnId ?? null,
    spawnCallId: input.spawnCallId ?? null,
    agentPath: input.agentPath ?? '/root',
    taskName: input.taskName ?? null,
    agentRole: input.agentRole ?? null,
    spawnDepth: input.spawnDepth ?? 0,
    forkMode: input.forkMode ?? 'none',
    forkTurnCount: null,
    modelOverride: null,
    reasoningOverride: null,
    maxModelTokens: input.maxModelTokens ?? null,
    maxWallClockMs: null,
    usedModelTokens: 0,
    threadId: input.threadId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    createdByUserId: input.userId,
    visibility: 'private',
    userQuery: input.userQuery,
    modelProvider: 'deepseek',
    modelName: 'deepseek-v4-flash',
    status: 'queued',
    createdAt,
    updatedAt: createdAt,
    state: agentStateSchema.parse({
      sessionId: input.sessionId,
      threadId: input.threadId,
      userQuery: input.userQuery,
    }),
    runtimeConfigSnapshot: defaultRuntimeConfig(),
  })
}

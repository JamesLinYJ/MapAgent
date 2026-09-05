// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具结果持久化契约测试
//
//   文件:       resultPersistence.test.ts
//
//   日期:       2026年06月15日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PlatformPersistenceFacade } from '../store/platformPersistenceFacade.js'
import { createTestPersistenceFacade } from '../../test-support/persistenceFacadeHarness.js'
import { ToolResultCommitService } from './resultPersistence.js'
import type { ToolResult } from '../framework/types.js'
import { ToolInvocationLedger } from '../agent-runtime/tools/ToolInvocationLedger.js'
import { ToolEffectCommitter } from '../agent-runtime/tools/ToolEffectCommitter.js'
import { agentContextDigest } from '../agent-runtime/step/agentContextDigest.js'

describe('tool result persistence', () => {
  it('preserves all results from concurrent tool completions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-concurrent-'))
    let store: PlatformPersistenceFacade | undefined
    try {
      store = createTestPersistenceFacade(path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '并行结果测试')
      const run = await store.createRun(session.id, '并行执行工具', { threadId: thread.id })

      await Promise.all(['tool_a', 'tool_b'].map(tool => persistToolExecutionResult(
        store!, run.id, tool, tool, {}, {
          message: `${tool} 完成`,
          payload: {},
          warnings: [],
          resultId: `result_${tool}`,
          source: 'test',
        },
      )))

      expect(store.getRun(run.id).state.toolResults.map(result => result.tool).sort())
        .toEqual(['tool_a', 'tool_b'])
    } finally {
      await store?.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not duplicate a retried result with the same resultId', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-idempotent-'))
    let store: PlatformPersistenceFacade | undefined
    try {
      store = createTestPersistenceFacade(path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '幂等结果测试')
      const run = await store.createRun(session.id, '重复提交工具结果', { threadId: thread.id })
      const result = {
        message: '检查完成',
        payload: { route: line() },
        warnings: [],
        resultId: 'result_retry',
        source: 'test',
      }

      await Promise.all([
        persistToolExecutionResult(store, run.id, 'inspect_dataset', '检查数据集', {}, result),
        persistToolExecutionResult(store, run.id, 'inspect_dataset', '检查数据集', {}, result),
      ])

      const latest = store.getRun(run.id)
      expect(latest.state.toolResults.filter(item => item.resultId === result.resultId)).toHaveLength(1)
      const artifactFiles = await readdir(path.join(root, 'artifacts', run.id))
      expect(artifactFiles.filter(file => file.endsWith('.geojson'))).toHaveLength(1)
    } finally {
      await store?.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a durable explicit artifact file when the same result is replayed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-explicit-replay-'))
    let store: PlatformPersistenceFacade | undefined
    try {
      store = createTestPersistenceFacade(path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '显式 Artifact 重放')
      const run = await store.createRun(session.id, '显式 Artifact 幂等提交', { threadId: thread.id })
      const relativePath = path.posix.join('artifacts', run.id, 'stable.geojson')
      const target = path.join(root, relativePath)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, JSON.stringify(line()), 'utf8')
      const result = {
        message: '显式 Artifact',
        payload: {},
        warnings: [],
        resultId: 'result_explicit_replay',
        source: 'test',
        artifacts: [{
          artifactId: 'artifact_stable',
          artifactType: 'geojson',
          name: '稳定路线',
          uri: '/api/v1/results/artifact_stable/geojson',
          display: { surfaces: ['download'] as const, primarySurface: 'download' as const, map: null },
          relativePath,
        }],
      }

      await persistToolExecutionResult(store, run.id, 'map_export', '导出', {}, result)
      await persistToolExecutionResult(store, run.id, 'map_export', '导出', {}, result)

      expect(store.getRun(run.id).state.artifacts).toHaveLength(1)
      await expect(readFile(target, 'utf8')).resolves.toContain('LineString')
    } finally {
      await store?.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects explicit artifacts outside the current run without deleting their files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-artifact-ownership-'))
    let store: PlatformPersistenceFacade | undefined
    try {
      store = createTestPersistenceFacade(path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, 'Artifact 所有权')
      const run = await store.createRun(session.id, '当前运行', { threadId: thread.id })
      const sibling = await store.createRun(session.id, '其他运行', { threadId: thread.id })
      const relativePaths = [
        path.posix.join('files', 'shared-upload.geojson'),
        path.posix.join('artifacts', sibling.id, 'owned.geojson'),
      ]

      for (const [index, relativePath] of relativePaths.entries()) {
        const target = path.join(root, relativePath)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, JSON.stringify(line()), 'utf8')
        await expect(persistToolExecutionResult(store, run.id, 'map_export', '导出', {}, {
          message: '非法跨目录 Artifact',
          payload: {},
          warnings: [],
          resultId: `result_cross_run_${index}`,
          source: 'test',
          artifacts: [{
            artifactId: `artifact_cross_run_${index}`,
            artifactType: 'geojson',
            name: '跨目录路线',
            uri: `/api/v1/results/artifact_cross_run_${index}/geojson`,
            display: { surfaces: ['download'], primarySurface: 'download', map: null },
            relativePath,
          }],
        })).rejects.toThrow('必须位于当前运行目录')
        await expect(readFile(target, 'utf8')).resolves.toContain('LineString')
      }
      const missingRelativePath = path.posix.join('artifacts', run.id, 'missing.geojson')
      await expect(persistToolExecutionResult(store, run.id, 'map_export', '导出', {}, {
        message: '不存在的 Artifact',
        payload: {},
        warnings: [],
        resultId: 'result_missing_artifact',
        source: 'test',
        artifacts: [{
          artifactId: 'artifact_missing',
          artifactType: 'geojson',
          name: '不存在的路线',
          uri: '/api/v1/results/artifact_missing/geojson',
          display: { surfaces: ['download'], primarySurface: 'download', map: null },
          relativePath: missingRelativePath,
        }],
      })).rejects.toThrow('artifact 文件不存在')
      expect(store.getRun(run.id).state.artifacts).toHaveLength(0)
    } finally {
      await store?.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cleans generated files when the durable commit fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-commit-failure-'))
    let store: PlatformPersistenceFacade | undefined
    try {
      store = createTestPersistenceFacade(path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '提交失败清理')
      const run = await store.createRun(session.id, '提交失败', { threadId: thread.id })
      vi.spyOn(store, 'commitToolResult').mockRejectedValueOnce(new Error('commit failed'))
      const explicitRelativePath = path.posix.join('artifacts', run.id, 'explicit.geojson')
      const explicitPath = path.join(root, explicitRelativePath)
      await mkdir(path.dirname(explicitPath), { recursive: true })
      await writeFile(explicitPath, JSON.stringify(line()), 'utf8')

      await expect(persistToolExecutionResult(store, run.id, 'route_planner', '路径规划', {}, {
        message: '路线生成',
        payload: { route: line() },
        warnings: [],
        resultId: 'result_commit_failure',
        source: 'test',
        artifacts: [{
          artifactId: 'artifact_explicit',
          artifactType: 'geojson',
          name: '显式路线',
          uri: '/api/v1/results/artifact_explicit/geojson',
          display: { surfaces: ['download'], primarySurface: 'download', map: null },
          relativePath: explicitRelativePath,
        }],
      })).rejects.toThrow('commit failed')

      const artifactRoot = path.join(root, 'artifacts', run.id)
      await expect(readdir(artifactRoot)).resolves.toEqual([])
    } finally {
      await store?.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists inline GeoJSON identically for direct and agent tool paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-'))
    let store: PlatformPersistenceFacade | undefined
    try {
      store = createTestPersistenceFacade(path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '结果测试')
      const run = await store.createRun(session.id, '执行工具', { threadId: thread.id })
      await persistToolExecutionResult(store, run.id, 'route_planner', '路径规划', {}, {
        message: '路线完成',
        payload: { route: line() },
        warnings: [],
        resultId: 'result_route',
        source: 'test',
        valueRefs: [{ refId: 'ref_route', kind: 'route', label: '路线', value: line() }],
      })

      const latest = store.getRun(run.id)
      expect(latest.state.artifacts).toHaveLength(1)
      expect(latest.state.toolValueRefs[0].refId).toBe('ref_route')
      expect(latest.state.toolResults[0]?.toolLabel).toBe('路径规划')
      expect(store.getThread(thread.id).latestArtifactId).toBe(latest.state.artifacts[0].artifactId)
      const relativePath = String(latest.state.artifacts[0].metadata.relativePath)
      expect(JSON.parse(await readFile(path.join(root, relativePath), 'utf8'))).toEqual(line())
    } finally {
      await store?.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reprojects declared GeoJSON before deriving artifact CRS and bounds', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-crs-'))
    let store: PlatformPersistenceFacade | undefined
    try {
      store = createTestPersistenceFacade(path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, 'CRS Artifact 测试')
      const run = await store.createRun(session.id, '转换投影结果', { threadId: thread.id })
      const projectedRing = [
        webMercator(120, 30), webMercator(120.01, 30),
        webMercator(120.01, 30.01), webMercator(120, 30.01), webMercator(120, 30),
      ]
      const projected = {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [projectedRing] },
      }
      await persistToolExecutionResult(store, run.id, 'projected_analysis', '投影分析', {}, {
        message: '投影结果',
        // payload 和 valueRef 复用同一个几何事实；持久化边界只规范化一次。
        payload: { projected },
        warnings: [],
        resultId: 'result_projected',
        source: 'test',
        valueRefs: [{
          refId: 'ref_projected',
          kind: 'geojson',
          label: '投影面',
          value: projected,
          metadata: { crs: 'EPSG:3857' },
        }],
      })

      const artifact = store.getRun(run.id).state.artifacts[0]
      expect(artifact.display.map).toMatchObject({
        crs: 'OGC:CRS84',
        bounds: [expect.closeTo(120, 8), expect.closeTo(30, 8), expect.closeTo(120.01, 8), expect.closeTo(30.01, 8)],
      })
      expect(artifact.metadata).toMatchObject({
        crs: 'OGC:CRS84',
        sourceCrs: 'EPSG:3857',
        reprojected: true,
        bounds: artifact.display.map?.bounds,
      })
      const relativePath = String(artifact.metadata.relativePath)
      const persisted = JSON.parse(await readFile(path.join(root, relativePath), 'utf8'))
      expect(persisted).not.toHaveProperty('crs')
      expect(persisted.geometry.coordinates[0][0]).toEqual([expect.closeTo(120, 8), expect.closeTo(30, 8)])
    } finally {
      await store?.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('validates every automatic GeoJSON artifact plan before writing the first file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-crs-plan-'))
    let store: PlatformPersistenceFacade | undefined
    try {
      store = createTestPersistenceFacade(path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, 'Artifact 计划原子性')
      const run = await store.createRun(session.id, '拒绝混合 CRS 结果', { threadId: thread.id })

      await expect(persistToolExecutionResult(store, run.id, 'mixed_analysis', '混合结果', {}, {
        message: '混合结果',
        payload: {},
        warnings: [],
        resultId: 'result_mixed_crs',
        source: 'test',
        valueRefs: [
          { refId: 'ref_valid', kind: 'route', label: '有效路线', value: line() },
          {
            refId: 'ref_missing_crs',
            kind: 'geojson',
            label: '缺少 CRS 的投影点',
            value: { type: 'Point', coordinates: webMercator(120, 30) },
          },
        ],
      })).rejects.toThrow('投影坐标必须显式声明 CRS')

      expect(store.getRun(run.id).state.artifacts).toHaveLength(0)
      await expect(readdir(path.join(root, 'artifacts', run.id))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await store?.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists todo_write payload into AgentState.todos', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-'))
    let store: PlatformPersistenceFacade | undefined
    try {
      store = createTestPersistenceFacade(path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, 'Todo 测试')
      const run = await store.createRun(session.id, '执行 Todo', { threadId: thread.id })
      await persistToolExecutionResult(store, run.id, 'todo_write', '更新任务清单', {}, {
        message: '已更新 Todo',
        payload: {
          todos: [
            { todoId: 'todo_1', title: '检查 GIS/气象 Agent 工具', status: 'running' },
            { todoId: 'todo_2', title: '执行 Playwright 验收', status: 'pending' },
          ],
        },
        warnings: [],
        resultId: 'result_todo',
        source: 'test',
      })

      expect(store.getRun(run.id).state.todos).toEqual([
        expect.objectContaining({ todoId: 'todo_1', title: '检查 GIS/气象 Agent 工具', status: 'running' }),
        expect.objectContaining({ todoId: 'todo_2', title: '执行 Playwright 验收', status: 'pending' }),
      ])
    } finally {
      await store?.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists request_clarification payload as a pending DecisionRequest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-clarification-'))
    let store: PlatformPersistenceFacade | undefined
    try {
      store = createTestPersistenceFacade(path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '澄清测试')
      const run = await store.createRun(session.id, '要画图', { threadId: thread.id })
      await persistToolExecutionResult(store, run.id, 'request_clarification', '请求澄清', {}, {
        message: '需要确认平台',
        payload: {
          clarification: {
            clarificationId: 'clarification_platform',
            kind: 'platform',
            reason: '缺少目标平台',
            question: '目标平台是什么？',
            allowFreeText: true,
            options: [
              { optionId: 'browser', label: '浏览器 WebGL', description: '在浏览器中运行' },
            ],
          },
        },
        warnings: [],
        resultId: 'result_clarification',
        source: 'test',
      })

      const latest = store.getRun(run.id)
      expect(latest.state.clarification).toMatchObject({
        clarificationId: 'clarification_platform',
        question: '目标平台是什么？',
        selectedOptionId: null,
      })
      expect(latest.state.decisions).toContainEqual(expect.objectContaining({
        decisionId: 'clarification_platform',
        kind: 'clarification',
        title: '需要补充信息',
        question: '目标平台是什么？',
        status: 'pending',
        allowFreeText: true,
        payload: expect.objectContaining({ clarificationKind: 'platform' }),
      }))
    } finally {
      await store?.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps stale-revision evidence but does not project its workflow or clarification into current state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'geo-result-stale-control-'))
    let store: PlatformPersistenceFacade | undefined
    try {
      store = createTestPersistenceFacade(path.join(root, 'sessions'))
      await store.initialize()
      const session = await store.createSession()
      const thread = await store.createThread(session.id, '迟到控制结果')
      const run = await store.createRun(session.id, '当前已是新目标版本', { threadId: thread.id })
      await store.updateRunState(run.id, {
        objectiveRevision: 2,
        todos: [{ todoId: 'todo_current', title: '当前版本任务', status: 'running' }],
      })
      const workflowCommit = await persistToolExecutionResult(
        store,
        run.id,
        'submit_agent_workflow',
        '提交智能体工作流',
        {},
        {
          message: '旧版本工作流迟到',
          payload: {
            route: line(),
            agentWorkflowDraft: {
              goal: '旧版本目标',
              steps: [{
                stepId: 'old_step',
                title: '执行旧版本工具',
                kind: 'tool',
                toolName: 'inspect_dataset',
                ownerAgentId: 'supervisor',
                args: {},
                reason: '测试迟到提交',
                dependsOn: [],
              }],
            },
            todos: [{ todoId: 'todo_old', title: '旧版本任务', status: 'completed' }],
          },
          warnings: [],
          resultId: 'result_old_workflow',
          source: 'test',
          valueRefs: [{ refId: 'ref_old', kind: 'route', label: '旧版本路线', value: line() }],
        },
        1,
      )
      const clarificationCommit = await persistToolExecutionResult(
        store,
        run.id,
        'request_clarification',
        '请求澄清',
        {},
        {
          message: '旧版本澄清迟到',
          payload: {
            clarification: {
              clarificationId: 'clarification_old',
              question: '旧版本问题？',
            },
          },
          warnings: [],
          resultId: 'result_old_clarification',
          source: 'test',
        },
        1,
      )

      const latest = store.getRun(run.id).state
      expect(workflowCommit.controlsApplied).toBe(false)
      expect(clarificationCommit.controlsApplied).toBe(false)
      expect(latest.objectiveRevision).toBe(2)
      expect(latest.agentWorkflow).toBeNull()
      expect(latest.clarification).toBeNull()
      expect(latest.decisions).toEqual([])
      expect(latest.todos).toEqual([
        expect.objectContaining({ todoId: 'todo_current', title: '当前版本任务', status: 'running' }),
      ])
      expect(latest.toolResults.map(result => result.objectiveRevision)).toEqual([1, 1])
      expect(latest.toolValueRefs).toContainEqual(expect.objectContaining({
        refId: 'ref_old',
        metadata: expect.objectContaining({ objectiveRevision: 1 }),
      }))
      expect(latest.artifacts).toContainEqual(expect.objectContaining({
        metadata: expect.objectContaining({ objectiveRevision: 1 }),
      }))
    } finally {
      await store?.flushConversationStore()
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function persistToolExecutionResult(
  store: PlatformPersistenceFacade,
  runId: string,
  toolName: string,
  toolLabel: string,
  args: Record<string, unknown>,
  result: ToolResult,
  objectiveRevision = store.getRun(runId).state.objectiveRevision,
): Promise<{ controlsApplied: boolean }> {
  const run = store.getRun(runId)
  const callId = `call_${result.resultId}`
  const ledger = new ToolInvocationLedger(store, runId)
  const planDigest = agentContextDigest({
    executionSurface: 'developer',
    toolName,
  })
  const prepared = await ledger.prepare({
    runId,
    turnId: `turn_${result.resultId}`,
    callId,
    stepId: null,
    objectiveRevision,
    toolPlanDigest: planDigest,
    descriptor: {
      name: toolName,
      namespace: 'test',
      providerId: 'test',
      kind: 'platform',
      exposure: 'immediate',
      effect: 'world_write',
      parallelism: 'exclusive',
      approvalAction: null,
      replayPolicy: 'manual_recovery',
      requiredCapabilities: [],
      requiredValueRefKinds: [],
      executionSurfaces: ['developer'],
    },
    args,
    executionSurface: 'developer',
  })
  if (prepared.status === 'prepared') await ledger.start(callId, 'not_required')
  return new ToolEffectCommitter(
    ledger,
    new ToolResultCommitService(store),
  ).commit({
    runId,
    callId,
    toolName,
    toolLabel,
    args,
    result,
    objectiveRevision,
    checkpointImmediately: true,
  })
}

function line() {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[120, 30], [121, 31]] } }
}

function webMercator(longitude: number, latitude: number): [number, number] {
  const earthRadius = 6_378_137
  return [
    earthRadius * longitude * Math.PI / 180,
    earthRadius * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)),
  ]
}

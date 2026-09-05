// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 编排模型测试
//
//   文件:       automationStudioModel.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { automationRunRecordSchema, type ToolDescriptor } from '@geo-agent-platform/shared-types'
import {
  automationRunNavigationTarget,
  collectAutomationRunArtifacts,
  createBlankAutomationGraph,
  createAutomationNode,
  flowToGraph,
  graphToFlow,
  layoutAutomationGraph,
} from './automationStudioModel'

const tool: ToolDescriptor = {
  name: 'inspect',
  label: '检查数据',
  description: '',
  group: '气象',
  toolKind: 'provider',
  providerId: 'meteorology',
  language: 'typescript',
  isReadOnly: true,
  isDestructive: false,
  parallelSafe: false,
  available: true,
  tags: [],
  parameters: [{
    key: 'dataset_id', label: '数据集', dataType: 'string', source: 'text', required: true,
    description: null, placeholder: null, defaultValue: 'latest_upload', options: [], acceptedValueRefKinds: [],
  }],
  error: null,
  meta: {},
}

describe('automationStudioModel', () => {
  it('creates a minimal graph with one trigger and one output', () => {
    const graph = createBlankAutomationGraph()
    expect(graph.nodes.map(node => node.type)).toEqual(['trigger', 'output'])
    expect(graph.entryNodeId).toBe('trigger')
  })

  it('creates tool nodes from the real tool descriptor contract', () => {
    const node = createAutomationNode('tool', { x: 100, y: 80 }, tool)
    expect(node.type).toBe('tool')
    if (node.type !== 'tool') throw new Error('fixture did not create a tool node')
    expect(node.config.toolName).toBe('inspect')
    expect(node.config.arguments.dataset_id).toEqual({ source: 'literal', value: 'latest_upload' })
  })

  it('round-trips React Flow coordinates and edge ports without changing domain semantics', () => {
    const graph = createBlankAutomationGraph()
    graph.edges = [{ edgeId: 'edge', sourceNodeId: 'trigger', targetNodeId: graph.nodes[1]!.nodeId, sourcePort: 'default' }]
    const flow = graphToFlow(graph, null)
    expect(flow.edges[0]).toMatchObject({
      sourceHandle: 'default',
      targetHandle: 'target',
    })
    flow.nodes[0]!.position = { x: 220, y: 130 }
    const restored = flowToGraph(graph, flow.nodes, flow.edges)
    expect(restored.nodes[0]!.position).toEqual({ x: 220, y: 130 })
    expect(restored.edges).toEqual(graph.edges)
  })

  it('lays out the graph while keeping node and edge identities stable', () => {
    const graph = createBlankAutomationGraph()
    graph.edges = [{ edgeId: 'edge', sourceNodeId: 'trigger', targetNodeId: graph.nodes[1]!.nodeId, sourcePort: 'default' }]
    const laidOut = layoutAutomationGraph(graph)
    expect(laidOut.nodes.map(node => node.nodeId)).toEqual(graph.nodes.map(node => node.nodeId))
    expect(laidOut.edges).toEqual(graph.edges)
    expect(laidOut.nodes[1]!.position.x).toBeGreaterThan(laidOut.nodes[0]!.position.x)
  })

  it('extracts only schema-valid artifacts and de-duplicates node and final outputs', () => {
    const artifact = {
      artifactId: 'artifact-map',
      runId: 'run-1',
      artifactType: 'geojson',
      name: '降水分区.geojson',
      uri: '/api/artifacts/artifact-map/content',
      display: { surfaces: ['download'], primarySurface: 'download', map: null },
      metadata: {},
      isIntermediate: false,
    }
    const run = automationRunRecordSchema.parse({
      automationRunId: 'automation-run-1', automationId: 'delivery', workspaceId: 'workspace-1',
      createdByUserId: 'user-1', runId: 'run-1', automationRevision: 1, status: 'completed',
      triggerKind: 'manual', startedAt: '2026-07-18T00:00:00.000Z',
      outputs: { answer: '分析完成', artifacts: [artifact, { uri: '/unsafe' }] },
      nodeRuns: [{
        nodeId: 'tool', nodeType: 'tool', label: '生成地图', status: 'completed', attempt: 1,
        output: { artifacts: [artifact] },
      }],
    })

    expect(collectAutomationRunArtifacts(run)).toEqual([artifact])
  })

  it('derives a navigation target only from a consistent persisted execution state', () => {
    const run = automationRunRecordSchema.parse({
      automationRunId: 'automation-run-1', automationId: 'delivery', workspaceId: 'workspace-1',
      createdByUserId: 'user-1', runId: 'run-1', automationRevision: 1, status: 'completed',
      triggerKind: 'manual', startedAt: '2026-07-18T00:00:00.000Z',
      metadata: { executionState: { sessionId: 'session-1', threadId: 'thread-1', orchestrationRunId: 'run-1' } },
    })

    expect(automationRunNavigationTarget(run)).toEqual({ sessionId: 'session-1', threadId: 'thread-1', runId: 'run-1' })
    expect(automationRunNavigationTarget({ ...run, runId: 'different-run' })).toBeNull()
  })
})

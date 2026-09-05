// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 编排视图模型
//
//   文件:       automationStudioModel.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import dagre from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/react'
import {
  artifactRefSchema,
  type ArtifactRef,
  type AutomationRunRecord,
  type ToolDescriptor,
  type AutomationEdge,
  type AutomationGraph,
  type AutomationNode,
  type AutomationNodeType,
} from '@geo-agent-platform/shared-types'

interface StudioNodeData extends Record<string, unknown> {
  automationNode: AutomationNode
  selected: boolean
}

export type StudioFlowNode = Node<StudioNodeData, 'automationNode'>
export type StudioFlowEdge = Edge<{ sourcePort: AutomationEdge['sourcePort'] }>

export interface AutomationRunNavigationTarget {
  sessionId: string
  runId: string
  threadId: string | null
}

// Automation 输出跨越数据库与 WebSocket 信任边界；只把共享 ArtifactRef
// Schema 明确认可的对象暴露为可下载交付物。
export function collectAutomationRunArtifacts(run: AutomationRunRecord): ArtifactRef[] {
  const pending: unknown[] = [run.outputs, ...run.nodeRuns.map(nodeRun => nodeRun.output)]
  const visited = new WeakSet<object>()
  const artifacts = new Map<string, ArtifactRef>()
  let inspectedValues = 0

  while (pending.length && inspectedValues < 2_000) {
    const value = pending.pop()
    inspectedValues += 1
    if (typeof value !== 'object' || value === null) continue
    if (visited.has(value)) continue
    visited.add(value)

    const parsed = artifactRefSchema.safeParse(value)
    if (parsed.success) {
      artifacts.set(parsed.data.artifactId, parsed.data)
      continue
    }

    if (Array.isArray(value)) pending.push(...value)
    else pending.push(...Object.values(value))
  }

  return [...artifacts.values()]
}

export function automationRunNavigationTarget(run: AutomationRunRecord): AutomationRunNavigationTarget | null {
  const executionState = asRecord(run.metadata.executionState)
  if (!executionState) return null
  const sessionId = nonEmptyString(executionState.sessionId)
  const threadId = nonEmptyString(executionState.threadId)
  const metadataRunId = nonEmptyString(executionState.orchestrationRunId)
  const runId = nonEmptyString(run.runId) ?? metadataRunId
  if (!sessionId || !runId) return null
  if (metadataRunId && metadataRunId !== runId) return null
  return { sessionId, runId, threadId }
}

export function graphToFlow(graph: AutomationGraph, selectedNodeId: string | null): {
  nodes: StudioFlowNode[]
  edges: StudioFlowEdge[]
} {
  return {
    nodes: graph.nodes.map(node => ({
      id: node.nodeId,
      type: 'automationNode',
      position: node.position,
      data: { automationNode: node, selected: node.nodeId === selectedNodeId },
    })),
    edges: graph.edges.map(edge => ({
      id: edge.edgeId,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      sourceHandle: edge.sourcePort,
      targetHandle: 'target',
      type: 'smoothstep',
      animated: false,
      data: { sourcePort: edge.sourcePort },
    })),
  }
}

export function flowToGraph(
  previous: AutomationGraph,
  nodes: StudioFlowNode[],
  edges: StudioFlowEdge[],
): AutomationGraph {
  return {
    ...previous,
    nodes: nodes.map(node => ({ ...node.data.automationNode, position: node.position })),
    edges: edges.map(edge => ({
      edgeId: edge.id,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      sourcePort: normalizePort(edge.sourceHandle),
    })),
  }
}

export function createBlankAutomationGraph(): AutomationGraph {
  return {
    schemaVersion: 1,
    entryNodeId: 'trigger',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      createAutomationNode('trigger', { x: 80, y: 160 }),
      createAutomationNode('output', { x: 720, y: 160 }),
    ],
    edges: [],
  }
}

export function createAutomationNode(
  type: AutomationNodeType,
  position: { x: number; y: number },
  tool?: ToolDescriptor,
): AutomationNode {
  const nodeId = `${type}_${crypto.randomUUID().slice(0, 8)}`
  const base = { nodeId, type, label: nodeLabel(type, tool), description: '', position }
  if (type === 'trigger') return { ...base, nodeId: 'trigger', type, config: {} }
  if (type === 'tool') {
    if (!tool) throw new Error('创建工具节点必须指定工具。')
    return {
      ...base,
      type,
      config: {
        toolName: tool.name,
        arguments: Object.fromEntries(tool.parameters
          .filter(parameter => parameter.required)
          .map(parameter => [parameter.key, { source: 'literal' as const, value: parameter.defaultValue ?? '' }])),
        approvalMode: 'auto',
        retry: { maxAttempts: 1, backoffSeconds: 0 },
      },
    }
  }
  if (type === 'agent') return {
    ...base,
    type,
    config: {
      promptTemplate: '{{{input.prompt}}}',
      executionMode: 'auto',
      reasoning: true,
      retry: { maxAttempts: 1, backoffSeconds: 0 },
    },
  }
  if (type === 'condition') return {
    ...base,
    type,
    config: {
      left: { source: 'input', path: 'parameters.value' },
      operator: 'exists',
      right: null,
    },
  }
  if (type === 'approval') return {
    ...base,
    type,
    config: { title: '需要人工批准', question: '是否继续执行后续步骤？', description: '' },
  }
  return { ...base, type: 'output', config: { outputs: {} } }
}

export function layoutAutomationGraph(graph: AutomationGraph): AutomationGraph {
  const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  layout.setGraph({ rankdir: 'LR', ranksep: 90, nodesep: 44, marginx: 28, marginy: 28 })
  for (const node of graph.nodes) layout.setNode(node.nodeId, { width: 230, height: 112 })
  for (const edge of graph.edges) layout.setEdge(edge.sourceNodeId, edge.targetNodeId)
  dagre.layout(layout)
  return {
    ...graph,
    nodes: graph.nodes.map(node => {
      const position = layout.node(node.nodeId) as { x: number; y: number } | undefined
      if (!position) return node
      return { ...node, position: { x: position.x - 115, y: position.y - 56 } }
    }),
  }
}

export function nextEdgeId(source: string, target: string): string {
  return `edge_${source}_${target}_${crypto.randomUUID().slice(0, 6)}`
}

function normalizePort(value: string | null | undefined): AutomationEdge['sourcePort'] {
  return value === 'success' || value === 'error' || value === 'true' || value === 'false'
    || value === 'approved' || value === 'rejected'
    ? value
    : 'default'
}

function nodeLabel(type: AutomationNodeType, tool?: ToolDescriptor): string {
  if (type === 'trigger') return '触发器'
  if (type === 'tool') return tool?.label ?? '工具'
  if (type === 'agent') return '智能体'
  if (type === 'condition') return '条件判断'
  if (type === 'approval') return '人工审批'
  return '输出'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

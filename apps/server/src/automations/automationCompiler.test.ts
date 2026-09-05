// +-------------------------------------------------------------------------
//
//   地理智能平台 - Automation 图编译器测试
//
//   文件:       automationCompiler.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import type { ToolDef } from '../framework/types.js'
import { automationDefinitionSchema, type AutomationDefinition } from './schemas.js'
import { AutomationCompiler } from './automationCompiler.js'

const inspectTool = {
  name: 'inspect',
  label: '检查数据',
  isReadOnly: true,
  jsonSchema: {
    type: 'object',
    properties: { dataset_id: { type: 'string' } },
    required: ['dataset_id'],
    additionalProperties: false,
  },
} as ToolDef

function compiler() {
  return new AutomationCompiler({ get: name => name === 'inspect' ? inspectTool : undefined })
}

function definition(): AutomationDefinition {
  return automationDefinitionSchema.parse({
    automationId: 'automation_test',
    name: '测试工具流',
    description: '',
    version: '1.0.0',
    revision: 1,
    publishedRevision: 1,
    source: 'builtin',
    lifecycle: 'published',
    workspaceId: null,
    createdByUserId: null,
    enabled: true,
    parametersSchema: {
      type: 'object',
      properties: { datasetId: { type: 'string' } },
      required: ['datasetId'],
      additionalProperties: false,
    },
    defaultParameters: { datasetId: 'latest_upload' },
    requiredTools: ['inspect'],
    requiresApproval: false,
    timeoutSeconds: 900,
    outputType: 'conversation',
    graph: {
      schemaVersion: 1,
      entryNodeId: 'trigger',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { nodeId: 'trigger', type: 'trigger', label: '触发', description: '', position: { x: 0, y: 0 }, config: {} },
        {
          nodeId: 'inspect', type: 'tool', label: '检查', description: '', position: { x: 200, y: 0 },
          config: {
            toolName: 'inspect',
            arguments: { dataset_id: { source: 'input', path: 'parameters.datasetId' } },
            approvalMode: 'auto',
            retry: { maxAttempts: 1, backoffSeconds: 0 },
          },
        },
        {
          nodeId: 'output', type: 'output', label: '输出', description: '', position: { x: 400, y: 0 },
          config: { outputs: { result: { source: 'node', nodeId: 'inspect', path: 'payload' } } },
        },
      ],
      edges: [
        { edgeId: 'a', sourceNodeId: 'trigger', targetNodeId: 'inspect', sourcePort: 'default' },
        { edgeId: 'b', sourceNodeId: 'inspect', targetNodeId: 'output', sourcePort: 'success' },
      ],
    },
  })
}

describe('AutomationCompiler', () => {
  it('compiles a valid tool DAG and validates runtime parameters', () => {
    const compiled = compiler().compile(definition())
    expect(compiled.topologicalOrder).toEqual(['trigger', 'inspect', 'output'])
    expect(() => compiled.validateParameters({ datasetId: 'dataset_1' })).not.toThrow()
    expect(() => compiled.validateParameters({})).toThrow('Automation 参数无效')
  })

  it('rejects cycles instead of attempting best-effort execution', () => {
    const value = definition()
    value.graph.edges.push({ edgeId: 'cycle', sourceNodeId: 'output', targetNodeId: 'inspect', sourcePort: 'default' })
    const result = compiler().validate(value)
    expect(result.valid).toBe(false)
    expect(result.issues.some(issue => issue.code === 'graph_cycle' || issue.code === 'output_has_edges')).toBe(true)
  })

  it('rejects missing required tool arguments', () => {
    const value = definition()
    const node = value.graph.nodes.find(item => item.nodeId === 'inspect')
    if (!node || node.type !== 'tool') throw new Error('fixture missing tool node')
    node.config.arguments = {}
    const result = compiler().validate(value)
    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'tool_argument_required', nodeId: 'inspect' }))
  })

  it('rejects required parameters that are declared but never consumed', () => {
    const value = definition()
    const node = value.graph.nodes.find(item => item.nodeId === 'inspect')
    if (!node || node.type !== 'tool') throw new Error('fixture missing tool node')
    node.config.arguments.dataset_id = { source: 'literal', value: 'fixed_dataset' }

    const result = compiler().validate(value)

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'required_parameter_unused',
      path: 'parametersSchema.required.datasetId',
    }))
  })

  it('rejects bindings to nodes that are not upstream dependencies', () => {
    const value = definition()
    const output = value.graph.nodes.find(item => item.nodeId === 'output')
    if (!output || output.type !== 'output') throw new Error('fixture missing output node')
    output.config.outputs.result = { source: 'node', nodeId: 'output', path: 'payload' }
    const result = compiler().validate(value)
    expect(result.valid).toBe(false)
    expect(result.issues.some(issue => issue.code === 'binding_not_ancestor')).toBe(true)
  })

  it('accepts valueRef bindings by semantic kind instead of array position', () => {
    const value = definition()
    const output = value.graph.nodes.find(item => item.nodeId === 'output')
    if (!output || output.type !== 'output') throw new Error('fixture missing output node')
    output.config.outputs.result = {
      source: 'value_ref',
      nodeId: 'inspect',
      kind: 'meteorological_dataset',
      path: 'refId',
    }

    expect(compiler().validate(value)).toMatchObject({ valid: true })
  })

  it('accepts a deterministic conversation Automation exposed to Agent invocation', () => {
    const value = definition()
    value.agentInvocation = {
      enabled: true,
      description: '当用户要求检查指定数据集时执行。',
      examples: ['检查刚上传的数据集。'],
    }
    const output = value.graph.nodes.find(item => item.nodeId === 'output')
    if (!output || output.type !== 'output') throw new Error('fixture missing output node')
    output.config.outputs.answer = { source: 'node', nodeId: 'inspect', path: 'payload.answer' }

    expect(compiler().validate(value)).toMatchObject({ valid: true })
  })

  it('rejects Agent-only tools inside a Automation graph', () => {
    const agentOnlyTool = { ...inspectTool, executionSurfaces: ['agent'] as const }
    const result = new AutomationCompiler({ get: name => name === 'inspect' ? agentOnlyTool : undefined })
      .validate(definition())

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'tool_surface_forbidden',
      nodeId: 'inspect',
    }))
  })

  it('requires Agent-callable automations to expose a final answer', () => {
    const value = definition()
    value.agentInvocation = {
      enabled: true,
      description: '当用户要求检查指定数据集时执行。',
      examples: ['检查刚上传的数据集。'],
    }

    const result = compiler().validate(value)
    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'agent_invocation_answer' }))
  })

  it('rejects automatic retries for side-effect tools', () => {
    const value = definition()
    const node = value.graph.nodes.find(item => item.nodeId === 'inspect')
    if (!node || node.type !== 'tool') throw new Error('fixture missing tool node')
    node.config.retry = { maxAttempts: 2, backoffSeconds: 1 }
    const sideEffectTool = { ...inspectTool, isReadOnly: false }

    const result = new AutomationCompiler({ get: name => name === 'inspect' ? sideEffectTool : undefined })
      .validate(value)

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'tool_retry_side_effect' }))
  })

  it('rejects automatic retries for Agent nodes', () => {
    const value = definition()
    value.graph.nodes.splice(2, 0, {
      nodeId: 'summarize',
      type: 'agent',
      label: '总结',
      description: '',
      position: { x: 300, y: 0 },
      config: {
        promptTemplate: '总结结果',
        executionMode: 'auto',
        reasoning: true,
        retry: { maxAttempts: 2, backoffSeconds: 1 },
      },
    })
    value.graph.edges = [
      { edgeId: 'a', sourceNodeId: 'trigger', targetNodeId: 'inspect', sourcePort: 'default' },
      { edgeId: 'b', sourceNodeId: 'inspect', targetNodeId: 'summarize', sourcePort: 'success' },
      { edgeId: 'c', sourceNodeId: 'summarize', targetNodeId: 'output', sourcePort: 'success' },
    ]

    const result = compiler().validate(value)

    expect(result.valid).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'agent_retry_side_effect' }))
  })
})

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 工具桥接测试
//
//   文件:       agentsToolBridge.test.ts
//
//   日期:       2026年06月24日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { RunContext } from '@openai/agents'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../framework/registry.js'
import type { ToolDef, ToolProvider } from '../framework/types.js'
import { createAgentsTools } from './agentsToolBridge.js'

describe('createAgentsTools', () => {
  it('makes valueRef kind constraints visible to the model', () => {
    const registry = new ToolRegistry()
    registry.register(providerFromTools([{
      name: 'render_rainfall_risk_map',
      label: '生成短时强降水风险区划图',
      description: '生成风险区划图',
      prompt: '用于测试工具 prompt 会进入 Agent 可见描述。',
      group: '气象',
      tags: ['meteorology'],
      isReadOnly: true,
      isDestructive: false,
      jsonSchema: {
        type: 'object',
        properties: {
          dataset_ref: {
            type: 'string',
            description: '必须使用当前 run 中已存在的 valueRef ID',
            'x-source': 'value_ref',
            'x-value-ref-kinds': ['meteorological_dataset'],
          },
          boundary_ref: {
            type: 'string',
            description: '必须使用当前 run 中已存在的 valueRef ID',
            'x-source': 'value_ref',
            'x-value-ref-kinds': ['feature_collection', 'layer'],
          },
        },
        required: ['dataset_ref', 'boundary_ref'],
      },
      handler: async () => ({
        message: 'ok',
        payload: {},
        warnings: [],
        resultId: 'result_1',
        source: 'test',
      }),
    }]))

    const [tool] = createAgentsTools(registry, new Set(), { schemaMode: 'strict' })
    const properties = tool.parameters.properties as Record<string, Record<string, unknown>>

    expect(tool.description).toContain('dataset_ref 传字符串 refId 时只接受 meteorological_dataset')
    expect(tool.description).toContain('boundary_ref 传字符串 refId 时只接受 feature_collection / layer')
    expect(properties.dataset_ref.description).toContain('允许的 valueRef kind: meteorological_dataset')
    expect(properties.dataset_ref.description).toContain('禁止传入其它 kind')
    expect(properties.workflowStepId?.description).toContain('对应的 stepId')
    expect(tool.description).not.toContain('工作流步骤身份')
  })

  it('exposes only tools declared for the Agent execution surface', () => {
    const registry = new ToolRegistry()
    registry.register(providerFromTools([
      testTool('agent_visible', ['agent', 'debug']),
      testTool('automation_internal', ['automation', 'debug']),
    ]))

    expect(createAgentsTools(registry, new Set(), { schemaMode: 'strict' }).map(tool => tool.name)).toEqual(['agent_visible'])
    expect(() => createAgentsTools(registry, new Set(), {
      schemaMode: 'strict',
      allowedToolNames: new Set(['automation_internal']),
    }))
      .toThrow('非 Agent 执行表面工具')
  })

  it('keeps optional fields optional for compatible Chat Completions models', () => {
    const registry = new ToolRegistry()
    registry.register(providerFromTools([{
      ...testTool('agent_visible', ['agent']),
      jsonSchema: {
        type: 'object',
        properties: {
          dataset_ref: { type: 'string' },
          variable: { type: 'string' },
        },
        required: [],
        additionalProperties: false,
      },
    }]))

    const [tool] = createAgentsTools(registry, new Set(), { schemaMode: 'compatible' })

    expect(tool.strict).toBe(false)
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: [],
      additionalProperties: true,
    })
  })

  it('uses Agents SDK dynamic enablement to expose only planning-safe tools before approval', async () => {
    const registry = new ToolRegistry()
    registry.register(providerFromTools([
      { ...testTool('catalog_lookup', ['agent']) },
      testTool('query_layer', ['agent']),
    ]))
    const tools = createAgentsTools(registry, new Set(), { schemaMode: 'compatible' })
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    let executionEnabled = false
    const runContext = new RunContext({
      runId: 'run_plan_boundary',
      currentObjectiveRevision: () => 1,
      isExecutionEnabled: () => executionEnabled,
      isSdkExtensionEnabled: () => executionEnabled,
      isToolEnabled: toolName => executionEnabled || toolName === 'catalog_lookup',
      validateToolCall: () => null,
      formatToolFailureForModel: (_toolName, message) => message,
      rejectPreparedToolCall: async () => {},
      canonicalizeToolCall: async (_toolName, args) => args,
      prepareToolCall: async () => {},
      requiresApproval: async () => false,
      requiresSdkExtensionApproval: async () => false,
      executeTool: async () => 'ok',
      runToolExecution: async (_lane, operation) => operation(),
      toolOutputMetadata: callId => ({
        schemaVersion: 1,
        callId,
        toolName: 'test',
        resultId: null,
        valueRefIds: [],
        artifactIds: [],
        display: null,
      }),
    })
    const agent = {} as never

    await expect(byName.get('catalog_lookup')?.isEnabled(runContext, agent)).resolves.toBe(true)
    await expect(byName.get('query_layer')?.isEnabled(runContext, agent)).resolves.toBe(false)

    executionEnabled = true
    await expect(byName.get('query_layer')?.isEnabled(runContext, agent)).resolves.toBe(true)
  })
})

function testTool(name: string, executionSurfaces: ToolDef['executionSurfaces']): ToolDef {
  return {
    name,
    label: name === 'agent_visible' ? '可见测试工具' : '自动化流程内部工具',
    description: '测试执行表面隔离。',
    prompt: '仅用于测试工具执行表面。',
    group: '测试',
    tags: ['test'],
    isReadOnly: true,
    isDestructive: false,
    ...(executionSurfaces ? { executionSurfaces } : {}),
    jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    handler: async () => ({
      message: '完成', payload: {}, warnings: [], resultId: `result_${name}`, source: 'test',
    }),
  }
}

function providerFromTools(tools: ToolDef[]): ToolProvider {
  return {
    manifest: {
      id: 'agent-bridge-test',
      name: 'Agent Bridge Test',
      version: '1.0.0',
      author: 'test',
      language: 'typescript',
      description: 'Agent Bridge Test',
      tools: tools.map(({ handler: _handler, providerId: _providerId, language: _language, ...definition }) => definition),
    },
    tools: () => tools,
  }
}

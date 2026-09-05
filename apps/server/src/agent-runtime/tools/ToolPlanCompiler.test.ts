// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具目录与计划编译测试
//
//   文件:       ToolPlanCompiler.test.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ModelRequest } from '@openai/agents'
import { describe, expect, it } from 'vitest'

import type { ToolDef } from '../../framework/types.js'
import {
  platformToolDescriptorSource,
  sdkToolDescriptorSource,
} from './ToolCatalog.js'
import { compileToolPlan } from './ToolPlanCompiler.js'

describe('ToolCatalog and ToolPlanCompiler', () => {
  it('normalizes explicit policy and discovers nested value-ref kinds once', () => {
    const source = platformToolDescriptorSource(toolDefinition())

    expect(source).toMatchObject({
      name: 'query_layer',
      kind: 'platform',
      namespace: 'layers',
      exposure: 'plan_readonly',
      effect: 'read',
      parallelism: 'shared',
      approvalAction: null,
      replayPolicy: 'safe',
      requiredCapabilities: ['world.layers.read'],
      requiredValueRefKinds: ['feature_collection', 'layer'],
      executionSurfaces: ['agent', 'automation'],
    })
    expect(Object.isFrozen(source)).toBe(true)
  })

  it('binds the exact model request to native deferred tools and namespaces', () => {
    const request = modelRequest([serializedFunction({
      name: 'search_layers',
      description: '搜索图层',
      namespace: 'geodata',
      namespaceDescription: '按需加载地理数据读取工具',
      deferLoading: true,
    })])
    const source = sdkToolDescriptorSource({
      name: 'search_layers',
      kind: 'mcp',
      providerId: 'catalog-server',
      namespace: 'geodata',
      exposure: 'deferred',
      effect: 'read',
      parallelism: 'shared',
      approvalAction: null,
      replayPolicy: 'safe',
    })
    const plan = compileToolPlan({
      request,
      sources: [source],
      providerCapabilities: { nativeDeferredTools: true, nativeToolNamespaces: true },
    })

    expect(plan.entries).toEqual([
      expect.objectContaining({
        name: 'search_layers',
        kind: 'mcp',
        exposure: 'deferred',
        deferLoading: true,
      }),
    ])
    expect(plan.namespaces).toEqual([{
      name: 'geodata',
      description: '按需加载地理数据读取工具',
      toolNames: ['search_layers'],
      deferred: true,
    }])
    expect(plan.deferredCatalogObjectHash).toMatch(/^sha256:/u)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.entries)).toBe(true)
  })

  it('does not pretend deferred support for providers that lack the native protocol', () => {
    const request = modelRequest([serializedFunction({
      name: 'search_layers',
      description: '搜索图层',
      deferLoading: true,
    })])
    const source = sdkToolDescriptorSource({
      name: 'search_layers',
      kind: 'mcp',
      exposure: 'deferred',
      effect: 'read',
      parallelism: 'shared',
      approvalAction: null,
      replayPolicy: 'safe',
    })

    expect(() => compileToolPlan({
      request,
      sources: [source],
      providerCapabilities: { nativeDeferredTools: false, nativeToolNamespaces: false },
    })).toThrow(/不支持 native deferred tools/u)
  })

  it('changes the plan digest when the exact provider-visible definition changes', () => {
    const source = sdkToolDescriptorSource({
      name: 'query_layer',
      kind: 'hosted',
      effect: 'read',
      parallelism: 'shared',
      replayPolicy: 'safe',
    })
    const first = compileToolPlan({
      request: modelRequest([serializedFunction({ name: 'query_layer', description: '查询图层' })]),
      sources: [source],
      providerCapabilities: { nativeDeferredTools: false, nativeToolNamespaces: false },
    })
    const second = compileToolPlan({
      request: modelRequest([serializedFunction({ name: 'query_layer', description: '查询并统计图层' })]),
      sources: [source],
      providerCapabilities: { nativeDeferredTools: false, nativeToolNamespaces: false },
    })

    expect(first.entries[0]?.schemaDigest).toBe(second.entries[0]?.schemaDigest)
    expect(first.entries[0]?.definitionDigest).not.toBe(second.entries[0]?.definitionDigest)
    expect(first.catalogDigest).not.toBe(second.catalogDigest)
  })

  it('hard fails model-visible tools that lack one execution source', () => {
    expect(() => compileToolPlan({
      request: modelRequest([serializedFunction({ name: 'unknown', description: '未知工具' })]),
      sources: [],
      providerCapabilities: { nativeDeferredTools: false, nativeToolNamespaces: false },
    })).toThrow(/未绑定执行来源/u)
  })
})

function toolDefinition(): ToolDef {
  return {
    name: 'query_layer',
    label: '查询图层',
    description: '查询图层',
    prompt: '读取图层，不修改世界状态。',
    group: 'layers',
    tags: [],
    isReadOnly: true,
    isDestructive: false,
    parallelSafe: true,
    executionSurfaces: ['agent', 'automation'],
    runtimePolicy: {
      namespace: 'layers',
      exposure: 'plan_readonly',
      effect: 'read',
      parallelism: 'shared',
      approvalAction: null,
      replayPolicy: 'safe',
      requiredCapabilities: ['world.layers.read'],
    },
    jsonSchema: {
      type: 'object',
      properties: {
        source: {
          anyOf: [
            { type: 'string', 'x-value-ref-kinds': ['layer'] },
            {
              type: 'array',
              items: { type: 'string', 'x-value-ref-kinds': ['feature_collection'] },
            },
          ],
        },
      },
      additionalProperties: false,
    },
    handler: async () => ({
      message: 'ok', payload: {}, warnings: [], resultId: 'result_1', source: 'test',
    }),
  }
}

function modelRequest(tools: ModelRequest['tools']): ModelRequest {
  return {
    input: [],
    modelSettings: {},
    tools,
    outputType: 'text',
    handoffs: [],
    tracing: false,
  }
}

function serializedFunction(input: {
  name: string
  description: string
  deferLoading?: boolean
  namespace?: string
  namespaceDescription?: string
}): ModelRequest['tools'][number] {
  return {
    type: 'function',
    name: input.name,
    description: input.description,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    strict: true,
    ...(input.deferLoading === undefined ? {} : { deferLoading: input.deferLoading }),
    ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
    ...(input.namespaceDescription === undefined
      ? {}
      : { namespaceDescription: input.namespaceDescription }),
  }
}

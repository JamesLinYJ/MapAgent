// +-------------------------------------------------------------------------
//
//   地理智能平台 - ToolRegistry 契约测试
//
//   文件:       registry.test.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from './registry.js'
import type { ToolContext, ToolProvider } from './types.js'
import { parametersForAgentsSdk, parametersFromJsonSchema, stripNullObjectValues } from './schema.js'
import { validateToolProvider } from './validation.js'
import { parseEnv } from './env.js'
import type { ManagedLayerService } from '../gis/managedLayers/managedLayerService.js'
import chartProvider from '../tools/chart/index.js'
import geocodeProvider from '../tools/geocode/index.js'
import { createMediaProvider } from '../tools/media/index.js'
import memoryProvider from '../tools/memory/index.js'
import planProvider from '../tools/plan/index.js'
import developerProvider from '../tools/developer/index.js'
import { createMeteorologyProvider } from '../tools/meteorology/index.js'
import { createPublicWeatherProvider } from '../tools/publicWeather/index.js'
import { createSpatialProvider } from '../tools/spatial/index.js'
import { createRoutingProvider } from '../tools/routing/index.js'

describe('ToolRegistry contract', () => {
  it('rejects manifest and runtime descriptor drift', () => {
    const registry = new ToolRegistry()
    const drifted = provider()
    drifted.manifest.tools[0].jsonSchema = {
      type: 'object',
      properties: { hidden_parameter: { type: 'string' } },
    }
    expect(() => registry.register(drifted)).toThrow('jsonSchema 与 manifest 不一致')
  })

  it('materializes a provider tool catalog only once during registration', () => {
    const registry = new ToolRegistry()
    const currentProvider = provider()
    const tools = vi.fn(currentProvider.tools)
    currentProvider.tools = tools

    registry.register(currentProvider)

    expect(tools).toHaveBeenCalledOnce()
  })

  it('rejects unknown parameters before execution', async () => {
    const registry = new ToolRegistry()
    registry.register(provider())
    await expect(registry.execute('example', { unknown: true }, context())).rejects.toThrow('未知参数')
  })

  it('validates nested parameter types and ranges before execution', async () => {
    const registry = new ToolRegistry()
    registry.register(nestedProvider())
    await expect(registry.execute('nested', { points: [{ lat: 91, lon: 120 }] }, context())).rejects.toThrow('不能大于 90')
    await expect(registry.execute('nested', { points: 'invalid' }, context())).rejects.toThrow('必须是数组')
  })

  it('exposes management metadata for tools and provider statuses', () => {
    const registry = new ToolRegistry()
    registry.register(provider())
    registry.markUnavailable('missing-provider', '缺少依赖')

    expect(registry.descriptors()[0]).toMatchObject({
      name: 'example',
      providerId: 'test-provider',
      language: 'typescript',
      isReadOnly: true,
      isDestructive: false,
      meta: {
        providerId: 'test-provider',
        language: 'typescript',
        approvalRecommended: false,
      },
    })
    expect(registry.providerStatuses()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: 'test-provider',
        version: '1',
        author: 'test',
        language: 'typescript',
        toolCount: 1,
        available: true,
      }),
      expect.objectContaining({
        providerId: 'missing-provider',
        toolCount: 0,
        available: false,
        error: '缺少依赖',
      }),
    ]))
  })

  it('surfaces tool failures instead of returning synthetic success', async () => {
    const registry = new ToolRegistry()
    registry.register(provider(true))
    await expect(registry.execute('example', {}, context())).rejects.toThrow('真实失败')
  })

  it('rejects tool definitions without a Chinese display label', () => {
    const registry = new ToolRegistry()
    const invalidProvider = provider()
    const manifestTool = invalidProvider.manifest.tools[0]
    if (!manifestTool) throw new Error('测试 Provider 缺少工具定义')
    manifestTool.label = 'Example Tool'

    expect(() => registry.register(invalidProvider)).toThrow('必须包含中文展示名称')
  })

  it('requires every builtin tool to expose Chinese display and prompt contracts', () => {
    // 工具 label 面向用户，prompt 面向 Agent；两者都是工具注册边界的一部分。
    const providers = builtinProviders()
    for (const currentProvider of providers) {
      expect(() => validateToolProvider(currentProvider)).not.toThrow()
      for (const tool of currentProvider.tools()) {
        expect(tool.label, `${tool.name} label`).toMatch(/[\u3400-\u9fff]/u)
        expect(tool.prompt.trim(), `${tool.name} prompt`).toBeTruthy()
        expect(tool.prompt, `${tool.name} prompt`).toMatch(/[\u4e00-\u9fff]/)
      }
    }
  })

  it('rejects unsupported artifact display surfaces at execution boundary', async () => {
    const registry = new ToolRegistry()
    registry.register(artifactProvider({ displaySurfaces: ['miniapp'] }))
    await expect(registry.execute('artifact_example', {}, context())).rejects.toThrow('展示契约无效')
  })

  it('hard-fails unknown value references', () => {
    expect(() => context().resolveValueRef('missing')).toThrow('未知 valueRef')
  })

  it('enforces valueRef kinds from the actually matched oneOf branch before execution', async () => {
    const registry = new ToolRegistry()
    const handler = vi.fn()
    registry.register(valueRefBranchProvider(handler))
    const ctx = context()
    ctx.resolveValueRef = refId => ({ refId, kind: 'kind_b', label: refId, value: {} })

    await expect(registry.execute('branch_ref', {
      selection: { mode: 'a', input: 'ref_b' },
    }, ctx)).rejects.toThrow('selection.input 必须引用 kind_a，实际为 kind_b')
    expect(handler).not.toHaveBeenCalled()
  })

  it('enforces local $defs refs inside array prefixItems before execution', async () => {
    const registry = new ToolRegistry()
    const handler = vi.fn()
    registry.register(valueRefBranchProvider(handler))
    const ctx = context()
    ctx.resolveValueRef = refId => ({ refId, kind: 'kind_b', label: refId, value: {} })

    await expect(registry.execute('branch_ref', {
      selection: { mode: 'b', input: 'ref_b' },
      tuple: ['ref_b'],
    }, ctx)).rejects.toThrow('tuple.0 必须引用 kind_a，实际为 kind_b')
    expect(handler).not.toHaveBeenCalled()
  })

  it('enforces both a local $ref target and its sibling valueRef constraint', async () => {
    const registry = new ToolRegistry()
    const handler = vi.fn()
    registry.register(valueRefBranchProvider(handler))
    const ctx = context()
    ctx.resolveValueRef = refId => ({ refId, kind: 'kind_a', label: refId, value: {} })

    await expect(registry.execute('branch_ref', {
      selection: { mode: 'a', input: 'ref_a' },
      sibling: 'ref_a',
    }, ctx)).rejects.toThrow('sibling 必须引用 kind_b，实际为 kind_a')
    expect(handler).not.toHaveBeenCalled()
  })

  it('keeps runtime optional fields while exposing nullable fields to Agents SDK', () => {
    // OpenAI strict tool schemas require every property to be required. Handlers still use
    // omission internally, so the model sends null and the bridge removes null before execution.
    const schema = {
      type: 'object',
      properties: {
        layerKey: { type: 'string' },
        bbox: { type: 'array', items: { type: 'number' } },
        options: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            color: { type: 'string' },
          },
          required: ['label'],
        },
      },
      required: ['layerKey'],
    }

    expect(parametersFromJsonSchema(schema).safeParse({ layerKey: 'districts' }).success).toBe(true)
    expect(parametersFromJsonSchema(schema).safeParse({ layerKey: 'districts', bbox: null }).success).toBe(false)

    const agentsParameters = parametersForAgentsSdk(schema)
    expect(agentsParameters.safeParse({ layerKey: 'districts' }).success).toBe(false)
    expect(agentsParameters.safeParse({
      layerKey: 'districts',
      bbox: null,
      options: { label: '区划', color: null },
    }).success).toBe(true)
    expect(z.toJSONSchema(agentsParameters)).toMatchObject({
      required: ['layerKey', 'bbox', 'options'],
      properties: {
        bbox: {
          anyOf: [
            { type: 'array' },
            { type: 'null' },
          ],
        },
        options: {
          anyOf: [
            {
              required: ['label', 'color'],
              type: 'object',
            },
            { type: 'null' },
          ],
        },
      },
    })
    expect(stripNullObjectValues({
      layerKey: 'districts',
      bbox: null,
      options: { label: '区划', color: null },
    })).toEqual({
      layerKey: 'districts',
      options: { label: '区划' },
    })
  })
})

function builtinProviders(): ToolProvider[] {
  const env = parseEnv({
    API_PORT: '0',
    API_HOST: '127.0.0.1',
    DATABASE_URL: 'postgres://user:password@127.0.0.1:5432/geo_agent_platform_test',
    RUNTIME_ROOT: 'runtime-test',
    APP_BASE_URL: 'http://localhost:8000',
    BETTER_AUTH_URL: 'http://localhost:8000',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-1234',
    ENABLED_TOOL_PROVIDERS: 'geo-platform-spatial',
  })
  const managedLayers = {} as unknown as ManagedLayerService
  return [
    chartProvider as ToolProvider,
    geocodeProvider as ToolProvider,
    createMediaProvider(env),
    memoryProvider as ToolProvider,
    planProvider as ToolProvider,
    developerProvider as ToolProvider,
    createMeteorologyProvider(env),
    createPublicWeatherProvider(env),
    createSpatialProvider(managedLayers, { runtimeRoot: env.RUNTIME_ROOT }),
    createRoutingProvider({
      valhallaBaseUrl: env.VALHALLA_BASE_URL,
      timeoutMs: env.ROUTING_TIMEOUT_MS,
    }),
  ]
}

function provider(fails = false): ToolProvider {
  return {
    manifest: {
      id: 'test-provider', name: '测试', version: '1', author: 'test', language: 'typescript', description: '测试',
      tools: [{
        name: 'example', label: '示例', description: '示例工具', group: '测试', tags: [],
        isReadOnly: true, isDestructive: false, jsonSchema: { type: 'object', properties: {} },
      }],
    },
    tools: () => [{
      name: 'example', label: '示例', description: '示例工具', group: '测试', tags: [],
      prompt: '用于测试工具注册和执行边界。',
      isReadOnly: true, isDestructive: false, jsonSchema: { type: 'object', properties: {} },
      handler: async () => {
        if (fails) throw new Error('真实失败')
        return { message: '成功', payload: {}, warnings: [], resultId: 'result_1', source: 'test' }
      },
    }],
  }
}

function artifactProvider(metadata: Record<string, unknown>): ToolProvider {
  const definition = {
    name: 'artifact_example',
    label: 'Artifact 示例',
    description: '验证 artifact 展示面契约',
    prompt: '用于测试 artifact 展示面校验。',
    group: '测试',
    tags: [],
    isReadOnly: true,
    isDestructive: false,
    jsonSchema: { type: 'object', properties: {} },
  }
  return {
    manifest: {
      id: 'artifact-provider', name: 'Artifact 测试', version: '1', author: 'test', language: 'typescript', description: 'Artifact 测试',
      tools: [definition],
    },
    tools: () => [{
      ...definition,
      handler: async () => ({
        message: '成功',
        payload: {},
        warnings: [],
        resultId: 'result_artifact',
        source: 'test',
        artifacts: [{
          artifactId: 'artifact_1',
          artifactType: 'raster_png',
          name: '预览图',
          uri: '/api/v1/results/artifact_1/file',
          relativePath: 'artifacts/run_1/artifact_1.png',
          display: metadata,
          metadata: { relativePath: 'artifacts/run_1/artifact_1.png' },
        }],
      }),
    }],
  }
}

function nestedProvider(): ToolProvider {
  const definition = {
    name: 'nested', label: '嵌套参数', description: '嵌套参数校验', prompt: '用于测试嵌套参数 schema 校验。', group: '测试', tags: [],
    isReadOnly: true, isDestructive: false,
    jsonSchema: {
      type: 'object',
      properties: {
        points: {
          type: 'array', minItems: 1, items: {
            type: 'object',
            properties: {
              lat: { type: 'number', minimum: -90, maximum: 90 },
              lon: { type: 'number', minimum: -180, maximum: 180 },
            },
            required: ['lat', 'lon'],
          },
        },
      },
      required: ['points'],
    },
  }
  return {
    manifest: {
      id: 'nested-provider', name: '嵌套测试', version: '1', author: 'test', language: 'typescript', description: '嵌套测试',
      tools: [definition],
    },
    tools: () => [{ ...definition, handler: async () => ({ message: '成功', payload: {}, warnings: [], resultId: 'result_nested', source: 'test' }) }],
  }
}

function valueRefBranchProvider(onExecute: () => void = () => undefined): ToolProvider {
  const jsonSchema = {
    type: 'object',
    $defs: {
      refA: { type: 'string', 'x-value-ref-kinds': ['kind_a'] },
      refB: { type: 'string', 'x-value-ref-kinds': ['kind_b'] },
    },
    properties: {
      selection: {
        oneOf: [
          {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['a'] },
              input: { $ref: '#/$defs/refA' },
            },
            required: ['mode', 'input'],
          },
          {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['b'] },
              input: { $ref: '#/$defs/refB' },
            },
            required: ['mode', 'input'],
          },
        ],
      },
      tuple: {
        type: 'array',
        prefixItems: [{ $ref: '#/$defs/refA' }],
      },
      sibling: {
        $ref: '#/$defs/refA',
        'x-value-ref-kinds': ['kind_b'],
      },
    },
    required: ['selection'],
  }
  const definition = {
    name: 'branch_ref', label: '分支引用', description: '分支 valueRef 校验', prompt: '根据分支校验 valueRef 类型。', group: '测试', tags: [],
    isReadOnly: true, isDestructive: false, jsonSchema,
  }
  return {
    manifest: {
      id: 'branch-ref-provider', name: '分支引用测试', version: '1', author: 'test', language: 'typescript', description: '分支引用测试',
      tools: [definition],
    },
    tools: () => [{
      ...definition,
      handler: async () => {
        onExecute()
        return { message: '成功', payload: {}, warnings: [], resultId: 'result_branch', source: 'test' }
      },
    }],
  }
}

function context(): ToolContext {
  return {
    runId: 'run_1', sessionId: 'session_1', threadId: 'thread_1', state: new Map(),
    resolveValueRef: refId => { throw new Error(`未知 valueRef：${refId}`) },
    invokeStructuredModel: async () => ({}),
    log: () => undefined,
  }
}

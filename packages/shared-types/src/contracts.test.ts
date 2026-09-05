import { describe, expect, it } from 'vitest'
import {
  agentRuntimeConfigSchema,
  supervisorDeliverySchema,
} from './runtime.js'
import {
  wsCommandContracts,
  wsCommandContract,
  wsControlCommandSchema,
  wsControlCommands,
  wsControlResponseEnvelopeSchema,
  wsServerMessageSchema,
  wsServerPushSchema,
  parseWsControlRequest,
} from './transport.js'
import { workerToolCatalogSchema } from './worker.js'
import { agentStateSchema } from './core.js'

describe('shared boundary contracts', () => {
  it('由命令契约派生控制信封与 payload 联合校验', () => {
    expect(parseWsControlRequest({
      type: 'run:get',
      id: 'request_1',
      payload: { runId: 'run_1' },
    })).toEqual({
      type: 'run:get',
      id: 'request_1',
      payload: { runId: 'run_1' },
    })
    expect(parseWsControlRequest({
      type: 'system:get',
      id: 'request_2',
    }).payload).toEqual({})
    expect(() => parseWsControlRequest({
      type: 'run:get',
      id: 'request_3',
      payload: { runId: '' },
    })).toThrow()
    expect(wsControlResponseEnvelopeSchema.parse({
      type: 'response',
      id: 'request_4',
      payload: {
        ok: false,
        error: { code: 'version_conflict', message: '配置已被其他窗口更新。' },
      },
    }).payload).toMatchObject({ ok: false, error: { code: 'version_conflict' } })
    expect(wsControlResponseEnvelopeSchema.safeParse({
      type: 'response',
      id: 'request_5',
      payload: { ok: false, error: { code: 'unknown_error', message: '未知错误' } },
    }).success).toBe(false)
    expect(wsServerMessageSchema.safeParse({
      type: 'keepalive',
      id: null,
      payload: { data: {} },
    }).success).toBe(true)
    expect(wsServerPushSchema.safeParse({
      type: 'keepalive',
      id: 'request_5',
      payload: { data: {} },
    }).success).toBe(false)
  })

  it('keeps every advertised WebSocket command mapped to one contract', () => {
    expect(Object.keys(wsCommandContracts).sort()).toEqual([...wsControlCommands].sort())
    expect(wsControlCommandSchema.safeParse('run:start').success).toBe(true)
    expect(wsControlCommandSchema.safeParse('run:unknown').success).toBe(false)

    const runStart = wsCommandContract('run:start')
    expect(runStart.category).toBe('write')
    expect(runStart.csrf).toBe(true)
    expect(runStart.payload.safeParse({ query: '分析杭州降水' }).success).toBe(true)
    expect(runStart.payload.safeParse({
      query: '分析杭州降水',
      runProfile: 'geospatial_compose',
    }).success).toBe(true)
    expect(runStart.payload.safeParse({ query: '分析杭州降水', runProfile: 'unknown' }).success).toBe(false)
    expect(runStart.payload.safeParse({ query: '' }).success).toBe(false)
    expect(wsCommandContract('background-task:promote').category).toBe('write')
    const mapContext = {
      capturedAt: '2026-08-08T04:00:00.000Z',
      viewport: {
        bounds: [119, 29, 121, 31],
        center: [120, 30],
        zoom: 8,
        bearing: 0,
        pitch: 20,
      },
      crs: 'OGC:CRS84',
      renderProjection: 'EPSG:3857',
      renderState: { status: 'idle', tilesLoaded: true },
      renderedLayers: [{
        mapLayerId: 'radar_1',
        title: '雷达回波',
        currentFrameId: 'frame_1',
        validTime: '2026-08-08T04:00:00.000Z',
      }],
      timeRange: {
        start: '2026-08-08T03:00:00.000Z',
        end: '2026-08-08T04:00:00.000Z',
      },
    }
    expect(runStart.payload.safeParse({
      query: '解释地图截图',
      attachments: [{
        fileId: 'file_1',
        name: 'map.png',
        mediaType: 'image/png',
        kind: 'map_screenshot',
        mapContext,
      }],
    }).success).toBe(true)
    expect(runStart.payload.safeParse({
      query: '伪造地图截图',
      attachments: [{
        fileId: 'file_1',
        name: 'map.png',
        mediaType: 'image/png',
        kind: 'map_screenshot',
        mapContext: null,
      }],
    }).success).toBe(false)
    expect(runStart.payload.safeParse({
      query: '重复附件',
      attachments: [
        { fileId: 'file_1', name: 'a.png', mediaType: 'image/png', kind: 'image' },
        { fileId: 'file_1', name: 'a.png', mediaType: 'image/png', kind: 'image' },
      ],
    }).success).toBe(false)
    expect(runStart.payload.safeParse({
      query: '持续分析直到证据满足验收条件',
      goal: {
        condition: '风险分析结论有工具结果支撑。',
        acceptanceCriteria: ['完成空间分析', '提供可复核证据'],
        maxRechecks: 2,
        deadlineAt: '2099-08-08T12:00:00.000Z',
        maxTokenBudget: 20_000,
      },
    }).success).toBe(true)
    expect(runStart.payload.safeParse({
      query: '无界目标',
      goal: {
        condition: '永远继续',
        acceptanceCriteria: [],
        maxRechecks: 11,
        deadlineAt: null,
        maxTokenBudget: null,
      },
    }).success).toBe(false)

    const skillSearch = wsCommandContract('skill:search')
    expect(skillSearch.category).toBe('read')
    expect(skillSearch.csrf).toBe(false)
    expect(skillSearch.payload.safeParse({ query: '坐标系审计' }).success).toBe(true)
    expect(skillSearch.payload.safeParse({ query: '' }).success).toBe(false)

    const subAgentRead = wsCommandContract('subagent:get')
    expect(subAgentRead.category).toBe('read')
    expect(subAgentRead.csrf).toBe(false)
    expect(subAgentRead.payload.safeParse({ runId: 'run_1', agentId: 'analyst' }).success).toBe(true)
    expect(subAgentRead.payload.safeParse({ runId: 'run_1', agentId: 'analyst', extra: true }).success).toBe(false)

    const subAgentFollowUp = wsCommandContract('subagent:follow-up')
    expect(subAgentFollowUp.category).toBe('write')
    expect(subAgentFollowUp.csrf).toBe(true)
    expect(subAgentFollowUp.payload.safeParse({
      runId: 'run_1',
      agentId: 'analyst',
      followUpId: 'follow_up_1',
      content: '请补充数据来源。',
    }).success).toBe(true)
    expect(subAgentFollowUp.payload.safeParse({
      runId: 'run_1',
      agentId: 'analyst',
      followUpId: 'follow_up_1',
      content: '   ',
    }).success).toBe(false)

    const subAgentCancel = wsCommandContract('subagent:cancel')
    expect(subAgentCancel.category).toBe('write')
    expect(subAgentCancel.csrf).toBe(true)
    expect(subAgentCancel.payload.safeParse({
      runId: 'run_1',
      agentId: 'analyst',
      cancellationId: 'cancel_1',
      reason: '不再需要该分支。',
    }).success).toBe(true)

    const credentialStage = wsCommandContract('provider:credential:stage')
    expect(credentialStage.category).toBe('write')
    expect(credentialStage.csrf).toBe(true)
    expect(credentialStage.payload.safeParse({ secret: 'sk-transient' }).success).toBe(true)
    expect(credentialStage.response.safeParse({
      credentialHandle: 'provider_credential_1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }).success).toBe(true)
    expect(credentialStage.response.safeParse({
      credentialHandle: 'provider_credential_1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      secret: 'must-not-return',
    }).success).toBe(false)

    const modelDiscovery = wsCommandContract('provider:custom:discover-models')
    expect(modelDiscovery.category).toBe('write')
    expect(modelDiscovery.csrf).toBe(true)
    expect(modelDiscovery.payload.safeParse({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      credentialHandle: 'provider_credential_1',
    }).success).toBe(true)
    expect(modelDiscovery.response.safeParse({
      models: [{ modelId: 'model-1', ownedBy: 'openai' }],
      latencyMs: 25,
      testedAt: '2099-01-01T00:00:00.000Z',
    }).success).toBe(true)
    expect(modelDiscovery.response.safeParse({
      models: [{ modelId: 'model-1', ownedBy: null }],
      latencyMs: 25,
      testedAt: '2099-01-01T00:00:00.000Z',
      apiKey: 'must-not-return',
    }).success).toBe(false)

    const customProviderUpsert = wsCommandContract('provider:custom:upsert')
    expect(customProviderUpsert.category).toBe('write')
    expect(customProviderUpsert.csrf).toBe(true)
    expect(customProviderUpsert.payload.safeParse({
      config: {
        providerId: 'my-provider',
        displayName: 'My Provider',
        baseUrl: 'https://api.provider.com/v1',
        protocol: 'responses',
        models: [{
          modelId: 'model-1',
          contextWindowTokens: 128_000,
          capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
          modalities: ['text', 'image'],
        }],
        defaultModel: 'model-1',
        toolSchemaMode: 'compatible',
      },
      expectedRevision: null,
      credentialHandle: 'provider_credential_1',
    }).success).toBe(true)
    expect(customProviderUpsert.payload.safeParse({
      config: {
        providerId: 'my-provider',
        displayName: 'My Provider',
        baseUrl: 'https://api.provider.com/v1',
        protocol: 'responses',
        models: [{
          modelId: 'model-1',
          contextWindowTokens: 128_000,
          capabilities: { reasoning: false, structuredOutput: true, toolCalls: true },
          modalities: ['text'],
        }],
        defaultModel: 'model-1',
        toolSchemaMode: 'compatible',
      },
      expectedRevision: 1,
      clearApiKey: true,
    }).success).toBe(true)
    expect(customProviderUpsert.payload.safeParse({
      config: {
        providerId: 'lan-chat',
        displayName: 'LAN Chat',
        baseUrl: 'http://192.168.1.25:8000/v1',
        protocol: 'chat_completions',
        models: [{
          modelId: 'chat-only',
          contextWindowTokens: 128_000,
          capabilities: { reasoning: false, structuredOutput: false, toolCalls: false },
          modalities: ['text'],
        }],
        defaultModel: 'chat-only',
        toolSchemaMode: 'compatible',
      },
      expectedRevision: null,
    }).success).toBe(true)
    expect(customProviderUpsert.payload.safeParse({
      config: {
        providerId: 'my-provider',
        displayName: 'My Provider',
        baseUrl: 'https://api.provider.com/v1',
        protocol: 'responses',
        models: [{
          modelId: 'model-1',
          contextWindowTokens: 128_000,
          capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
          modalities: ['image'],
        }],
        defaultModel: 'missing-model',
        toolSchemaMode: 'compatible',
      },
      expectedRevision: null,
    }).success).toBe(false)

    const customProviderTest = wsCommandContract('provider:custom:test')
    expect(customProviderTest.category).toBe('write')
    expect(customProviderTest.csrf).toBe(true)
    expect(customProviderTest.payload.safeParse({
      config: {
        providerId: 'lan-chat',
        displayName: 'LAN Chat',
        baseUrl: 'http://192.168.1.25:8000/v1',
        protocol: 'chat_completions',
        models: [{
          modelId: 'chat-only',
          contextWindowTokens: 128_000,
          capabilities: { reasoning: false, structuredOutput: false, toolCalls: false },
          modalities: ['text'],
        }],
        defaultModel: 'chat-only',
        toolSchemaMode: 'compatible',
      },
      mode: 'model_call',
    }).success).toBe(true)

    const runtimeConfigUpdate = wsCommandContract('runtime-config:update')
    expect(runtimeConfigUpdate.payload.safeParse({
      config: agentRuntimeConfigSchema.parse({}),
      expectedRevision: 0,
    }).success).toBe(true)
    expect(runtimeConfigUpdate.payload.safeParse({
      config: agentRuntimeConfigSchema.parse({}),
    }).success).toBe(false)

    expect(agentStateSchema.parse({ sessionId: 'session_1', userQuery: '测试' }).runProfile)
      .toBe('standard')
  })

  it('rejects delivery values that are not real artifact references', () => {
    const delivery = {
      markdown: '分析完成。',
      summary: '已生成结果。',
      artifactIds: [],
      warnings: [],
    }
    expect(supervisorDeliverySchema.safeParse(delivery).success).toBe(true)
    expect(supervisorDeliverySchema.safeParse({
      ...delivery,
      artifactIds: ['valueRef_fake'],
    }).success).toBe(false)
  })

  it('keeps Skill trust registrations unique and routing thresholds ordered', () => {
    expect(agentRuntimeConfigSchema.safeParse({
      sdk: {
        skills: {
          registrations: [
            { skillId: 'crs-audit' },
            { skillId: 'crs-audit' },
          ],
        },
      },
    }).success).toBe(false)
    expect(agentRuntimeConfigSchema.safeParse({
      sdk: { skills: { candidateThreshold: 0.8, autoMatchThreshold: 0.7 } },
    }).success).toBe(false)
  })

  it('rejects system or inline credentials in MCP runtime configuration', () => {
    const server = {
      enabled: true,
      name: 'docs',
      transport: 'streamable_http',
      url: 'https://example.test/mcp',
    }
    const parseServer = (candidate: Record<string, unknown>) => agentRuntimeConfigSchema.safeParse({
      sdk: {
        mcp: {
          enabled: true,
          servers: [{ ...server, ...candidate }],
        },
      },
    })

    expect(parseServer({ authorizationEnv: 'OPENAI_API_KEY' }).success).toBe(false)
    expect(parseServer({ headers: { Authorization: 'Bearer inline-secret' } }).success).toBe(false)
    expect(parseServer({ headers: { 'x-api-key': 'inline-secret' } }).success).toBe(false)
    expect(parseServer({ headers: { 'x-custom': 'Bearer inline-secret' } }).success).toBe(false)
    expect(parseServer({ headers: { 'x-auth': 'inline-secret' } }).success).toBe(false)
    expect(parseServer({ env: { DEEPSEEK_API_KEY: 'inline-secret' } }).success).toBe(false)
    expect(parseServer({ args: ['--api-key=inline-secret'] }).success).toBe(false)
    expect(parseServer({ url: 'https://user:password@example.test/mcp' }).success).toBe(false)
    expect(parseServer({ url: 'https://example.test/mcp?token=inline-secret' }).success).toBe(false)
    expect(parseServer({
      headers: { 'x-api-version': '2026-08-31' },
      env: { NODE_ENV: 'production' },
    }).success).toBe(true)
  })

  it('keeps Plugin registration explicit and Hook configuration code-free', () => {
    const plugin = {
      pluginId: 'quality-pack',
      source: 'platform:quality-pack',
      contentDigest: `sha256:${'a'.repeat(64)}`,
    }
    expect(agentRuntimeConfigSchema.safeParse({
      sdk: { plugins: { enabled: true, registrations: [plugin, plugin] } },
    }).success).toBe(false)
    expect(agentRuntimeConfigSchema.safeParse({
      hookConfigs: [{
        hookId: 'audit-hook',
        eventType: 'PreToolUse',
        command: 'arbitrary-command',
      }],
    }).success).toBe(false)
    expect(agentRuntimeConfigSchema.safeParse({
      hookConfigs: [{ hookId: 'audit-hook', eventType: 'PreToolUse' }],
    }).success).toBe(true)
  })

  it('validates the Worker catalog envelope and schema hash at the Node boundary', () => {
    const catalog = {
      count: 1,
      tools: [{
        toolName: 'weather_check',
        route: '/tools/weather_check',
        schemaHash: `sha256:${'a'.repeat(64)}`,
        contract: {
          providerId: 'gis-meteorology',
          toolName: 'weather_check',
          version: '1',
          parametersSchema: { type: 'object' },
          resultSchema: { type: 'object' },
        },
      }],
    }
    expect(workerToolCatalogSchema.safeParse(catalog).success).toBe(true)
    expect(workerToolCatalogSchema.safeParse({
      ...catalog,
      tools: [{ ...catalog.tools[0], schemaHash: 'sha256:invalid' }],
    }).success).toBe(false)
  })
})

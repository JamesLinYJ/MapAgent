// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK checkpoint 防腐层契约测试
//
//   文件:       AgentsSdkCheckpointService.test.ts
//
//   日期:       2026年08月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Pro
// --------------------------------------------------------------------------

import {
  Agent,
  RunContext,
  Runner,
  type AgentInputItem,
  type Model,
  type ModelResponse,
  type ResponseStreamEvent,
} from '@openai/agents'
import { describe, expect, it } from 'vitest'
import { AGENT_STEP_CONTEXT_SCHEMA_VERSION } from '@geo-agent-platform/shared-types/agent-step-context'
import {
  CONTEXT_PROMPT_PROTOCOL_VERSION,
  CONTEXT_WINDOW_SCHEMA_VERSION,
  type ContextWindow,
} from '@geo-agent-platform/shared-types/context-window'
import {
  MODEL_REQUEST_RECORD_SCHEMA_VERSION,
  type ModelRequestRecord,
} from '@geo-agent-platform/shared-types/model-request'

import { SDK_STATE_SCHEMA_VERSION } from '../../agent/agentsRuntimeMetadata.js'
import { AgentsSdkBridge } from './AgentsSdkBridge.js'
import {
  AGENTS_SDK_CHECKPOINT_ENVELOPE_VERSION,
  AgentsSdkCheckpointCodec,
} from './AgentsSdkCheckpointCodec.js'
import {
  AgentsSdkCheckpointService,
  assertCheckpointCompatibility,
  type RestoreAgentsCheckpointOptions,
} from './AgentsSdkCheckpointService.js'
import type { AgentRuntimeStore } from '../../store/runtimePorts.js'
import type { RecordedAgentStepContext } from '../step/AgentStepContextFactory.js'
import { agentContextDigest } from '../step/agentContextDigest.js'

const validCheckpoint = {
  orchestrationEngine: 'openai_agents',
  sdkStateSchemaVersion: SDK_STATE_SCHEMA_VERSION,
  agentsSdkVersion: '0.17.0',
  runtimeConfigDigest: 'sha256:config',
}

describe('Agents SDK checkpoint anti-corruption boundary', () => {
  it('只解析平台 envelope，并把 SDK 序列化状态保持为 opaque 字符串', () => {
    const codec = new AgentsSdkCheckpointCodec()
    const envelope = {
      envelopeVersion: AGENTS_SDK_CHECKPOINT_ENVELOPE_VERSION,
      publicSerializedState: '{"sdk":"opaque"}',
      sdkVersion: '0.17.0',
      sdkStateSchemaVersion: SDK_STATE_SCHEMA_VERSION,
      agentStepContextSchemaVersion: AGENT_STEP_CONTEXT_SCHEMA_VERSION,
      modelRequestSchemaVersion: MODEL_REQUEST_RECORD_SCHEMA_VERSION,
      runtimeConfigDigest: 'sha256:config',
      toolPlanDigest: 'sha256:tools',
      worldRevision: 7,
      objectiveRevision: 4,
      inputCursor: 3,
      contextWindowId: 'context_window_1',
      contextDigest: 'sha256:context',
      modelRequestId: 'model_request_1',
      segmentId: 'segment_1',
      stepId: 'step_1',
    } as const

    expect(codec.decode(codec.encode(envelope))).toEqual(envelope)
    expect(() => codec.decode(JSON.stringify({
      ...envelope,
      sdkInternalField: [],
    }))).toThrow()
  })

  it('仅通过 RunState 公开 API 暂存输入并完成 round-trip', async () => {
    const bridge = new AgentsSdkBridge()
    const model: Model = {
      async getResponse(): Promise<ModelResponse> {
        throw new Error('checkpoint bridge test 不应调用非流式模型')
      },
      async *getStreamedResponse(): AsyncIterable<ResponseStreamEvent> {
        throw new Error('segment rotation 应在 provider 发包前发生')
      },
    }
    const agent = new Agent<{ runId: string }>({
      name: 'checkpoint-contract-agent',
      instructions: 'checkpoint contract test',
      model,
    })
    const context = { runId: 'run_1' }
    const rotation = new Error('controlled segment rotation')
    const stream = await new Runner().run(
      agent,
      'initial input',
      {
        stream: true,
        context: new RunContext(context),
        callModelInputFilter: async () => {
          throw rotation
        },
      },
    )
    await expect((async () => {
      for await (const _event of stream) {
        // 轮换信号在 provider 发包前触发，因此不会产生事件。
      }
      await stream.completed
    })()).rejects.toBe(rotation)
    const input = runInput('run_1', 1, '继续分析')

    bridge.stageInput(stream.state, [input])
    const restored = await bridge.restore({
      agent,
      context,
      publicSerializedState: bridge.serialize(stream.state),
    })

    expect(restored.pendingInput).toEqual([input])
  })

  it('接受完全匹配的 SDK 检查点', () => {
    expect(() => assertCheckpointCompatibility(validCheckpoint, {
      runId: 'run_1',
      sdkVersion: '0.17.0',
      configDigest: 'sha256:config',
    })).not.toThrow()
  })

  it.each([
    [{ ...validCheckpoint, orchestrationEngine: null }, '不是 OpenAI Agents SDK 检查点'],
    [{ ...validCheckpoint, sdkStateSchemaVersion: null }, 'SDK 状态 schema 不匹配'],
    [{ ...validCheckpoint, agentsSdkVersion: '0.15.0' }, 'SDK 版本不匹配'],
    [{ ...validCheckpoint, runtimeConfigDigest: 'sha256:other' }, '运行配置已变化'],
  ])('拒绝不兼容检查点', (checkpoint, message) => {
    expect(() => assertCheckpointCompatibility(checkpoint, {
      runId: 'run_1',
      sdkVersion: '0.17.0',
      configDigest: 'sha256:config',
    })).toThrow(message)
  })

  it.each([
    {
      name: 'envelope 版本',
      envelope: { envelopeVersion: 2 },
      expected: 'Invalid input',
    },
    {
      name: '模型请求 schema 版本',
      envelope: { modelRequestSchemaVersion: MODEL_REQUEST_RECORD_SCHEMA_VERSION + 1 },
      expected: '模型请求 schema 版本不匹配',
    },
    {
      name: '上下文窗口',
      envelope: { contextWindowId: 'context_window_tampered' },
      expected: '上下文窗口与活动窗口不一致',
    },
    {
      name: 'StepContext 版本',
      envelope: { agentStepContextSchemaVersion: AGENT_STEP_CONTEXT_SCHEMA_VERSION + 1 },
      expected: 'StepContext schema 版本不匹配',
    },
    {
      name: '工具计划',
      envelope: { toolPlanDigest: 'sha256:tampered-tools' },
      expected: 'StepContext 与 envelope 不一致',
    },
    {
      name: '世界版本',
      envelope: { worldRevision: 8 },
      expected: 'StepContext 与 envelope 不一致',
    },
    {
      name: '模型请求身份',
      envelope: { modelRequestId: 'model_request_missing' },
      expected: '缺少 checkpoint 模型请求',
    },
  ])('在调用 SDK restore 前拒绝被篡改的$name', async ({ envelope, expected }) => {
    await expect(restoreTamperedEnvelope(envelope)).rejects.toThrow(expected)
  })

  it.each([
    {
      name: '上下文窗口 schema',
      window: { schemaVersion: CONTEXT_WINDOW_SCHEMA_VERSION + 1 },
      expected: '上下文窗口 schema 版本不匹配',
    },
    {
      name: '提示协议',
      window: { promptProtocolVersion: `${CONTEXT_PROMPT_PROTOCOL_VERSION}-old` },
      expected: '上下文窗口提示协议版本不匹配',
    },
    {
      name: '已关闭窗口',
      window: { closedAt: '2026-08-31T00:01:00.000Z' },
      expected: '上下文窗口与活动窗口不一致',
    },
    {
      name: '来源摘要',
      window: { sourceDigest: 'sha256:tampered-window-source' },
      expected: '上下文窗口来源摘要校验失败',
    },
  ])('在调用 SDK restore 前拒绝不兼容的$name', async ({ window, expected }) => {
    await expect(restoreTamperedEnvelope({}, window)).rejects.toThrow(expected)
  })

  it('在调用 SDK restore 前拒绝模型请求行自身的 schema 版本漂移', async () => {
    await expect(restoreTamperedEnvelope({}, {}, {
      schemaVersion: MODEL_REQUEST_RECORD_SCHEMA_VERSION + 1,
    })).rejects.toThrow('模型请求与 StepContext 绑定不一致')
  })
})

const validEnvelope = {
  envelopeVersion: AGENTS_SDK_CHECKPOINT_ENVELOPE_VERSION,
  publicSerializedState: '{"sdk":"must-not-be-restored"}',
  sdkVersion: '0.17.0',
  sdkStateSchemaVersion: SDK_STATE_SCHEMA_VERSION,
  agentStepContextSchemaVersion: AGENT_STEP_CONTEXT_SCHEMA_VERSION,
  modelRequestSchemaVersion: MODEL_REQUEST_RECORD_SCHEMA_VERSION,
  runtimeConfigDigest: 'sha256:config',
  toolPlanDigest: 'sha256:tools',
  worldRevision: 7,
  objectiveRevision: 4,
  inputCursor: 3,
  contextWindowId: 'context_window_1',
  contextDigest: 'sha256:context',
  modelRequestId: 'model_request_1',
  segmentId: 'segment_1',
  stepId: 'step_1',
} as const

const validContextWindowSourceSummary = {
  turnId: 'turn_1',
  objectiveRevision: 4,
  inputCursor: 3,
  summaryObjectHashes: [],
}

const validContextWindow: ContextWindow = {
  schemaVersion: CONTEXT_WINDOW_SCHEMA_VERSION,
  contextWindowId: 'context_window_1',
  runId: 'run_1',
  generation: 1,
  promptProtocolVersion: CONTEXT_PROMPT_PROTOCOL_VERSION,
  sourceDigest: agentContextDigest(validContextWindowSourceSummary),
  sourceSummary: validContextWindowSourceSummary,
  compaction: null,
  startedAt: '2026-08-31T00:00:00.000Z',
  closedAt: null,
}

async function restoreTamperedEnvelope(
  overrides: Record<string, unknown>,
  contextWindowOverrides: Record<string, unknown> = {},
  modelRequestOverrides: Record<string, unknown> = {},
): Promise<unknown> {
  const stepContext = {
    schemaVersion: AGENT_STEP_CONTEXT_SCHEMA_VERSION,
    runId: 'run_1',
    turnId: 'turn_1',
    identity: {
      stepId: 'step_1',
      turnId: 'turn_1',
      segmentId: 'segment_1',
      modelRequestIndex: 1,
    },
    objectiveRevision: 4,
    inputCursor: 3,
    contextWindowId: 'context_window_1',
    contextDigest: 'sha256:context',
    toolPlanDigest: 'sha256:tools',
    worldRevision: 7,
  } as unknown as RecordedAgentStepContext
  const modelRequest = {
    schemaVersion: MODEL_REQUEST_RECORD_SCHEMA_VERSION,
    requestId: 'model_request_1',
    runId: 'run_1',
    turnId: 'turn_1',
    stepId: 'step_1',
    segmentId: 'segment_1',
    objectiveRevision: 4,
    inputCursor: 3,
    contextWindowId: 'context_window_1',
    contextDigest: 'sha256:context',
    agentStepContextSchemaVersion: AGENT_STEP_CONTEXT_SCHEMA_VERSION,
    provider: 'test',
    modelId: 'test-model',
    inputObjectHash: 'a'.repeat(64),
    inputDigest: `sha256:${'b'.repeat(64)}`,
    instructionsDigest: `sha256:${'c'.repeat(64)}`,
    toolPlanDigest: 'sha256:tools',
    worldRevision: 7,
    inputEntryIds: [],
    summaryObjectHashes: [],
    createdAt: '2026-08-31T00:00:00.000Z',
    ...modelRequestOverrides,
  } as ModelRequestRecord
  const store = {
    getRunCheckpoint: async () => ({
      ...validCheckpoint,
      checkpointInputCursor: 3,
    }),
    readAgentsSdkCheckpointEnvelope: async () => JSON.stringify({
      ...validEnvelope,
      ...overrides,
    }),
    listModelRequests: async () => [modelRequest],
  } as unknown as AgentRuntimeStore
  const options = {
    runId: 'run_1',
    agent: {},
    context: {},
    sdkVersion: '0.17.0',
    configDigest: 'sha256:config',
    resolveStepContext: async () => stepContext,
    resolveActiveContextWindow: async () => ({
      ...validContextWindow,
      ...contextWindowOverrides,
    }),
  } as unknown as RestoreAgentsCheckpointOptions
  return new AgentsSdkCheckpointService(store).restore(options)
}

function runInput(runId: string, inputSequence: number, content: string): AgentInputItem {
  return {
    type: 'message',
    role: 'user',
    content,
    providerData: {
      geoAgentRunInput: {
        runId,
        inputId: `input_${inputSequence}`,
        inputSequence,
      },
    },
  }
}

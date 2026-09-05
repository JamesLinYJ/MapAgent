// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 沙箱边界测试
//
//   文件:       runtimeSandbox.test.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  RunState,
  Runner,
  Usage,
  tool,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ResponseStreamEvent,
} from '@openai/agents'
import {
  SandboxAgent,
  shell,
  type SandboxClient,
} from '@openai/agents/sandbox'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createInstrumentedTestSandboxClient } from '../../test-support/agentsSandboxClient.js'
import {
  buildSandboxManifest,
  buildSandboxRunConfig,
  createConfiguredSandboxClient,
  isSandboxBackendAvailable,
} from './runtimeSandbox.js'

describe('runtimeSandbox', () => {
  it('passes a client and manifest to Runner without creating a session early', () => {
    const create = vi.fn()
    const client: SandboxClient = { backendId: 'unix_local', create }
    const manifest = buildSandboxManifest(
      { runId: 'run_1', sessionId: 'session_1' },
      'thread_1',
    )

    const runConfig = buildSandboxRunConfig(
      manifest,
      { backend: 'unix_local' },
      () => client,
    )

    expect(runConfig).toEqual({ client, manifest })
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects a client whose backend does not match the persisted runtime config', () => {
    const manifest = buildSandboxManifest(
      { runId: 'run_1', sessionId: 'session_1' },
      'thread_1',
    )

    expect(() => buildSandboxRunConfig(
      manifest,
      { backend: 'unix_local' },
      () => ({ backendId: 'other_native' }),
    )).toThrow("backend 'other_native' 与运行配置 'unix_local' 不匹配")
  })

  it('does not create a fake sandbox when the runtime explicitly disables it', () => {
    const manifest = buildSandboxManifest(
      { runId: 'run_disabled', sessionId: 'session_disabled' },
      'thread_disabled',
    )
    const factory = vi.fn()

    expect(() => buildSandboxRunConfig(
      manifest,
      { backend: 'disabled' },
      factory,
    )).toThrow('当前运行已禁用 SDK 沙箱')
    expect(factory).not.toHaveBeenCalled()
  })

  it('does not expose the unsupported Unix sandbox on Windows', () => {
    expect(isSandboxBackendAvailable({ backend: 'unix_local' }, 'win32')).toBe(false)
    expect(() => createConfiguredSandboxClient(
      { backend: 'unix_local' },
      {
        unixLocal: () => ({ backendId: 'unix_local' }),
        docker: () => ({ backendId: 'docker' }),
      },
      'win32',
    )).toThrow('Windows 不支持')
  })

  it('constructs the SDK Docker backend with networking disabled', () => {
    const docker = vi.fn((): SandboxClient => ({ backendId: 'docker' }))
    const client = createConfiguredSandboxClient(
      { backend: 'sdk_docker' },
      {
        unixLocal: () => ({ backendId: 'unix_local' }),
        docker,
      },
      'win32',
    )
    expect(client.backendId).toBe('docker')
    expect(docker).toHaveBeenCalledWith({ networkMode: 'none' })
    expect(isSandboxBackendAvailable({ backend: 'sdk_docker' }, 'win32')).toBe(true)

    const manifest = buildSandboxManifest(
      { runId: 'run_docker', sessionId: 'session_docker' },
      'thread_docker',
    )
    expect(buildSandboxRunConfig(
      manifest,
      { backend: 'sdk_docker' },
      () => client,
    )).toEqual({ client, manifest })
  })

  it('mounts authorized historical Artifacts at their canonical read-only paths', () => {
    const historicalSource = path.resolve('runtime', 'artifacts', 'run_previous', 'artifact_map.png')
    const manifest = buildSandboxManifest(
      { runId: 'run_current', sessionId: 'session_1' },
      'thread_1',
      [],
      {
        artifactDirectory: path.resolve('runtime', 'artifacts', 'run_current'),
        artifactMounts: [{
          artifactId: 'artifact_map',
          runId: 'run_previous',
          sourcePath: historicalSource,
          sandboxPath: 'artifacts/run_previous/artifact_map.png',
        }],
      },
    )

    const targets = manifest.mountTargets()
    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        logicalPath: 'artifacts/run_previous/artifact_map.png',
        entry: expect.objectContaining({
          source: historicalSource,
          readOnly: true,
        }),
      }),
    ]))
  })

  it('lets the SDK preserve, serialize, resume and finally clean an owned session', async () => {
    const { client, telemetry } = createInstrumentedTestSandboxClient('unix_local')
    const manifest = buildSandboxManifest(
      { runId: 'run_lifecycle', sessionId: 'session_lifecycle' },
      'thread_lifecycle',
    )
    let protectedExecutions = 0
    const protectedAction = tool({
      name: 'protected_action',
      description: '需要审批的测试动作',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => {
        protectedExecutions += 1
        return 'approved'
      },
    })
    const model = sandboxLifecycleModel()
    const agent = new SandboxAgent({
      name: 'sandbox-lifecycle-agent',
      instructions: '按测试脚本调用工具。',
      model,
      tools: [protectedAction],
      capabilities: [shell()],
      defaultManifest: manifest,
    })

    const interrupted = await new Runner({ model, tracingDisabled: true }).run(
      agent,
      '先执行沙箱命令，再申请审批。',
      { sandbox: { client, manifest } },
    )

    expect(interrupted.interruptions).toHaveLength(1)
    expect(telemetry.createCount).toBe(1)
    expect(telemetry.execCommands).toEqual(['echo lifecycle'])
    expect(protectedExecutions).toBe(0)
    const serialized = interrupted.state.toString()
    expect(JSON.parse(serialized)).toMatchObject({
      sandbox: { backendId: 'unix_local' },
    })

    const restored = await RunState.fromString(agent, serialized)
    const approval = restored.getInterruptions()[0]
    if (!approval) throw new Error('恢复后的 SDK RunState 缺少审批中断')
    restored.approve(approval)
    const completed = await new Runner({ model, tracingDisabled: true }).run(
      agent,
      restored,
      { sandbox: { client, manifest } },
    )

    expect(completed.interruptions).toHaveLength(0)
    expect(completed.finalOutput).toBe('生命周期完成')
    expect(protectedExecutions).toBe(1)
    expect(telemetry.resumeCount).toBe(1)
    expect(telemetry.serializeCount).toBeGreaterThanOrEqual(2)
  })

  it('lets the SDK reject a checkpoint owned by another sandbox backend', async () => {
    const firstNative = createInstrumentedTestSandboxClient('unix_local')
    const incompatibleNative = createInstrumentedTestSandboxClient('other_native')
    const manifest = buildSandboxManifest(
      { runId: 'run_backend_mismatch', sessionId: 'session_backend_mismatch' },
      'thread_backend_mismatch',
    )
    const approvalTool = tool({
      name: 'protected_action',
      description: '制造可序列化中断',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'approved',
    })
    const model = sandboxLifecycleModel()
    const agent = new SandboxAgent({
      name: 'sandbox-backend-check',
      instructions: '按测试脚本调用工具。',
      model,
      tools: [approvalTool],
      capabilities: [shell()],
      defaultManifest: manifest,
    })
    const interrupted = await new Runner({ model, tracingDisabled: true }).run(
      agent,
      '创建 Unix 本地 sandbox 检查点。',
      { sandbox: { client: firstNative.client, manifest } },
    )
    const restored = await RunState.fromString(agent, interrupted.state.toString())

    await expect(new Runner({ model, tracingDisabled: true }).run(
      agent,
      restored,
      { sandbox: { client: incompatibleNative.client, manifest } },
    )).rejects.toThrow(/backend/iu)
    expect(incompatibleNative.telemetry.resumeCount).toBe(0)
  })
})

function sandboxLifecycleModel(): Model {
  let turn = 0
  const output = (_request: ModelRequest): AgentOutputItem[] => {
    turn += 1
    if (turn === 1) {
      return [functionCall('call_shell', 'exec_command', {
        cmd: 'echo lifecycle',
      })]
    }
    if (turn === 2) {
      return [functionCall('call_approval', 'protected_action', {})]
    }
    return [{
      id: `message_${turn}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '生命周期完成' }],
    }]
  }

  return {
    async getResponse(request): Promise<ModelResponse> {
      return {
        usage: new Usage(),
        output: output(request),
        responseId: `response_${turn}`,
      }
    },
    async *getStreamedResponse(request): AsyncIterable<ResponseStreamEvent> {
      const responseOutput = output(request)
      yield { type: 'response_started' }
      yield {
        type: 'response_done',
        response: {
          id: `response_${turn}`,
          usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: responseOutput,
        },
      }
    },
  }
}

function functionCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): AgentOutputItem {
  return {
    id,
    type: 'function_call',
    status: 'completed',
    callId: id,
    name,
    arguments: JSON.stringify(args),
  }
}

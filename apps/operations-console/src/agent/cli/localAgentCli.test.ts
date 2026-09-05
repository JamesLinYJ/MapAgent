// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机 Agent 命令行契约测试
//
//   文件:       localAgentCli.test.ts
//
//   日期:       2026年07月27日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  analysisRunSchema,
  conversationItemSchema,
  type ModelProviderDescriptor,
  type RunStatus,
} from '@geo-agent-platform/shared-types'
import { describe, expect, it, vi } from 'vitest'

import type {
  LocalAgentSession,
  LocalAgentSessionSnapshot,
} from '../application/localAgentSession.js'
import {
  formatLocalAgentCliResult,
  parseLocalAgentCli,
  projectCliResult,
  runLocalAgentOneShot,
} from './localAgentCli.js'

describe('local Agent CLI contract', () => {
  it('parses interactive and one-shot options without consulting the host model', () => {
    expect(parseLocalAgentCli([
      '--prompt',
      '杭州明天会下雨吗？',
      '--provider',
      'deepseek',
      '--model',
      'deepseek-v4-flash',
      '--mode',
      'plan',
      '--no-reasoning',
      '--timeout',
      '30',
      '--json',
    ])).toEqual({
      check: false,
      help: false,
      json: true,
      prompt: '杭州明天会下雨吗？',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      executionMode: 'plan',
      reasoning: false,
      timeoutMs: 30_000,
    })
  })

  it('rejects ambiguous, unknown and unsafe timeout arguments', () => {
    expect(() => parseLocalAgentCli(['--prompt', '问题', '另一段']))
      .toThrow('不能同时使用')
    expect(() => parseLocalAgentCli(['--shell', 'pwsh']))
      .toThrow("未知参数 '--shell'")
    expect(() => parseLocalAgentCli(['--timeout', '1']))
      .toThrow('5–3600')
  })

  it('returns exit code 0 only for a completed canonical run', async () => {
    const completed = snapshot('completed', '杭州明天有阵雨。')
    const session = {
      submit: vi.fn().mockResolvedValue(completed.run),
      waitForActionOrCompletion: vi.fn().mockResolvedValue(completed),
    } as unknown as LocalAgentSession

    await expect(runLocalAgentOneShot(session, '杭州明天会下雨吗？', 5_000))
      .resolves.toMatchObject({
        exitCode: 0,
        result: {
          ok: true,
          status: 'completed',
          answer: '杭州明天有阵雨。',
        },
      })
    expect(session.submit).toHaveBeenCalledWith('杭州明天会下雨吗？')
  })

  it('uses exit code 2 for a decision and renders a human-readable prompt', async () => {
    const waiting = snapshot('clarification_needed', '')
    if (!waiting.run) throw new Error('测试运行缺失。')
    waiting.run.state.decisions = [{
      decisionId: 'decision_place',
      kind: 'clarification',
      title: '补充地点',
      question: '请问是哪个城市？',
      description: '',
      options: [{
        optionId: 'hangzhou',
        label: '杭州',
        description: '',
        kind: 'generic',
        reason: null,
        payload: {},
      }],
      allowFreeText: true,
      status: 'pending',
      payload: {},
      createdAt: '2026-07-27T00:00:00.000Z',
      resolvedAt: null,
    }]
    const session = {
      submit: vi.fn().mockResolvedValue(waiting.run),
      waitForActionOrCompletion: vi.fn().mockResolvedValue(waiting),
    } as unknown as LocalAgentSession

    const { result, exitCode } = await runLocalAgentOneShot(session, '明天会下雨吗？', 5_000)

    expect(exitCode).toBe(2)
    expect(formatLocalAgentCliResult(result, false)).toBe('请问是哪个城市？\n可选：杭州\n')
  })

  it('projects stable JSON without exposing tool arguments or raw outputs', () => {
    const value = snapshot('completed', '处理完成。')
    value.items.push(conversationItemSchema.parse({
      itemId: 'call_1',
      itemType: 'function_call',
      runId: 'run_1',
      threadId: 'thread_1',
      name: 'read_file',
      arguments: '{"path":".env","secret":"never-print"}',
      timestamp: '2026-07-27T00:00:01.000Z',
    }))
    value.items.push(conversationItemSchema.parse({
      itemId: 'output_1',
      itemType: 'function_call_output',
      runId: 'run_1',
      threadId: 'thread_1',
      output: 'API_KEY=never-print',
      timestamp: '2026-07-27T00:00:02.000Z',
    }))

    const output = formatLocalAgentCliResult(projectCliResult(value), true)

    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      answer: '处理完成。',
    })
    expect(output).not.toContain('never-print')
    expect(output).not.toContain('.env')
  })
})

function snapshot(
  status: RunStatus,
  answer: string,
): LocalAgentSessionSnapshot {
  const run = analysisRunSchema.parse({
    id: 'run_1',
    threadId: 'thread_1',
    sessionId: 'session_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'platform_local_agent',
    visibility: 'private',
    userQuery: '测试',
    modelProvider: 'deepseek',
    modelName: 'deepseek-v4-flash',
    status,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    state: {
      sessionId: 'session_1',
      threadId: 'thread_1',
      userQuery: '测试',
    },
  })
  const provider: ModelProviderDescriptor = {
    provider: 'deepseek',
    displayName: 'DeepSeek',
    configured: true,
    defaultModel: 'deepseek-v4-flash',
    availableModels: ['deepseek-v4-flash'],
    models: [{
      modelId: 'deepseek-v4-flash',
      contextWindowTokens: 1_000_000,
      capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
      modalities: ['text'],
    }],
    capabilities: ['agents_sdk_live_supervisor'],
    agentRuntime: {
      transport: 'deepseek_responses',
      structuredOutput: 'json_schema',
      functionTools: true,
      deferredTools: false,
      toolNamespaces: false,
      localMcp: true,
      hostedTools: false,
      handoffs: true,
      multiToolResponse: true,
      providerParallelToolControl: false,
      remoteConversation: false,
      serverCompaction: false,
    },
    contextWindowTokens: 1_000_000,
  }
  return {
    connection: 'online',
    connectionMessage: '已连接',
    bootstrap: null,
    provider,
    model: 'deepseek-v4-flash',
    executionMode: 'auto',
    reasoning: true,
    threadId: 'thread_1',
    run,
    items: answer
      ? [conversationItemSchema.parse({
          itemId: 'answer_1',
          itemType: 'message',
          runId: 'run_1',
          threadId: 'thread_1',
          role: 'assistant',
          body: answer,
          status: 'completed',
          timestamp: '2026-07-27T00:00:03.000Z',
        })]
      : [],
    events: [],
    error: null,
  }
}

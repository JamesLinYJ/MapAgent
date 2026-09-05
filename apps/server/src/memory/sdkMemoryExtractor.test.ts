// +-------------------------------------------------------------------------
//
//   地理智能平台 - SDK 专用记忆提取器测试
//
//   文件:       sdkMemoryExtractor.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  Usage,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ResponseStreamEvent,
} from '@openai/agents'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultRuntimeConfig } from '../agent/defaultRuntimeConfig.js'
import type { ModelAdapter } from '../model/registry.js'
import { createMemoryRuntime, readMemory, writeMemory } from './service.js'
import {
  createSdkMemoryDreamer,
  createSdkMemoryExtractor,
} from './sdkMemoryExtractor.js'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('createSdkMemoryExtractor', () => {
  it('只向 SDK 暴露四个记忆工具并执行真实读写', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'platform-sdk-memory-'))
    tempRoots.push(root)
    const runtime = createMemoryRuntime(path.join(root, 'runtime'), {
      ...defaultRuntimeConfig().context,
      memoryBaseDir: root,
      privateMemoryDir: path.join(root, 'private'),
      teamMemoryDir: path.join(root, 'team'),
    }, root)
    const existing = await writeMemory(runtime, {
      scope: 'private',
      type: 'feedback',
      name: '修复原则',
      description: '用户要求根因修复',
      content: '不要用临时补丁掩盖问题。',
      relativePath: 'feedback/root-cause.md',
    })
    const requestSpy = vi.fn()
    const extractor = createSdkMemoryExtractor(
      adapterWithModel(memoryToolModel(existing.relativePath, requestSpy)),
      'deepseek-v4-flash',
    )

    const written = await extractor(runtime, {
      existing: [existing],
      entries: [{
        entryId: 'entry_1',
        threadId: 'thread_1',
        runId: 'run_1',
        turnId: null,
        sequence: 1,
        kind: 'message',
        payload: { role: 'user', content: '请记住以后都要从根因修复。' },
        createdAt: '2026-07-31T00:00:00.000Z',
      }],
    })

    expect(written).toHaveLength(1)
    expect((await readMemory(runtime, 'private', existing.relativePath)).content).toContain('根因修复')
    const firstRequest = requestSpy.mock.calls[0]?.[0] as ModelRequest | undefined
    expect(firstRequest?.tools.map(tool => tool.name).sort()).toEqual([
      'forget_memory',
      'read_memory',
      'search_memory',
      'write_memory',
    ])
    expect(JSON.stringify(firstRequest?.tools)).not.toContain('export_map')
    expect(JSON.stringify(firstRequest?.tools)).not.toContain('shell')
  })

  it('记忆整理通过真实写入和遗忘工具完成，不返回 upserts/deletes JSON', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'platform-sdk-memory-dream-'))
    tempRoots.push(root)
    const runtime = createMemoryRuntime(path.join(root, 'runtime'), {
      ...defaultRuntimeConfig().context,
      memoryBaseDir: root,
      privateMemoryDir: path.join(root, 'private'),
      teamMemoryDir: path.join(root, 'team'),
    }, root)
    const primary = await writeMemory(runtime, {
      scope: 'private',
      type: 'feedback',
      name: '修复原则',
      description: '用户要求根因修复',
      content: '不要使用临时补丁。',
      relativePath: 'feedback/root-cause.md',
    })
    const duplicate = await writeMemory(runtime, {
      scope: 'private',
      type: 'feedback',
      name: '重复修复原则',
      description: '与修复原则重复',
      content: '不要 hack。',
      relativePath: 'feedback/root-cause-copy.md',
    })
    const requestSpy = vi.fn()
    const dreamer = createSdkMemoryDreamer(
      adapterWithModel(memoryDreamModel(primary.relativePath, duplicate.relativePath, requestSpy)),
      'deepseek-v4-flash',
    )

    const result = await dreamer(runtime, [
      await readMemory(runtime, 'private', primary.relativePath),
      await readMemory(runtime, 'private', duplicate.relativePath),
    ])

    expect(result.changed).toBe(true)
    expect(result.summary).toBe('已合并重复记忆')
    expect((await readMemory(runtime, 'private', primary.relativePath)).content).toContain('根因修复')
    await expect(readMemory(runtime, 'private', duplicate.relativePath)).rejects.toThrow()
    const firstRequest = requestSpy.mock.calls[0]?.[0] as ModelRequest | undefined
    expect(firstRequest?.tools.map(tool => tool.name).sort()).toEqual([
      'forget_memory',
      'write_memory',
    ])
    expect(JSON.stringify(firstRequest?.outputType)).not.toContain('upserts')
    expect(JSON.stringify(firstRequest?.outputType)).not.toContain('deletes')
  })
})

function memoryToolModel(relativePath: string, requestSpy: (request: ModelRequest) => void): Model {
  let turn = 0
  return {
    async getResponse(request): Promise<ModelResponse> {
      requestSpy(request)
      turn += 1
      const output = turn === 1
        ? [functionCall('call_read', 'read_memory', {
          scope: 'private',
          relativePath,
        })]
        : turn === 2
          ? [functionCall('call_write', 'write_memory', {
            scope: 'private',
            type: 'feedback',
            name: '修复原则',
            description: '用户要求所有修改都从根因修复',
            content: '所有修改必须从根因修复，不使用临时补丁或虚假 fallback。',
            relativePath,
          })]
          : [message('记忆提取完成')]
      return {
        usage: new Usage({ requests: 1, inputTokens: 5, outputTokens: 3, totalTokens: 8 }),
        output,
        responseId: `response_${turn}`,
      }
    },
    async *getStreamedResponse(): AsyncIterable<ResponseStreamEvent> {
      throw new Error('记忆提取器不应进入流式路径')
    },
  }
}

function memoryDreamModel(
  primaryPath: string,
  duplicatePath: string,
  requestSpy: (request: ModelRequest) => void,
): Model {
  let turn = 0
  return {
    async getResponse(request): Promise<ModelResponse> {
      requestSpy(request)
      turn += 1
      const output = turn === 1
        ? [functionCall('call_write_primary', 'write_memory', {
          scope: 'private',
          type: 'feedback',
          name: '修复原则',
          description: '用户要求所有修改都从根因修复',
          content: '所有修改必须从根因修复，不使用临时补丁或 hack。',
          relativePath: primaryPath,
        })]
        : turn === 2
          ? [functionCall('call_forget_duplicate', 'forget_memory', {
            scope: 'private',
            relativePath: duplicatePath,
            reason: '已合并进主记忆',
          })]
          : [message('已合并重复记忆')]
      return {
        usage: new Usage({ requests: 1, inputTokens: 5, outputTokens: 3, totalTokens: 8 }),
        output,
        responseId: `response_dream_${turn}`,
      }
    },
    async *getStreamedResponse(): AsyncIterable<ResponseStreamEvent> {
      throw new Error('记忆整理器不应进入流式路径')
    },
  }
}

function functionCall(id: string, name: string, args: Record<string, unknown>): AgentOutputItem {
  return {
    id,
    type: 'function_call',
    status: 'completed',
    callId: id,
    name,
    arguments: JSON.stringify(args),
  }
}

function message(text: string): AgentOutputItem {
  return {
    id: 'message_memory',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  }
}

function adapterWithModel(model: Model): ModelAdapter {
  return {
    provider: 'deepseek',
    displayName: 'DeepSeek',
    defaultModel: 'deepseek-v4-flash',
    agentToolSchemaMode: 'strict',
    agentRuntimeCapabilities: {
      transport: 'deepseek_responses',
      structuredOutput: 'json_schema',
      functionTools: true,
      localMcp: true,
      hostedTools: true,
      handoffs: true,
      multiToolResponse: true,
      providerParallelToolControl: false,
      remoteConversation: false,
      serverCompaction: false,
    },
    isConfigured: () => true,
    capabilities: () => ['tool_calls'],
    createAgentModel: () => model,
    chat: async () => {
      throw new Error('不应调用自由文本 chat')
    },
  }
}

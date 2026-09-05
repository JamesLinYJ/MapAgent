// +-------------------------------------------------------------------------
//
//   地理智能平台 - 纯辅助模型结果缓存测试
//
//   文件:       modelResultCache.test.ts
//
//   日期:       2026年07月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ModelAdapter, ModelAdapterRegistry } from './registry.js'
import {
  ModelCompletionService,
  type ModelResultCacheEntry,
  type ModelResultCachePort,
} from './modelResultCache.js'

describe('ModelCompletionService', () => {
  it('复用同工作区、同模型和同提示词的纯辅助结果', async () => {
    const { service, chat } = fixture()
    const request = {
      workspaceId: 'workspace_1',
      provider: 'deepseek',
      model: 'deepseek-chat',
      purpose: 'thread_summary' as const,
      prompt: '总结这段文本',
    }

    const first = await service.completeText(request)
    const second = await service.completeText(request)

    expect(first.resultCache).toBe('miss')
    expect(second.resultCache).toBe('hit')
    expect(second.content).toBe('稳定结果')
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('按工作区隔离缓存并允许显式 bypass', async () => {
    const { service, chat } = fixture()
    const base = {
      provider: 'deepseek',
      purpose: 'memory_selection' as const,
      prompt: '选择记忆',
    }
    await service.completeText({ ...base, workspaceId: 'workspace_1' })
    await service.completeText({ ...base, workspaceId: 'workspace_2' })
    const bypass = await service.completeText({ ...base, workspaceId: 'workspace_1', cacheMode: 'bypass' })

    expect(bypass.resultCache).toBe('bypass')
    expect(chat).toHaveBeenCalledTimes(3)
  })

  it('provider 不支持 SDK 原生结构化输出时明确失败且不解析自由文本', async () => {
    const { service, cache, chat } = fixture('{"value":"不应解析"}')
    await expect(service.completeStructured({
      workspaceId: 'workspace_1',
      provider: 'deepseek',
      purpose: 'tool_structured_analysis',
      prompt: '返回对象',
    }, z.object({ value: z.string() }))).rejects.toThrow(/不支持 SDK 原生 JSON Schema/u)

    expect(cache.entries.size).toBe(0)
    expect(chat).not.toHaveBeenCalled()
  })

  it('合并同进程并发的相同请求', async () => {
    const { service, chat } = fixture('稳定结果', 10)
    const request = {
      workspaceId: 'workspace_1',
      provider: 'deepseek',
      purpose: 'thread_summary' as const,
      prompt: '并发摘要',
    }
    await Promise.all([service.completeText(request), service.completeText(request)])
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('在 24 小时后重新请求上游并清理过期项', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'))
      const { service, chat } = fixture()
      const request = {
        workspaceId: 'workspace_1',
        provider: 'deepseek',
        purpose: 'thread_summary' as const,
        prompt: '有时效的摘要输入',
      }
      await service.completeText(request)
      vi.advanceTimersByTime(86_400_001)
      await service.completeText(request)
      expect(chat).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

function fixture(content = '稳定结果', delayMs = 0) {
  const chat = vi.fn(async () => {
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
    return {
      provider: 'deepseek',
      model: 'deepseek-chat',
      content,
      raw: {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          prompt_cache_hit_tokens: 6,
          prompt_cache_miss_tokens: 4,
        },
      },
    }
  })
  const adapter: ModelAdapter = {
    provider: 'deepseek',
    displayName: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    agentToolSchemaMode: 'compatible',
    agentRuntimeCapabilities: {
      structuredOutput: 'json_object',
      functionTools: true,
      localMcp: true,
      hostedTools: false,
      handoffs: true,
      remoteConversation: false,
      serverCompaction: false,
    },
    cacheNamespace: 'https://api.deepseek.com',
    isConfigured: () => true,
    capabilities: () => ['chat'],
    chat,
  }
  const registry = {
    resolveProvider: () => adapter,
  } as unknown as ModelAdapterRegistry
  const cache = new MemoryCache()
  const service = new ModelCompletionService(registry, cache, {
    enabled: true,
    ttlSeconds: 86_400,
    maxBytes: 256 * 1024,
  })
  return { service, cache, chat }
}

class MemoryCache implements ModelResultCachePort {
  readonly entries = new Map<string, ModelResultCacheEntry & { expiresAt: Date }>()

  async get(workspaceId: string, cacheKey: string): Promise<ModelResultCacheEntry | null> {
    const entry = this.entries.get(`${workspaceId}:${cacheKey}`)
    return entry && entry.expiresAt.getTime() > Date.now() ? entry : null
  }

  async put(input: Parameters<ModelResultCachePort['put']>[0]): Promise<void> {
    this.entries.set(`${input.workspaceId}:${input.cacheKey}`, {
      content: input.content,
      usage: input.usage,
      expiresAt: input.expiresAt,
    })
  }

  async deleteExpired(_limit = 100, now = new Date()): Promise<number> {
    let deleted = 0
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt.getTime() >= now.getTime()) continue
      this.entries.delete(key)
      deleted += 1
    }
    return deleted
  }
}

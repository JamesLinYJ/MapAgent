// +-------------------------------------------------------------------------
//
//   地理智能平台 - 纯辅助模型结果缓存
//
//   文件:       modelResultCache.ts
//
//   日期:       2026年07月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { and,eq,gt,inArray,lt,sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Database } from '../db/connection.js'
import { platformModelResultCache } from '../db/schema.js'
import type { AgentState } from '../schemas/types.js'
import type { ModelAdapterRegistry } from './registry.js'
import { runSdkStructuredOutput,type StructuredOutputSchema } from './sdkStructuredOutput.js'
import {
normalizedUsageFromProviderResponse,
normalizeStoredModelUsage,
type NormalizedModelUsage,
} from './modelUsage.js'

const MODEL_COMPLETION_PURPOSES = [
  'thread_summary',
  'memory_selection',
  'memory_dream',
  'tool_structured_analysis',
  'goal_judgement',
] as const

export type ModelCompletionPurpose = typeof MODEL_COMPLETION_PURPOSES[number]
type ModelResultCacheMode = 'read_write' | 'bypass'

export interface ModelCompletionRequest {
  workspaceId: string
  runId?: string | null
  provider?: string | null
  model?: string | null
  purpose: ModelCompletionPurpose
  prompt: string
  output: 'text' | 'structured'
  cacheMode?: ModelResultCacheMode
  schemaVersion?: string
  schemaFingerprint?: string
  signal?: AbortSignal
}

export interface ModelCompletionResult<T> {
  content: T
  usage: NormalizedModelUsage
  resultCache: 'hit' | 'miss' | 'bypass'
}

export interface ModelResultCacheEntry {
  content: string
  usage: NormalizedModelUsage
}

export interface ModelResultCachePort {
  get(workspaceId: string, cacheKey: string, now?: Date): Promise<ModelResultCacheEntry | null>
  put(input: {
    cacheKey: string
    workspaceId: string
    provider: string
    model: string
    purpose: ModelCompletionPurpose
    content: string
    usage: NormalizedModelUsage
    expiresAt: Date
  }): Promise<void>
  deleteExpired?(limit?: number, now?: Date): Promise<number>
}

export class ModelResultCacheStore {
  constructor(private readonly db: Database) {}

  async get(workspaceId: string, cacheKey: string, now = new Date()): Promise<ModelResultCacheEntry | null> {
    const rows = await this.db.select({
      content: platformModelResultCache.content,
      usageJson: platformModelResultCache.usageJson,
    }).from(platformModelResultCache).where(and(
      eq(platformModelResultCache.workspaceId, workspaceId),
      eq(platformModelResultCache.cacheKey, cacheKey),
      gt(platformModelResultCache.expiresAt, now),
    )).limit(1)
    const row = rows[0]
    if (!row) return null
    await this.db.update(platformModelResultCache).set({
      lastAccessedAt: now,
      hitCount: sql`${platformModelResultCache.hitCount} + 1`,
    }).where(eq(platformModelResultCache.cacheKey, cacheKey))
    return { content: row.content, usage: normalizeStoredModelUsage(row.usageJson) }
  }

  async put(input: {
    cacheKey: string
    workspaceId: string
    provider: string
    model: string
    purpose: ModelCompletionPurpose
    content: string
    usage: NormalizedModelUsage
    expiresAt: Date
  }): Promise<void> {
    await this.db.insert(platformModelResultCache).values({
      cacheKey: input.cacheKey,
      workspaceId: input.workspaceId,
      provider: input.provider,
      model: input.model,
      purpose: input.purpose,
      content: input.content,
      expiresAt: input.expiresAt,
      usageJson: { ...input.usage },
      lastAccessedAt: new Date(),
    }).onConflictDoUpdate({
      target: platformModelResultCache.cacheKey,
      set: {
        content: input.content,
        usageJson: { ...input.usage },
        expiresAt: input.expiresAt,
        lastAccessedAt: new Date(),
        hitCount: 0,
      },
    })
  }

  async deleteExpired(limit = 500, now = new Date()): Promise<number> {
    const expired = await this.db.select({ cacheKey: platformModelResultCache.cacheKey })
      .from(platformModelResultCache)
      .where(lt(platformModelResultCache.expiresAt, now))
      .limit(limit)
    if (!expired.length) return 0
    const keys = expired.map(row => row.cacheKey)
    await this.db.delete(platformModelResultCache).where(inArray(platformModelResultCache.cacheKey, keys))
    return keys.length
  }
}

export interface ModelCompletionCacheConfig {
  enabled: boolean
  ttlSeconds: number
  maxBytes: number
}

export class ModelCompletionService {
  private readonly inFlight = new Map<string, Promise<ModelCompletionResult<string | Record<string, unknown>>>>()

  constructor(
    private readonly registry: ModelAdapterRegistry,
    private readonly store: ModelResultCachePort | null,
    private readonly config: ModelCompletionCacheConfig,
  ) {}

  async completeText(request: Omit<ModelCompletionRequest, 'output'>): Promise<ModelCompletionResult<string>> {
    return this.complete({ ...request, output: 'text' }) as Promise<ModelCompletionResult<string>>
  }

  async completeStructured<TSchema extends StructuredOutputSchema>(
    request: Omit<ModelCompletionRequest, 'output' | 'schemaFingerprint'>,
    schema: TSchema,
  ): Promise<ModelCompletionResult<z.infer<TSchema>>> {
    const schemaFingerprint = createHash('sha256')
      .update(JSON.stringify(z.toJSONSchema(schema)))
      .digest('hex')
    return this.complete(
      { ...request, output: 'structured', schemaFingerprint },
      schema,
    ) as Promise<ModelCompletionResult<z.infer<TSchema>>>
  }

  private async complete(
    request: ModelCompletionRequest,
    schema?: StructuredOutputSchema,
  ): Promise<ModelCompletionResult<string | Record<string, unknown>>> {
    if (!request.workspaceId.trim()) throw new Error('模型辅助请求缺少 workspaceId')
    if (!request.prompt.trim()) throw new Error('模型辅助请求提示词不能为空')
    const adapter = this.registry.resolveProvider(request.provider)
    const model = request.model ?? adapter.defaultModel
    if (!model) throw new Error(`模型 provider '${adapter.provider}' 未配置模型名称`)
    const eligible = this.config.enabled
      && Boolean(this.store)
      && adapter.provider === 'deepseek'
      && request.cacheMode !== 'bypass'
    const cacheKey = modelCacheKey({
      ...request,
      provider: adapter.provider,
      model,
      cacheNamespace: adapter.cacheNamespace ?? adapter.provider,
    })
    if (!eligible) return this.callProvider(adapter, model, request, 'bypass', schema)

    const cached = await this.store!.get(request.workspaceId, cacheKey)
    if (cached) return this.parseCached(cached, request.output, schema)

    const existing = this.inFlight.get(cacheKey)
    if (existing) return existing
    const pending = this.callAndCache(adapter, model, request, cacheKey, schema)
    this.inFlight.set(cacheKey, pending)
    try {
      return await pending
    } finally {
      this.inFlight.delete(cacheKey)
    }
  }

  private async callAndCache(
    adapter: ReturnType<ModelAdapterRegistry['resolveProvider']>,
    model: string,
    request: ModelCompletionRequest,
    cacheKey: string,
    schema?: StructuredOutputSchema,
  ): Promise<ModelCompletionResult<string | Record<string, unknown>>> {
    const result = await this.callProvider(adapter, model, request, 'miss', schema)
    const serialized = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
    if (Buffer.byteLength(serialized, 'utf8') <= this.config.maxBytes) {
      await this.store!.put({
        cacheKey,
        workspaceId: request.workspaceId,
        provider: adapter.provider,
        model,
        purpose: request.purpose,
        content: serialized,
        usage: result.usage,
        expiresAt: new Date(Date.now() + this.config.ttlSeconds * 1000),
      })
      await this.store!.deleteExpired?.(100)
    }
    return result
  }

  private async callProvider(
    adapter: ReturnType<ModelAdapterRegistry['resolveProvider']>,
    model: string,
    request: ModelCompletionRequest,
    resultCache: 'miss' | 'bypass',
    schema?: StructuredOutputSchema,
  ): Promise<ModelCompletionResult<string | Record<string, unknown>>> {
    if (request.output === 'structured') {
      if (!schema) throw new Error('结构化模型请求缺少输出 schema')
      const result = await runSdkStructuredOutput(adapter, model, request.prompt, schema, request.signal)
      return { ...result, resultCache }
    }
    const response = await adapter.chat(request.prompt, {
      model,
      reasoning: false,
      temperature: 0,
      ...(request.signal ? { signal: request.signal } : {}),
    })
    const raw = response.content
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('辅助模型未返回文本')
    return { content: raw.trim(), usage: normalizedUsageFromProviderResponse(response), resultCache }
  }

  private parseCached(
    entry: ModelResultCacheEntry,
    output: ModelCompletionRequest['output'],
    schema?: StructuredOutputSchema,
  ): ModelCompletionResult<string | Record<string, unknown>> {
    if (output === 'structured') {
      if (!schema) throw new Error('结构化模型缓存读取缺少输出 schema')
      const parsed: unknown = JSON.parse(entry.content)
      return {
        content: schema.parse(parsed),
        usage: entry.usage,
        resultCache: 'hit',
      }
    }
    return {
      content: entry.content,
      usage: entry.usage,
      resultCache: 'hit',
    }
  }
}

export async function recordModelCompletionUsage(
  store: { mutateRunState(runId: string, mutation: (state: AgentState) => Partial<AgentState>): Promise<unknown> },
  runId: string,
  result: ModelCompletionResult<string | Record<string, unknown>>,
): Promise<void> {
  await store.mutateRunState(runId, state => {
    const current = state.runtimeStats
    if (result.resultCache === 'hit') {
      return { runtimeStats: {
        ...current,
        modelResultCacheHitCount: count(current.modelResultCacheHitCount) + 1,
        modelResultCacheAvoidedRequestCount: count(current.modelResultCacheAvoidedRequestCount) + 1,
        modelResultCacheEstimatedSavedTokens: count(current.modelResultCacheEstimatedSavedTokens) + result.usage.totalTokens,
      } }
    }
    return { runtimeStats: {
      ...current,
      modelInputTokens: count(current.modelInputTokens) + result.usage.inputTokens,
      modelOutputTokens: count(current.modelOutputTokens) + result.usage.outputTokens,
      modelTotalTokens: count(current.modelTotalTokens) + result.usage.totalTokens,
      modelCacheHitInputTokens: count(current.modelCacheHitInputTokens) + result.usage.cacheHitInputTokens,
      modelCacheMeasuredInputTokens: count(current.modelCacheMeasuredInputTokens) + count(result.usage.cacheMeasuredInputTokens),
      modelUsageResponseCount: count(current.modelUsageResponseCount) + (hasProviderUsage(result.usage) ? 1 : 0),
      modelResultCacheMissCount: count(current.modelResultCacheMissCount) + (result.resultCache === 'miss' ? 1 : 0),
      modelResultCacheBypassCount: count(current.modelResultCacheBypassCount) + (result.resultCache === 'bypass' ? 1 : 0),
    } }
  })
}

function modelCacheKey(input: ModelCompletionRequest & { provider: string; model: string; cacheNamespace: string }): string {
  const stable = JSON.stringify({
    version: 1,
    workspaceId: input.workspaceId,
    provider: input.provider,
    cacheNamespace: input.cacheNamespace,
    model: input.model,
    purpose: input.purpose,
    output: input.output,
    schemaVersion: input.schemaVersion ?? '1',
    schemaFingerprint: input.schemaFingerprint ?? null,
    prompt: input.prompt,
    reasoning: false,
    temperature: 0,
  })
  return createHash('sha256').update(stable).digest('hex')
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

function hasProviderUsage(usage: NormalizedModelUsage): boolean {
  return usage.inputTokens > 0
    || usage.outputTokens > 0
    || usage.totalTokens > 0
    || usage.cacheDetailReported > 0
}

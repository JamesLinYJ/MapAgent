// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型词元用量归一化
//
//   文件:       modelUsage.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
//
//   维护记录 (2026-08-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 从 Agent 层迁入模型边界，统一普通、结构化与辅助调用的缓存计量口径。
//
//   维护记录 (2026-08-30):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 以供应商原始 usage 判定零值来源，并归并跨容器同义缓存字段。
// --------------------------------------------------------------------------

interface ModelUsageLike {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  inputTokensDetails?: Record<string, number> | Array<Record<string, number>> | null
}

export interface ModelUsageResponseLike {
  usage: ModelUsageLike
  /**
   * 供应商响应中未经 SDK 补默认值的 usage 快照。只有这个边界能区分
   * “供应商明确返回 0”与 Chat Completions SDK 合成的 cached_tokens: 0。
   */
  rawUsage?: Record<string, unknown>
}

export interface AggregatedModelUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheHitInputTokens: number
  cacheMissInputTokens: number
  cacheMeasuredInputTokens: number
  cacheDetailReportedCount: number
  responseCount: number
}

export interface NormalizedModelUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheHitInputTokens: number
  cacheMissInputTokens: number
  cacheMeasuredInputTokens: number
  cacheDetailReported: number
}

const CACHE_HIT_DETAIL_KEYS = new Set([
  'cached_tokens',
  'cachedTokens',
  'cache_read_input_tokens',
  'cacheReadInputTokens',
  'cache_read_tokens',
  'cacheReadTokens',
  'prompt_cache_hit_tokens',
])

const CACHE_MISS_DETAIL_KEYS = new Set([
  'prompt_cache_miss_tokens',
  'cache_miss_input_tokens',
  'cacheMissInputTokens',
])

export function aggregateModelUsage(responses: ModelUsageResponseLike[]): AggregatedModelUsage {
  return responses.reduce<AggregatedModelUsage>((total, response) => {
    const inputTokens = finiteTokenCount(response.usage.inputTokens)
    const outputTokens = finiteTokenCount(response.usage.outputTokens)
    const totalTokens = finiteTokenCount(response.usage.totalTokens)
    const cacheDetails = isRecord(response.rawUsage)
      ? cacheDetailsFromProviderUsage(response.rawUsage)
      : cacheDetailsFromSdkUsage(response.usage.inputTokensDetails)
    const { cacheHit, cacheMiss } = cacheDetails
    const cacheDetailReported = cacheHit.reported || cacheMiss.reported
    const providerUsageReported = inputTokens > 0 || outputTokens > 0 || totalTokens > 0 || cacheDetailReported
    const normalizedCacheHit = cacheHit.reported
      ? Math.min(cacheHit.value, inputTokens)
      : cacheMiss.reported
        ? Math.max(0, inputTokens - Math.min(cacheMiss.value, inputTokens))
        : 0
    const normalizedCacheMiss = cacheMiss.reported
      ? Math.min(cacheMiss.value, inputTokens)
      : cacheHit.reported
        ? Math.max(0, inputTokens - normalizedCacheHit)
        : 0
    return {
      inputTokens: total.inputTokens + inputTokens,
      outputTokens: total.outputTokens + outputTokens,
      totalTokens: total.totalTokens + totalTokens,
      cacheHitInputTokens: total.cacheHitInputTokens + normalizedCacheHit,
      cacheMissInputTokens: total.cacheMissInputTokens + normalizedCacheMiss,
      cacheMeasuredInputTokens: total.cacheMeasuredInputTokens + (cacheDetailReported ? inputTokens : 0),
      cacheDetailReportedCount: total.cacheDetailReportedCount + (cacheDetailReported ? 1 : 0),
      responseCount: total.responseCount + (providerUsageReported ? 1 : 0),
    }
  }, emptyAggregatedUsage())
}

export function mergeModelUsageStats(
  current: Record<string, number>,
  usage: AggregatedModelUsage,
): Record<string, number> {
  return {
    ...current,
    modelInputTokens: finiteTokenCount(current.modelInputTokens) + usage.inputTokens,
    modelOutputTokens: finiteTokenCount(current.modelOutputTokens) + usage.outputTokens,
    modelCacheHitInputTokens: finiteTokenCount(current.modelCacheHitInputTokens) + usage.cacheHitInputTokens,
    modelCacheMeasuredInputTokens: finiteTokenCount(current.modelCacheMeasuredInputTokens) + usage.cacheMeasuredInputTokens,
    modelTotalTokens: finiteTokenCount(current.modelTotalTokens) + usage.totalTokens,
    modelUsageResponseCount: finiteTokenCount(current.modelUsageResponseCount) + usage.responseCount,
  }
}

/**
 * 统一解析 OpenAI Responses、Chat Completions 与 DeepSeek 兼容字段。
 * 缓存明细中的 0 也表示供应商已明确报告，不能与字段缺失混为一谈。
 */
export function normalizedUsageFromProviderResponse(response: Record<string, unknown>): NormalizedModelUsage {
  const raw = isRecord(response.raw) && isRecord(response.raw.usage)
    ? response.raw.usage
    : isRecord(response.usage)
      ? response.usage
      : {}
  const inputTokens = firstTokenCount(raw.input_tokens, raw.prompt_tokens, raw.inputTokens)
  const outputTokens = firstTokenCount(raw.output_tokens, raw.completion_tokens, raw.outputTokens)
  const reportedTotalTokens = firstTokenCount(raw.total_tokens, raw.totalTokens)
  const aggregated = aggregateModelUsage([{
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: reportedTotalTokens || inputTokens + outputTokens,
    },
    rawUsage: raw,
  }])
  return toNormalizedModelUsage(aggregated)
}

export function normalizeStoredModelUsage(value: Record<string, unknown>): NormalizedModelUsage {
  return {
    inputTokens: finiteTokenCount(value.inputTokens),
    outputTokens: finiteTokenCount(value.outputTokens),
    totalTokens: finiteTokenCount(value.totalTokens),
    cacheHitInputTokens: finiteTokenCount(value.cacheHitInputTokens),
    cacheMissInputTokens: finiteTokenCount(value.cacheMissInputTokens),
    cacheMeasuredInputTokens: finiteTokenCount(value.cacheMeasuredInputTokens),
    cacheDetailReported: finiteTokenCount(value.cacheDetailReported),
  }
}

export function toNormalizedModelUsage(usage: AggregatedModelUsage): NormalizedModelUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheHitInputTokens: usage.cacheHitInputTokens,
    cacheMissInputTokens: usage.cacheMissInputTokens,
    cacheMeasuredInputTokens: usage.cacheMeasuredInputTokens,
    cacheDetailReported: usage.cacheDetailReportedCount,
  }
}

function emptyAggregatedUsage(): AggregatedModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
    cacheMeasuredInputTokens: 0,
    cacheDetailReportedCount: 0,
    responseCount: 0,
  }
}

function cacheDetailsFromProviderUsage(raw: Record<string, unknown>): {
  cacheHit: CacheTokenCount
  cacheMiss: CacheTokenCount
} {
  const records: Record<string, unknown>[] = []
  for (const candidate of [raw.input_tokens_details, raw.prompt_tokens_details, raw.inputTokensDetails]) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (isRecord(item)) records.push(item)
      }
    } else if (isRecord(candidate)) {
      records.push(candidate)
    }
  }
  records.push(raw)
  return {
    // 一个原始 usage 对象描述一次供应商响应；嵌套、顶层和命名风格只是
    // 同一计数的不同投影，跨所有投影取最大值，不能逐容器相加。
    cacheHit: cacheTokenMaximum(records, CACHE_HIT_DETAIL_KEYS),
    cacheMiss: cacheTokenMaximum(records, CACHE_MISS_DETAIL_KEYS),
  }
}

function cacheDetailsFromSdkUsage(
  details: ModelUsageLike['inputTokensDetails'],
): { cacheHit: CacheTokenCount; cacheMiss: CacheTokenCount } {
  const cacheHit = cacheHitInputTokens(details)
  const cacheMiss = cacheTokenCount(details, CACHE_MISS_DETAIL_KEYS)
  if (cacheHit.value > 0 || cacheMiss.value > 0) return { cacheHit, cacheMiss }
  // Agents SDK 的 Chat Completions 流会在供应商完全没有返回
  // prompt_tokens_details 时合成 { cached_tokens: 0 }。归一化后的纯零明细
  // 已经失去来源信息，不能据此宣称供应商报告过缓存；明确的供应商零值由
  // rawUsage 分支保留。
  return {
    cacheHit: { value: 0, reported: false },
    cacheMiss: { value: 0, reported: false },
  }
}

interface CacheTokenCount {
  value: number
  reported: boolean
}

function cacheHitInputTokens(
  details: Record<string, number> | Array<Record<string, number>> | null | undefined,
): { value: number; reported: boolean } {
  return cacheTokenCount(details, CACHE_HIT_DETAIL_KEYS)
}

function cacheTokenCount(
  details: Record<string, number> | Array<Record<string, number>> | null | undefined,
  keys: ReadonlySet<string>,
): { value: number; reported: boolean } {
  const records = details ? (Array.isArray(details) ? details : [details]) : []
  let value = 0
  let reported = false
  for (const record of records) {
    const candidates = Object.entries(record)
      .filter(([key]) => keys.has(key))
      .map(([, count]) => finiteTokenCount(count))
    if (!candidates.length) continue
    reported = true
    // 同一供应商可能同时暴露 snake_case 和 camelCase 同义字段；它们
    // 表达同一计数，取最大值可以保留真实值而不重复累计。
    value += Math.max(...candidates)
  }
  return { value, reported }
}

function cacheTokenMaximum(
  records: readonly Record<string, unknown>[],
  keys: ReadonlySet<string>,
): CacheTokenCount {
  const candidates = records.flatMap(record => Object.entries(record)
    .filter(([key, value]) => keys.has(key) && isNonnegativeNumber(value))
    .map(([, value]) => finiteTokenCount(value)))
  return {
    value: candidates.length ? Math.max(...candidates) : 0,
    reported: candidates.length > 0,
  }
}

function firstTokenCount(...values: unknown[]): number {
  for (const value of values) {
    if (isNonnegativeNumber(value)) return Math.trunc(value)
  }
  return 0
}

function finiteTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

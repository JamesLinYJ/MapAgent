// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型词元用量测试
//
//   文件:       modelUsage.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  aggregateModelUsage,
  mergeModelUsageStats,
  normalizedUsageFromProviderResponse,
} from '../model/modelUsage.js'

describe('model usage aggregation', () => {
  it('分别累计输入、输出、总量和命中缓存输入', () => {
    const usage = aggregateModelUsage([
      { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, inputTokensDetails: { cached_tokens: 40 } } },
      { usage: { inputTokens: 80, outputTokens: 10, totalTokens: 90, inputTokensDetails: { cacheReadInputTokens: 30 } } },
    ])

    expect(usage).toEqual({
      inputTokens: 180,
      outputTokens: 30,
      totalTokens: 210,
      cacheHitInputTokens: 70,
      cacheMissInputTokens: 110,
      cacheMeasuredInputTokens: 180,
      cacheDetailReportedCount: 2,
      responseCount: 2,
    })
  })

  it('优先采用供应商明确返回的未命中词元', () => {
    const usage = aggregateModelUsage([{
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        inputTokensDetails: { prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 },
      },
    }])

    expect(usage).toMatchObject({
      cacheHitInputTokens: 60,
      cacheMissInputTokens: 40,
      cacheMeasuredInputTokens: 100,
      cacheDetailReportedCount: 1,
    })
  })

  it('完全没有缓存明细时不把输入误判成未命中', () => {
    const usage = aggregateModelUsage([{
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    }])

    expect(usage).toMatchObject({
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 0,
      cacheMeasuredInputTokens: 0,
      cacheDetailReportedCount: 0,
    })
  })

  it('全零 SDK 占位用量不冒充供应商已报告', () => {
    const usage = aggregateModelUsage([{
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, inputTokensDetails: {} },
    }])

    expect(usage.responseCount).toBe(0)
    expect(usage.cacheDetailReportedCount).toBe(0)
  })

  it('Chat Completions SDK 合成的 cached_tokens 零值不冒充供应商明细', () => {
    const usage = aggregateModelUsage([{
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        inputTokensDetails: { cached_tokens: 0 },
      },
    }])

    expect(usage).toMatchObject({
      inputTokens: 100,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 0,
      cacheMeasuredInputTokens: 0,
      cacheDetailReportedCount: 0,
      responseCount: 1,
    })
  })

  it('供应商原始 usage 明确返回 cached_tokens 零值时仍算已报告', () => {
    const usage = aggregateModelUsage([{
      usage: {
        inputTokens: 50,
        outputTokens: 5,
        totalTokens: 55,
        // 这是 Agents SDK 对同一原始明细的归一化投影；判定来源必须看 rawUsage。
        inputTokensDetails: { cached_tokens: 0 },
      },
      rawUsage: {
        prompt_tokens: 50,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    }])

    expect(usage).toMatchObject({
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 50,
      cacheMeasuredInputTokens: 50,
      cacheDetailReportedCount: 1,
      responseCount: 1,
    })
  })

  it('同义缓存字段不会被重复累计', () => {
    const usage = aggregateModelUsage([{
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        inputTokensDetails: { cached_tokens: 60, cachedTokens: 60, cache_read_tokens: 60 },
      },
    }])

    expect(usage.cacheHitInputTokens).toBe(60)
    expect(usage.cacheDetailReportedCount).toBe(1)
  })

  it('原始 usage 的嵌套与顶层同义字段不会跨容器重复累计', () => {
    const usage = normalizedUsageFromProviderResponse({
      raw: {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 40 },
          prompt_cache_hit_tokens: 40,
        },
      },
    })

    expect(usage).toMatchObject({
      inputTokens: 100,
      cacheHitInputTokens: 40,
      cacheMissInputTokens: 60,
      cacheMeasuredInputTokens: 100,
      cacheDetailReported: 1,
    })
  })

  it('统一解析 Responses 的实际词元和缓存明细', () => {
    const usage = normalizedUsageFromProviderResponse({
      raw: {
        usage: {
          input_tokens: 100,
          output_tokens: 12,
          total_tokens: 112,
          input_tokens_details: { cached_tokens: 40 },
        },
      },
    })

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 12,
      totalTokens: 112,
      cacheHitInputTokens: 40,
      cacheMissInputTokens: 60,
      cacheMeasuredInputTokens: 100,
      cacheDetailReported: 1,
    })
  })

  it('保留明确报告的零缓存命中', () => {
    const usage = normalizedUsageFromProviderResponse({
      raw: {
        usage: {
          prompt_tokens: 50,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      },
    })

    expect(usage).toMatchObject({
      inputTokens: 50,
      totalTokens: 55,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 50,
      cacheMeasuredInputTokens: 50,
      cacheDetailReported: 1,
    })
  })

  it('把本次计量合并到已有真实统计', () => {
    const merged = mergeModelUsageStats({
      modelInputTokens: 10,
      customMetric: 3,
    }, {
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      cacheHitInputTokens: 4,
      cacheMissInputTokens: 6,
      cacheMeasuredInputTokens: 10,
      cacheDetailReportedCount: 1,
      responseCount: 1,
    })

    expect(merged.modelInputTokens).toBe(15)
    expect(merged.modelOutputTokens).toBe(2)
    expect(merged.modelCacheHitInputTokens).toBe(4)
    expect(merged.modelCacheMeasuredInputTokens).toBe(10)
    expect(merged.modelTotalTokens).toBe(7)
    expect(merged.customMetric).toBe(3)
  })

  it('新运行统计不再创建缓存明细覆盖率字段', () => {
    const merged = mergeModelUsageStats({}, {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cacheHitInputTokens: 4,
      cacheMissInputTokens: 6,
      cacheMeasuredInputTokens: 10,
      cacheDetailReportedCount: 1,
      responseCount: 1,
    })

    expect(merged).not.toHaveProperty('modelCacheHitReportedResponseCount')
    expect(merged).not.toHaveProperty('modelCacheMissInputTokens')
    expect(merged).not.toHaveProperty('modelCacheMissReportedResponseCount')
    expect(merged).not.toHaveProperty('modelCacheDetailReportedResponseCount')
  })
})

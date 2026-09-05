// +-------------------------------------------------------------------------
//
//   地理智能平台 - 公开天气查询工具测试
//
//   文件:       handler.test.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import type { ToolContext, ToolProvider, ValueRef } from '../../framework/types.js'
import { parseToolManifest } from '../../framework/schema.js'
import { validateToolProvider } from '../../framework/validation.js'
import { createPublicWeatherTool } from './handler.js'
import manifest from './manifest.json' with { type: 'json' }
import type { PublicWeatherClient, PublicWeatherQuery, PublicWeatherSnapshot } from './openMeteoClient.js'

describe('public weather tool', () => {
  it('matches the provider manifest and returns a traceable weather valueRef', async () => {
    const query = vi.fn(async (_input: PublicWeatherQuery, _signal: AbortSignal) => snapshot())
    const client: PublicWeatherClient = { query }
    const tool = createPublicWeatherTool(client)
    const provider: ToolProvider = { manifest: parseToolManifest(manifest), tools: () => [tool] }

    expect(() => validateToolProvider(provider)).not.toThrow()
    const result = await tool.handler({ location: '杭州' }, runtime())

    expect(query).toHaveBeenCalledWith({
      location: '杭州',
      forecastDays: 3,
      includeAirQuality: true,
    }, expect.any(AbortSignal))
    expect(result.message).toContain('杭州')
    expect(result.message).toContain('28.4°C')
    expect(result.valueRefs?.[0]).toMatchObject({
      kind: 'public_weather_snapshot',
      label: '中国·浙江·杭州公开天气',
      metadata: { provider: 'Open-Meteo', timezone: 'Asia/Shanghai' },
    })
    expect(result.provenance).toMatchObject({ provider: 'Open-Meteo', weatherLicense: 'CC BY 4.0' })
  })

  it('uses an existing place valueRef instead of asking the provider to geocode again', async () => {
    const query = vi.fn(async (_input: PublicWeatherQuery, _signal: AbortSignal) => snapshot())
    const tool = createPublicWeatherTool({ query })
    const placeRef: ValueRef = {
      refId: 'ref_place',
      kind: 'place_candidate',
      label: '杭州',
      value: { latitude: 30.2741, longitude: 120.1551 },
    }

    await tool.handler({
      location: '杭州',
      location_ref: 'ref_place',
      forecast_days: 1,
      include_air_quality: false,
    }, runtime(new Map([[placeRef.refId, placeRef]])))

    expect(query).toHaveBeenCalledWith({
      location: '杭州',
      forecastDays: 1,
      includeAirQuality: false,
      coordinates: { latitude: 30.2741, longitude: 120.1551 },
    }, expect.any(AbortSignal))
  })

  it('puts precipitation peaks beyond the generic array sample into the model-facing summary', async () => {
    const weather = snapshot()
    weather.hourly = Array.from({ length: 12 }, (_, index) => hourlyForecast(
      `2026-07-24T${String(index).padStart(2, '0')}:00`,
      index === 10 ? 85 : 5,
      index === 10 ? 3.2 : 0,
    ))
    const tool = createPublicWeatherTool({ query: async () => weather })

    const result = await tool.handler({ location: '杭州' }, runtime())

    expect(result.message).toContain('逐小时预报覆盖：2026-07-24 00:00 至 2026-07-24 11:00')
    expect(result.message).toContain('2026-07-24（明天）')
    expect(result.message).toContain('小时降水概率峰值85%')
    expect(result.message).toContain('峰值时次10:00')
    expect(result.message).toContain('最大小时降水量3.2mm')
    expect(result.message).toContain('不是当地气象站或观测站坐标')
  })

  it('rejects a valueRef that is not a supported coordinate kind', async () => {
    const tool = createPublicWeatherTool({ query: async () => snapshot() })
    const invalidRef: ValueRef = {
      refId: 'ref_dataset',
      kind: 'meteorological_dataset',
      label: '数据集',
      value: { latitude: 30, longitude: 120 },
    }

    await expect(tool.handler({ location: '杭州', location_ref: invalidRef.refId }, runtime(
      new Map([[invalidRef.refId, invalidRef]]),
    ))).rejects.toThrow("location_ref 'ref_dataset' 必须引用地点坐标")
  })
})

function runtime(refs: ReadonlyMap<string, ValueRef> = new Map()): ToolContext {
  return {
    runId: 'run_1',
    threadId: 'thread_1',
    sessionId: 'session_1',
    signal: new AbortController().signal,
    state: new Map(),
    resolveValueRef: refId => {
      const ref = refs.get(refId)
      if (!ref) throw new Error(`未知 valueRef '${refId}'`)
      return ref
    },
    invokeStructuredModel: async () => ({}),
    log: () => undefined,
  }
}

function snapshot(): PublicWeatherSnapshot {
  return {
    source: {
      provider: 'Open-Meteo',
      weatherLicense: 'CC BY 4.0',
      weatherDocumentation: 'https://open-meteo.com/en/docs',
      airQualityDocumentation: 'https://open-meteo.com/en/docs/air-quality-api',
    },
    location: {
      query: '杭州',
      name: '杭州',
      countryCode: 'CN',
      country: '中国',
      admin1: '浙江',
      admin2: '杭州',
      latitude: 30.25,
      longitude: 120.17,
      timezone: 'Asia/Shanghai',
    },
    current: {
      observedAt: '2026-07-23T16:00',
      weatherCode: 61,
      weatherText: '小雨',
      temperatureC: 28.4,
      apparentTemperatureC: 32.1,
      relativeHumidityPercent: 81,
      dewPointC: 24.7,
      isDay: true,
      precipitationMm: 0.2,
      cloudCoverPercent: 76,
      pressureMeanSeaLevelHpa: 1002.4,
      surfacePressureHpa: 1000.1,
      visibilityKm: 9.8,
      windSpeedKmh: 11.2,
      windDirectionDegrees: 135,
      windDirectionText: '东南风',
      windGustsKmh: 22.4,
    },
    hourly: [],
    daily: [{
      date: '2026-07-23',
      weatherCode: 61,
      weatherText: '小雨',
      temperatureMaxC: 31,
      temperatureMinC: 25,
      apparentTemperatureMaxC: 35,
      apparentTemperatureMinC: 27,
      sunrise: '2026-07-23T05:12',
      sunset: '2026-07-23T18:58',
      daylightDurationHours: 13.77,
      sunshineDurationHours: 5.56,
      uvIndexMax: 8.1,
      rainSumMm: 3.5,
      showersSumMm: 0.7,
      snowfallSumCm: 0,
      precipitationSumMm: 4.2,
      precipitationHours: 5,
      precipitationProbabilityMaxPercent: 80,
      windSpeedMaxKmh: 18,
      windGustsMaxKmh: 32,
      dominantWindDirectionDegrees: 135,
      dominantWindDirectionText: '东南风',
    }],
    airQuality: {
      observedAt: '2026-07-23T16:00',
      indexStandard: 'US EPA AQI',
      aqi: 42,
      category: '优',
      europeanAqi: 18,
      europeanCategory: '良好',
      pm25MicrogramsPerCubicMeter: 10.2,
      pm10MicrogramsPerCubicMeter: 22.4,
      carbonMonoxideMicrogramsPerCubicMeter: 171.2,
      nitrogenDioxideMicrogramsPerCubicMeter: 8.4,
      sulphurDioxideMicrogramsPerCubicMeter: 5.2,
      ozoneMicrogramsPerCubicMeter: 63.2,
      aerosolOpticalDepth: 0.16,
      dustMicrogramsPerCubicMeter: 4.3,
      hourly: [],
    },
    retrievedAt: '2026-07-23T08:00:00.000Z',
    limitations: ['非官方预警'],
    warnings: [],
  }
}

function hourlyForecast(
  forecastAt: string,
  precipitationProbabilityPercent: number,
  precipitationMm: number,
): PublicWeatherSnapshot['hourly'][number] {
  return {
    forecastAt,
    weatherCode: precipitationMm > 0 ? 61 : 0,
    weatherText: precipitationMm > 0 ? '小雨' : '晴',
    temperatureC: 28,
    apparentTemperatureC: 30,
    relativeHumidityPercent: 70,
    dewPointC: 22,
    precipitationProbabilityPercent,
    precipitationMm,
    rainMm: precipitationMm,
    showersMm: 0,
    snowfallCm: 0,
    pressureMeanSeaLevelHpa: 1_002,
    cloudCoverPercent: 20,
    visibilityKm: 10,
    uvIndex: 1,
    windSpeedKmh: 8,
    windDirectionDegrees: 135,
    windDirectionText: '东南风',
    windGustsKmh: 15,
  }
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 公开天气查询工具
//
//   文件:       handler.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'

import type { ToolDef, ValueRef } from '../../framework/types.js'
import { makeId } from '../../utils/ids.js'
import type { PublicWeatherClient, PublicWeatherSnapshot } from './openMeteoClient.js'
import { PUBLIC_WEATHER_PROMPT } from './prompt.js'

const PUBLIC_WEATHER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    location: {
      type: 'string',
      minLength: 2,
      maxLength: 160,
      description: '城市或区县的标准名称，例如“杭州”；明确景点或 POI 可使用所属城市查询，但回答必须说明是城市级近似预报',
    },
    country_code: {
      type: 'string',
      minLength: 2,
      maxLength: 2,
      description: '可选的 ISO 3166-1 alpha-2 国家代码，例如 CN',
    },
    location_ref: {
      type: 'string',
      minLength: 1,
      description: '可选的当前 run place_candidate 或 nowcast_coordinate valueRef ID',
      'x-source': 'value_ref',
      'x-value-ref-kinds': ['place_candidate', 'nowcast_coordinate'],
    },
    forecast_days: {
      type: 'integer',
      minimum: 1,
      maximum: 7,
      default: 3,
      description: '日预报天数，1–7 天',
    },
    include_air_quality: {
      type: 'boolean',
      default: true,
      description: '是否同时查询参考空气质量',
    },
  },
  required: ['location'],
} as const

const inputSchema = z.object({
  location: z.string().trim().min(2).max(160),
  country_code: z.string().trim().length(2).transform(value => value.toUpperCase()).optional(),
  location_ref: z.string().trim().min(1).optional(),
  forecast_days: z.number().int().min(1).max(7).default(3),
  include_air_quality: z.boolean().default(true),
}).strict()

export function createPublicWeatherTool(client: PublicWeatherClient): ToolDef {
  return {
    name: 'query_public_weather',
    label: '查询公开天气',
    description: '查询地点当前天气、请求天数内逐小时预报、未来1–7天综合预报及参考空气质量。',
    prompt: PUBLIC_WEATHER_PROMPT,
    group: '气象',
    tags: ['weather', 'forecast', 'air-quality', 'public-data'],
    isReadOnly: true,
    isDestructive: false,
    parallelSafe: true,
    executionSurfaces: ['agent', 'automation', 'debug'],
    agentResultMode: 'continue',
    jsonSchema: PUBLIC_WEATHER_JSON_SCHEMA,
    async handler(args, context) {
      const input = inputSchema.parse(args)
      const coordinates = input.location_ref
        ? coordinatesFromRef(context.resolveValueRef(input.location_ref), input.location_ref)
        : undefined
      const snapshot = await client.query({
        location: input.location,
        ...(input.country_code ? { countryCode: input.country_code } : {}),
        forecastDays: input.forecast_days,
        includeAirQuality: input.include_air_quality,
        ...(coordinates ? { coordinates } : {}),
      }, context.signal)
      const summary = weatherSummary(snapshot)
      return {
        message: summary,
        payload: snapshot as unknown as Record<string, unknown>,
        warnings: snapshot.warnings,
        resultId: makeId('result'),
        source: 'open-meteo',
        valueRefs: [{
          refId: makeId('ref'),
          kind: 'public_weather_snapshot',
          label: `${resolvedLocationLabel(snapshot)}公开天气`,
          value: snapshot,
          metadata: {
            provider: 'Open-Meteo',
            retrievedAt: snapshot.retrievedAt,
            timezone: snapshot.location.timezone,
          },
        }],
        provenance: {
          provider: 'Open-Meteo',
          weatherLicense: 'CC BY 4.0',
          retrievedAt: snapshot.retrievedAt,
          weatherDocumentation: snapshot.source.weatherDocumentation,
          airQualityDocumentation: snapshot.source.airQualityDocumentation,
        },
      }
    },
  }
}

function coordinatesFromRef(ref: ValueRef, refId: string): { latitude: number; longitude: number } {
  if (!['place_candidate', 'nowcast_coordinate'].includes(ref.kind)) {
    throw new Error(`location_ref '${refId}' 必须引用地点坐标，实际为 ${ref.kind}`)
  }
  if (!isRecord(ref.value)) throw new Error(`location_ref '${refId}' 不包含有效经纬度`)
  const latitude = numeric(ref.value.latitude ?? ref.value.lat)
  const longitude = numeric(ref.value.longitude ?? ref.value.lon ?? ref.value.lng)
  if (latitude === null || longitude === null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new Error(`location_ref '${refId}' 不包含有效经纬度`)
  }
  return { latitude, longitude }
}

function weatherSummary(snapshot: PublicWeatherSnapshot): string {
  const current = snapshot.current
  const daily = snapshot.daily
  const currentParts = [
    `${current.observedAt} ${current.weatherText}`,
    current.temperatureC === null ? null : `${current.temperatureC.toFixed(1)}°C`,
    current.apparentTemperatureC === null ? null : `体感${current.apparentTemperatureC.toFixed(1)}°C`,
    current.relativeHumidityPercent === null ? null : `相对湿度${current.relativeHumidityPercent.toFixed(0)}%`,
    current.precipitationMm === null ? null : `当前降水${current.precipitationMm.toFixed(1)}mm`,
  ].filter((value): value is string => Boolean(value))
  const dailyParts = daily.map(day => [
    `${day.date}（${relativeDayLabel(day.date, current.observedAt)}）${day.weatherText}`,
    temperatureRange(day.temperatureMinC, day.temperatureMaxC),
    metric(day.precipitationProbabilityMaxPercent, value => `最大降水概率${value.toFixed(0)}%`),
    metric(day.precipitationSumMm, value => `总降水量${value.toFixed(1)}mm`),
    metric(day.precipitationHours, value => `预计降水${value.toFixed(0)}小时`),
    metric(day.windGustsMaxKmh, value => `最大阵风${value.toFixed(1)}km/h`),
  ].filter((value): value is string => Boolean(value)).join('，'))
  return [
    `数据源：Open-Meteo。解析地点：${resolvedLocationLabel(snapshot)}；数值模式网格点：${snapshot.location.latitude.toFixed(4)}, ${snapshot.location.longitude.toFixed(4)}；地点时区：${snapshot.location.timezone}；地点当前数据时次：${current.observedAt}。相对日期“今天/明天/后天”均以这个地点本地日期为准，不得根据 UTC 获取时间重新换算。`,
    `当前天气：${currentParts.join('，')}。`,
    dailyParts.length ? `逐日预报：${dailyParts.join('；')}。` : null,
    hourlyPrecipitationSummary(snapshot),
    '来源说明：以上坐标是 Open-Meteo 数值模式网格点，不是当地气象站或观测站坐标。',
  ].filter((value): value is string => Boolean(value)).join('\n')
}

function hourlyPrecipitationSummary(snapshot: PublicWeatherSnapshot): string {
  const hourly = snapshot.hourly
  const first = hourly[0]
  const last = hourly.at(-1)
  if (!first || !last) return '逐小时预报：本次结果未返回可用的逐小时数据。'
  const byDate = new Map<string, typeof hourly>()
  for (const item of hourly) {
    const date = item.forecastAt.slice(0, 10)
    const existing = byDate.get(date) ?? []
    existing.push(item)
    byDate.set(date, existing)
  }
  const daySummaries = [...byDate.entries()].map(([date, items]) => {
    const probabilityPeak = maximum(items.map(item => item.precipitationProbabilityPercent))
    const precipitationPeak = maximum(items.map(item => item.precipitationMm))
    const probabilityTimes = probabilityPeak === null
      ? []
      : items.filter(item => item.precipitationProbabilityPercent === probabilityPeak).map(item => localTime(item.forecastAt))
    const precipitationTimes = precipitationPeak === null || precipitationPeak <= 0
      ? []
      : items.filter(item => item.precipitationMm === precipitationPeak).map(item => localTime(item.forecastAt))
    const wetTimes = items.filter(item => (item.precipitationMm ?? 0) > 0).map(item => localTime(item.forecastAt))
    return [
      `${date}（${relativeDayLabel(date, snapshot.current.observedAt)}）`,
      probabilityPeak === null
        ? '小时降水概率峰值未知'
        : `小时降水概率峰值${probabilityPeak.toFixed(0)}%，峰值时次${boundedTimes(probabilityTimes)}`,
      precipitationPeak === null
        ? '最大小时降水量未知'
        : precipitationPeak <= 0
          ? '小时降水量均为0.0mm'
          : `最大小时降水量${precipitationPeak.toFixed(1)}mm，出现时次${boundedTimes(precipitationTimes)}`,
      wetTimes.length ? `有量降水时次${boundedTimes(wetTimes)}` : '无有量降水时次',
    ].join('，')
  })

  return `逐小时预报覆盖：${localHour(first.forecastAt)} 至 ${localHour(last.forecastAt)}（${snapshot.location.timezone}）。分日小时峰值：${daySummaries.join('；')}。`
}

function boundedTimes(times: string[]): string {
  const unique = [...new Set(times)]
  if (!unique.length) return '未知'
  const visible = unique.slice(0, 8)
  return unique.length > visible.length ? `${visible.join('、')} 等 ${unique.length} 个时次` : visible.join('、')
}

function localHour(value: string): string {
  return value.replace('T', ' ').slice(0, 16)
}

function localTime(value: string): string {
  return value.slice(11, 16)
}

function relativeDayLabel(date: string, observedAt: string): string {
  const target = dateValue(date)
  const current = dateValue(observedAt.slice(0, 10))
  if (target === null || current === null) return '日期'
  const offset = Math.round((target - current) / 86_400_000)
  if (offset === 0) return '今天'
  if (offset === 1) return '明天'
  if (offset === 2) return '后天'
  if (offset > 2) return `${offset}天后`
  return `${Math.abs(offset)}天前`
}

function dateValue(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  return Date.UTC(year, month - 1, day)
}

function temperatureRange(minimum: number | null, maximumValue: number | null): string | null {
  if (minimum === null && maximumValue === null) return null
  if (minimum === null) return `最高${maximumValue?.toFixed(1)}°C`
  if (maximumValue === null) return `最低${minimum.toFixed(1)}°C`
  return `${minimum.toFixed(1)}–${maximumValue.toFixed(1)}°C`
}

function metric(value: number | null, format: (available: number) => string): string | null {
  return value === null ? null : format(value)
}

function resolvedLocationLabel(snapshot: PublicWeatherSnapshot): string {
  const regions = [snapshot.location.country, snapshot.location.admin1, snapshot.location.admin2, snapshot.location.name]
    .filter((value): value is string => Boolean(value))
  return [...new Set(regions)].join('·') || snapshot.location.query
}

function maximum(values: Array<number | null>): number | null {
  const available = values.filter((value): value is number => value !== null)
  return available.length ? Math.max(...available) : null
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

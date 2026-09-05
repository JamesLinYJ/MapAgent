// +-------------------------------------------------------------------------
//
//   地理智能平台 - Open-Meteo 公开天气客户端测试
//
//   文件:       openMeteoClient.test.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { OpenMeteoClient } from './openMeteoClient.js'

const options = {
  forecastBaseUrl: 'https://api.open-meteo.test',
  geocodingBaseUrl: 'https://geocoding-api.open-meteo.test',
  airQualityBaseUrl: 'https://air-quality-api.open-meteo.test',
  timeoutMs: 5_000,
}

describe('OpenMeteoClient', () => {
  it('validates and normalizes geocoding, weather and air-quality responses', async () => {
    const requested: URL[] = []
    const client = new OpenMeteoClient({
      ...options,
      fetchImpl: async input => {
        const url = requestUrl(input)
        requested.push(url)
        if (url.hostname.startsWith('geocoding-api')) return jsonResponse(geocodingPayload())
        if (url.hostname.startsWith('air-quality-api')) return jsonResponse(airQualityPayload())
        return jsonResponse(forecastPayload())
      },
    })

    const snapshot = await client.query({
      location: '杭州',
      countryCode: 'CN',
      forecastDays: 3,
      includeAirQuality: true,
    }, new AbortController().signal)

    expect(snapshot.location).toMatchObject({
      query: '杭州',
      name: '杭州',
      countryCode: 'CN',
      admin1: '浙江',
      latitude: 30.25,
      longitude: 120.17,
      timezone: 'Asia/Shanghai',
    })
    expect(snapshot.current).toMatchObject({
      weatherText: '小雨',
      temperatureC: 28.4,
      relativeHumidityPercent: 81,
      dewPointC: 24.7,
      pressureMeanSeaLevelHpa: 1_002.4,
      visibilityKm: 9.8,
      windDirectionText: '东南风',
      windGustsKmh: 22.4,
    })
    expect(snapshot.hourly).toHaveLength(72)
    expect(snapshot.daily).toHaveLength(3)
    expect(snapshot.daily[0]).toMatchObject({
      sunrise: '2026-07-23T05:12',
      sunset: '2026-07-23T18:58',
      uvIndexMax: 8.1,
    })
    expect(snapshot.airQuality).toMatchObject({
      indexStandard: 'US EPA AQI',
      aqi: 42,
      category: '优',
      europeanAqi: 18,
      europeanCategory: '良好',
      ozoneMicrogramsPerCubicMeter: 63.2,
    })
    expect(snapshot.airQuality?.hourly).toHaveLength(24)
    expect(snapshot.warnings).toEqual([])

    const geocodingUrl = requested.find(url => url.hostname.startsWith('geocoding-api'))
    const forecastUrl = requested.find(url => url.hostname === 'api.open-meteo.test')
    expect(geocodingUrl?.searchParams.get('name')).toBe('杭州')
    expect(geocodingUrl?.searchParams.get('countryCode')).toBe('CN')
    expect(forecastUrl?.searchParams.get('forecast_hours')).toBe('72')
    expect(forecastUrl?.searchParams.get('forecast_days')).toBe('3')
    expect(forecastUrl?.searchParams.get('timezone')).toBe('auto')
  })

  it('keeps valid weather data when the optional air-quality endpoint fails', async () => {
    const client = new OpenMeteoClient({
      ...options,
      fetchImpl: async input => {
        const url = requestUrl(input)
        if (url.hostname.startsWith('air-quality-api')) return jsonResponse({ detail: 'unavailable' }, 503)
        return jsonResponse(url.hostname.startsWith('geocoding-api') ? geocodingPayload() : forecastPayload())
      },
    })

    const snapshot = await client.query({
      location: '杭州',
      forecastDays: 2,
      includeAirQuality: true,
    }, new AbortController().signal)

    expect(snapshot.current.temperatureC).toBe(28.4)
    expect(snapshot.airQuality).toBeNull()
    expect(snapshot.warnings).toEqual(['空气质量数据暂不可用；天气实况和预报仍然有效。'])
  })

  it('hard-fails when the required forecast response violates its schema', async () => {
    const client = new OpenMeteoClient({
      ...options,
      fetchImpl: async input => {
        const url = requestUrl(input)
        return jsonResponse(url.hostname.startsWith('geocoding-api') ? geocodingPayload() : { latitude: 'invalid' })
      },
    })

    await expect(client.query({
      location: '杭州',
      forecastDays: 1,
      includeAirQuality: false,
    }, new AbortController().signal)).rejects.toThrow('公开天气查询响应字段不符合契约。')
  })
})

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input
  if (typeof input === 'string') return new URL(input)
  return new URL(input.url)
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function geocodingPayload() {
  return {
    results: [{
      name: '杭州',
      latitude: 30.25,
      longitude: 120.17,
      country_code: 'CN',
      country: '中国',
      admin1: '浙江',
      admin2: '杭州',
      timezone: 'Asia/Shanghai',
    }],
  }
}

function forecastPayload() {
  const hourlyTime = Array.from({ length: 80 }, (_, index) => {
    const day = 23 + Math.floor(index / 24)
    return `2026-07-${String(day).padStart(2, '0')}T${String(index % 24).padStart(2, '0')}:00`
  })
  const hourlyNumber = (value: number) => Array.from({ length: 80 }, () => value)
  return {
    latitude: 30.25,
    longitude: 120.17,
    timezone: 'Asia/Shanghai',
    current: {
      time: '2026-07-23T16:00',
      temperature_2m: 28.4,
      relative_humidity_2m: 81,
      dew_point_2m: 24.7,
      apparent_temperature: 32.1,
      is_day: 1,
      precipitation: 0.2,
      weather_code: 61,
      cloud_cover: 76,
      pressure_msl: 1002.4,
      surface_pressure: 1000.1,
      visibility: 9800,
      wind_speed_10m: 11.2,
      wind_direction_10m: 135,
      wind_gusts_10m: 22.4,
    },
    hourly: {
      time: hourlyTime,
      temperature_2m: hourlyNumber(28),
      relative_humidity_2m: hourlyNumber(80),
      dew_point_2m: hourlyNumber(24),
      apparent_temperature: hourlyNumber(31),
      precipitation_probability: hourlyNumber(65),
      precipitation: hourlyNumber(0.3),
      rain: hourlyNumber(0.2),
      showers: hourlyNumber(0.1),
      snowfall: hourlyNumber(0),
      weather_code: hourlyNumber(61),
      pressure_msl: hourlyNumber(1002),
      cloud_cover: hourlyNumber(75),
      visibility: hourlyNumber(10000),
      uv_index: hourlyNumber(4.2),
      wind_speed_10m: hourlyNumber(12),
      wind_direction_10m: hourlyNumber(135),
      wind_gusts_10m: hourlyNumber(24),
    },
    daily: {
      time: ['2026-07-23', '2026-07-24', '2026-07-25'],
      weather_code: [61, 80, 2],
      temperature_2m_max: [31, 32, 34],
      temperature_2m_min: [25, 26, 27],
      apparent_temperature_max: [35, 36, 38],
      apparent_temperature_min: [27, 28, 29],
      sunrise: ['2026-07-23T05:12', '2026-07-24T05:13', '2026-07-25T05:13'],
      sunset: ['2026-07-23T18:58', '2026-07-24T18:57', '2026-07-25T18:56'],
      daylight_duration: [49_560, 49_440, 49_380],
      sunshine_duration: [20_000, 22_000, 30_000],
      uv_index_max: [8.1, 7.5, 9.2],
      rain_sum: [3.5, 1.8, 0],
      showers_sum: [0.7, 0.3, 0],
      snowfall_sum: [0, 0, 0],
      precipitation_sum: [4.2, 2.1, 0],
      precipitation_hours: [5, 3, 0],
      precipitation_probability_max: [80, 60, 20],
      wind_speed_10m_max: [18, 16, 13],
      wind_gusts_10m_max: [32, 29, 24],
      wind_direction_10m_dominant: [135, 120, 90],
    },
  }
}

function airQualityPayload() {
  return {
    current: {
      time: '2026-07-23T16:00',
      us_aqi: 42,
      european_aqi: 18,
      pm2_5: 10.2,
      pm10: 22.4,
      carbon_monoxide: 171.2,
      nitrogen_dioxide: 8.4,
      sulphur_dioxide: 5.2,
      ozone: 63.2,
      aerosol_optical_depth: 0.16,
      dust: 4.3,
    },
    hourly: {
      time: Array.from({ length: 30 }, (_, index) => `2026-07-23T${String(index % 24).padStart(2, '0')}:00`),
      us_aqi: Array.from({ length: 30 }, () => 42),
      european_aqi: Array.from({ length: 30 }, () => 18),
      pm2_5: Array.from({ length: 30 }, () => 10.2),
      pm10: Array.from({ length: 30 }, () => 22.4),
      nitrogen_dioxide: Array.from({ length: 30 }, () => 8.4),
      ozone: Array.from({ length: 30 }, () => 63.2),
      dust: Array.from({ length: 30 }, () => 4.3),
    },
  }
}

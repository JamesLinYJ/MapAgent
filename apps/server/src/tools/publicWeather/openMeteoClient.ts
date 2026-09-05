// +-------------------------------------------------------------------------
//
//   地理智能平台 - Open-Meteo 公开天气客户端
//
//   文件:       openMeteoClient.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { z } from 'zod'
import { PLATFORM_TECHNICAL_ID } from '@geo-agent-platform/shared-types/product-identity'

const MAX_RESPONSE_BYTES = 512 * 1024
const HOURS_PER_DAY = 24
const MAX_FORECAST_HOURS = 7 * HOURS_PER_DAY
const AIR_QUALITY_FORECAST_HOURS = 24

const nullableNumber = z.number().finite().nullable()
const geocodingCandidateSchema = z.object({
  name: z.string().min(1),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  country_code: z.string().optional(),
  country: z.string().optional(),
  admin1: z.string().optional(),
  admin2: z.string().optional(),
  timezone: z.string().optional(),
}).passthrough()
const geocodingResponseSchema = z.object({
  results: z.array(geocodingCandidateSchema).optional(),
}).passthrough()
const forecastResponseSchema = z.object({
  latitude: z.number().finite(),
  longitude: z.number().finite(),
  timezone: z.string().min(1),
  current: z.object({
    time: z.string().min(1),
    temperature_2m: nullableNumber,
    relative_humidity_2m: nullableNumber,
    dew_point_2m: nullableNumber,
    apparent_temperature: nullableNumber,
    is_day: nullableNumber,
    precipitation: nullableNumber,
    weather_code: nullableNumber,
    cloud_cover: nullableNumber,
    pressure_msl: nullableNumber,
    surface_pressure: nullableNumber,
    visibility: nullableNumber,
    wind_speed_10m: nullableNumber,
    wind_direction_10m: nullableNumber,
    wind_gusts_10m: nullableNumber,
  }).passthrough(),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: z.array(nullableNumber),
    relative_humidity_2m: z.array(nullableNumber),
    dew_point_2m: z.array(nullableNumber),
    apparent_temperature: z.array(nullableNumber),
    precipitation_probability: z.array(nullableNumber),
    precipitation: z.array(nullableNumber),
    rain: z.array(nullableNumber),
    showers: z.array(nullableNumber),
    snowfall: z.array(nullableNumber),
    weather_code: z.array(nullableNumber),
    pressure_msl: z.array(nullableNumber),
    cloud_cover: z.array(nullableNumber),
    visibility: z.array(nullableNumber),
    uv_index: z.array(nullableNumber),
    wind_speed_10m: z.array(nullableNumber),
    wind_direction_10m: z.array(nullableNumber),
    wind_gusts_10m: z.array(nullableNumber),
  }).passthrough(),
  daily: z.object({
    time: z.array(z.string()),
    weather_code: z.array(nullableNumber),
    temperature_2m_max: z.array(nullableNumber),
    temperature_2m_min: z.array(nullableNumber),
    apparent_temperature_max: z.array(nullableNumber),
    apparent_temperature_min: z.array(nullableNumber),
    sunrise: z.array(z.string()),
    sunset: z.array(z.string()),
    daylight_duration: z.array(nullableNumber),
    sunshine_duration: z.array(nullableNumber),
    uv_index_max: z.array(nullableNumber),
    rain_sum: z.array(nullableNumber),
    showers_sum: z.array(nullableNumber),
    snowfall_sum: z.array(nullableNumber),
    precipitation_sum: z.array(nullableNumber),
    precipitation_hours: z.array(nullableNumber),
    precipitation_probability_max: z.array(nullableNumber),
    wind_speed_10m_max: z.array(nullableNumber),
    wind_gusts_10m_max: z.array(nullableNumber),
    wind_direction_10m_dominant: z.array(nullableNumber),
  }).passthrough(),
}).passthrough()
const airQualityResponseSchema = z.object({
  current: z.object({
    time: z.string().min(1),
    us_aqi: nullableNumber,
    european_aqi: nullableNumber,
    pm2_5: nullableNumber,
    pm10: nullableNumber,
    carbon_monoxide: nullableNumber,
    nitrogen_dioxide: nullableNumber,
    sulphur_dioxide: nullableNumber,
    ozone: nullableNumber,
    aerosol_optical_depth: nullableNumber,
    dust: nullableNumber,
  }).passthrough(),
  hourly: z.object({
    time: z.array(z.string()),
    us_aqi: z.array(nullableNumber),
    european_aqi: z.array(nullableNumber),
    pm2_5: z.array(nullableNumber),
    pm10: z.array(nullableNumber),
    nitrogen_dioxide: z.array(nullableNumber),
    ozone: z.array(nullableNumber),
    dust: z.array(nullableNumber),
  }).passthrough(),
}).passthrough()

export interface OpenMeteoClientOptions {
  forecastBaseUrl: string
  geocodingBaseUrl: string
  airQualityBaseUrl: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}

export interface PublicWeatherQuery {
  location: string
  countryCode?: string
  forecastDays: number
  includeAirQuality: boolean
  coordinates?: { latitude: number; longitude: number }
}

export interface PublicWeatherSnapshot {
  source: {
    provider: 'Open-Meteo'
    weatherLicense: 'CC BY 4.0'
    weatherDocumentation: string
    airQualityDocumentation: string
  }
  location: {
    query: string
    name: string
    countryCode: string | null
    country: string | null
    admin1: string | null
    admin2: string | null
    latitude: number
    longitude: number
    timezone: string
  }
  current: {
    observedAt: string
    weatherCode: number | null
    weatherText: string
    temperatureC: number | null
    apparentTemperatureC: number | null
    relativeHumidityPercent: number | null
    dewPointC: number | null
    isDay: boolean | null
    precipitationMm: number | null
    cloudCoverPercent: number | null
    pressureMeanSeaLevelHpa: number | null
    surfacePressureHpa: number | null
    visibilityKm: number | null
    windSpeedKmh: number | null
    windDirectionDegrees: number | null
    windDirectionText: string | null
    windGustsKmh: number | null
  }
  hourly: Array<{
    forecastAt: string
    weatherCode: number | null
    weatherText: string
    temperatureC: number | null
    apparentTemperatureC: number | null
    relativeHumidityPercent: number | null
    dewPointC: number | null
    precipitationProbabilityPercent: number | null
    precipitationMm: number | null
    rainMm: number | null
    showersMm: number | null
    snowfallCm: number | null
    pressureMeanSeaLevelHpa: number | null
    cloudCoverPercent: number | null
    visibilityKm: number | null
    uvIndex: number | null
    windSpeedKmh: number | null
    windDirectionDegrees: number | null
    windDirectionText: string | null
    windGustsKmh: number | null
  }>
  daily: Array<{
    date: string
    weatherCode: number | null
    weatherText: string
    temperatureMaxC: number | null
    temperatureMinC: number | null
    apparentTemperatureMaxC: number | null
    apparentTemperatureMinC: number | null
    sunrise: string
    sunset: string
    daylightDurationHours: number | null
    sunshineDurationHours: number | null
    uvIndexMax: number | null
    rainSumMm: number | null
    showersSumMm: number | null
    snowfallSumCm: number | null
    precipitationSumMm: number | null
    precipitationHours: number | null
    precipitationProbabilityMaxPercent: number | null
    windSpeedMaxKmh: number | null
    windGustsMaxKmh: number | null
    dominantWindDirectionDegrees: number | null
    dominantWindDirectionText: string | null
  }>
  airQuality: {
    observedAt: string
    indexStandard: 'US EPA AQI'
    aqi: number | null
    category: string | null
    europeanAqi: number | null
    europeanCategory: string | null
    pm25MicrogramsPerCubicMeter: number | null
    pm10MicrogramsPerCubicMeter: number | null
    carbonMonoxideMicrogramsPerCubicMeter: number | null
    nitrogenDioxideMicrogramsPerCubicMeter: number | null
    sulphurDioxideMicrogramsPerCubicMeter: number | null
    ozoneMicrogramsPerCubicMeter: number | null
    aerosolOpticalDepth: number | null
    dustMicrogramsPerCubicMeter: number | null
    hourly: Array<{
      forecastAt: string
      usAqi: number | null
      usCategory: string | null
      europeanAqi: number | null
      europeanCategory: string | null
      pm25MicrogramsPerCubicMeter: number | null
      pm10MicrogramsPerCubicMeter: number | null
      nitrogenDioxideMicrogramsPerCubicMeter: number | null
      ozoneMicrogramsPerCubicMeter: number | null
      dustMicrogramsPerCubicMeter: number | null
    }>
  } | null
  retrievedAt: string
  limitations: string[]
  warnings: string[]
}

export interface PublicWeatherClient {
  query(input: PublicWeatherQuery, signal: AbortSignal): Promise<PublicWeatherSnapshot>
}

/** 固定调用 Open-Meteo 的地理编码、预报和空气质量端点，不接受任意远程 URL。 */
export class OpenMeteoClient implements PublicWeatherClient {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: OpenMeteoClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async query(input: PublicWeatherQuery, signal: AbortSignal): Promise<PublicWeatherSnapshot> {
    const resolved = input.coordinates
      ? {
          name: input.location,
          latitude: input.coordinates.latitude,
          longitude: input.coordinates.longitude,
          country_code: undefined,
          country: undefined,
          admin1: undefined,
          admin2: undefined,
          timezone: undefined,
        }
      : await this.resolveLocation(input.location, input.countryCode, signal)

    const warnings: string[] = []
    const forecastPromise = this.fetchForecast(
      resolved.latitude,
      resolved.longitude,
      input.forecastDays,
      signal,
    )
    const airQualityPromise = input.includeAirQuality
      ? this.fetchAirQuality(resolved.latitude, resolved.longitude, signal).catch(error => {
          if (signal.aborted) throw error
          warnings.push('空气质量数据暂不可用；天气实况和预报仍然有效。')
          return null
        })
      : Promise.resolve(null)
    const [forecast, airQualityResponse] = await Promise.all([forecastPromise, airQualityPromise])

    return {
      source: {
        provider: 'Open-Meteo',
        weatherLicense: 'CC BY 4.0',
        weatherDocumentation: 'https://open-meteo.com/en/docs',
        airQualityDocumentation: 'https://open-meteo.com/en/docs/air-quality-api',
      },
      location: {
        query: input.location,
        name: resolved.name,
        countryCode: resolved.country_code ?? null,
        country: resolved.country ?? null,
        admin1: resolved.admin1 ?? null,
        admin2: resolved.admin2 ?? null,
        latitude: forecast.latitude,
        longitude: forecast.longitude,
        timezone: forecast.timezone,
      },
      current: {
        observedAt: forecast.current.time,
        weatherCode: forecast.current.weather_code,
        weatherText: weatherCodeText(forecast.current.weather_code),
        temperatureC: forecast.current.temperature_2m,
        apparentTemperatureC: forecast.current.apparent_temperature,
        relativeHumidityPercent: forecast.current.relative_humidity_2m,
        dewPointC: forecast.current.dew_point_2m,
        isDay: booleanFromBinary(forecast.current.is_day),
        precipitationMm: forecast.current.precipitation,
        cloudCoverPercent: forecast.current.cloud_cover,
        pressureMeanSeaLevelHpa: forecast.current.pressure_msl,
        surfacePressureHpa: forecast.current.surface_pressure,
        visibilityKm: kilometers(forecast.current.visibility),
        windSpeedKmh: forecast.current.wind_speed_10m,
        windDirectionDegrees: forecast.current.wind_direction_10m,
        windDirectionText: windDirectionText(forecast.current.wind_direction_10m),
        windGustsKmh: forecast.current.wind_gusts_10m,
      },
      hourly: normalizeHourly(forecast.hourly, input.forecastDays),
      daily: normalizeDaily(forecast.daily, input.forecastDays),
      airQuality: airQualityResponse
        ? {
            observedAt: airQualityResponse.current.time,
            indexStandard: 'US EPA AQI',
            aqi: airQualityResponse.current.us_aqi,
            category: aqiCategory(airQualityResponse.current.us_aqi),
            europeanAqi: airQualityResponse.current.european_aqi,
            europeanCategory: europeanAqiCategory(airQualityResponse.current.european_aqi),
            pm25MicrogramsPerCubicMeter: airQualityResponse.current.pm2_5,
            pm10MicrogramsPerCubicMeter: airQualityResponse.current.pm10,
            carbonMonoxideMicrogramsPerCubicMeter: airQualityResponse.current.carbon_monoxide,
            nitrogenDioxideMicrogramsPerCubicMeter: airQualityResponse.current.nitrogen_dioxide,
            sulphurDioxideMicrogramsPerCubicMeter: airQualityResponse.current.sulphur_dioxide,
            ozoneMicrogramsPerCubicMeter: airQualityResponse.current.ozone,
            aerosolOpticalDepth: airQualityResponse.current.aerosol_optical_depth,
            dustMicrogramsPerCubicMeter: airQualityResponse.current.dust,
            hourly: normalizeAirQualityHourly(airQualityResponse.hourly),
          }
        : null,
      retrievedAt: new Date().toISOString(),
      limitations: [
        '天气数据属于数值模式和公开数据服务结果，不等同于当地气象主管机构发布的实况、预警或应急指令。',
        '空气质量提供 US EPA AQI 与 European AQI 口径；二者都不是中国法定 AQI，涉及中国法定评价时应改用生态环境主管部门数据。',
      ],
      warnings,
    }
  }

  private async resolveLocation(location: string, countryCode: string | undefined, signal: AbortSignal) {
    const url = endpoint(this.options.geocodingBaseUrl, '/v1/search')
    url.searchParams.set('name', location)
    url.searchParams.set('count', '5')
    url.searchParams.set('language', 'zh')
    if (countryCode) url.searchParams.set('countryCode', countryCode)
    const response = await this.fetchJson(url, geocodingResponseSchema, '天气地点解析', signal)
    const candidate = response.results?.[0]
    if (!candidate) {
      throw new WeatherServiceError(`没有找到天气地点“${location}”。请先使用地点地理编码工具获取坐标，或改用城市、区县的标准名称。`)
    }
    return candidate
  }

  private fetchForecast(latitude: number, longitude: number, forecastDays: number, signal: AbortSignal) {
    const url = endpoint(this.options.forecastBaseUrl, '/v1/forecast')
    url.searchParams.set('latitude', String(latitude))
    url.searchParams.set('longitude', String(longitude))
    url.searchParams.set('current', [
      'temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'apparent_temperature', 'is_day',
      'precipitation', 'weather_code', 'cloud_cover', 'pressure_msl', 'surface_pressure',
      'visibility', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
    ].join(','))
    url.searchParams.set('hourly', [
      'temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'apparent_temperature',
      'precipitation_probability', 'precipitation', 'rain', 'showers', 'snowfall', 'weather_code',
      'pressure_msl', 'cloud_cover', 'visibility', 'uv_index', 'wind_speed_10m',
      'wind_direction_10m', 'wind_gusts_10m',
    ].join(','))
    url.searchParams.set('daily', [
      'weather_code', 'temperature_2m_max', 'temperature_2m_min',
      'apparent_temperature_max', 'apparent_temperature_min', 'sunrise', 'sunset',
      'daylight_duration', 'sunshine_duration', 'uv_index_max', 'rain_sum', 'showers_sum',
      'snowfall_sum', 'precipitation_sum', 'precipitation_hours', 'precipitation_probability_max',
      'wind_speed_10m_max', 'wind_gusts_10m_max', 'wind_direction_10m_dominant',
    ].join(','))
    url.searchParams.set('forecast_days', String(forecastDays))
    url.searchParams.set('forecast_hours', String(forecastHoursForDays(forecastDays)))
    url.searchParams.set('timezone', 'auto')
    url.searchParams.set('temperature_unit', 'celsius')
    url.searchParams.set('wind_speed_unit', 'kmh')
    url.searchParams.set('precipitation_unit', 'mm')
    return this.fetchJson(url, forecastResponseSchema, '公开天气查询', signal)
  }

  private fetchAirQuality(latitude: number, longitude: number, signal: AbortSignal) {
    const url = endpoint(this.options.airQualityBaseUrl, '/v1/air-quality')
    url.searchParams.set('latitude', String(latitude))
    url.searchParams.set('longitude', String(longitude))
    const variables = [
      'us_aqi', 'european_aqi', 'pm2_5', 'pm10', 'carbon_monoxide', 'nitrogen_dioxide',
      'sulphur_dioxide', 'ozone', 'aerosol_optical_depth', 'dust',
    ]
    url.searchParams.set('current', variables.join(','))
    url.searchParams.set('hourly', [
      'us_aqi', 'european_aqi', 'pm2_5', 'pm10', 'nitrogen_dioxide', 'ozone', 'dust',
    ].join(','))
    url.searchParams.set('forecast_hours', String(AIR_QUALITY_FORECAST_HOURS))
    url.searchParams.set('timezone', 'auto')
    return this.fetchJson(url, airQualityResponseSchema, '公开空气质量查询', signal)
  }

  private async fetchJson<T>(
    url: URL,
    schema: z.ZodType<T>,
    label: string,
    signal: AbortSignal,
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs)
    const requestSignal = AbortSignal.any([signal, timeoutSignal])
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': `${PLATFORM_TECHNICAL_ID}/0.1 public-weather` },
        signal: requestSignal,
      })
    } catch (error) {
      if (signal.aborted) throw new WeatherServiceError(`${label}已取消。`, { cause: error })
      if (timeoutSignal.aborted) throw new WeatherServiceError(`${label}超时。`, { cause: error })
      throw new WeatherServiceError(`${label}网络请求失败。`, { cause: error })
    }
    if (!response.ok) throw new WeatherServiceError(`${label}失败（HTTP ${response.status}）。`)
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new WeatherServiceError(`${label}响应超过大小限制。`)
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.includes('application/json')) throw new WeatherServiceError(`${label}返回了非 JSON 响应。`)
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new WeatherServiceError(`${label}响应超过大小限制。`)
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch (error) {
      throw new WeatherServiceError(`${label}返回了无效 JSON。`, { cause: error })
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success) throw new WeatherServiceError(`${label}响应字段不符合契约。`)
    return parsed.data
  }
}

class WeatherServiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WeatherServiceError'
  }
}

function endpoint(baseUrl: string, pathname: string): URL {
  const base = new URL(baseUrl)
  base.pathname = pathname
  base.search = ''
  base.hash = ''
  return base
}

function normalizeHourly(
  hourly: z.infer<typeof forecastResponseSchema>['hourly'],
  forecastDays: number,
): PublicWeatherSnapshot['hourly'] {
  const length = Math.min(forecastHoursForDays(forecastDays), hourly.time.length)
  return Array.from({ length }, (_, index) => {
    const code = valueAt(hourly.weather_code, index)
    return {
      forecastAt: hourly.time[index] ?? '',
      weatherCode: code,
      weatherText: weatherCodeText(code),
      temperatureC: valueAt(hourly.temperature_2m, index),
      apparentTemperatureC: valueAt(hourly.apparent_temperature, index),
      relativeHumidityPercent: valueAt(hourly.relative_humidity_2m, index),
      dewPointC: valueAt(hourly.dew_point_2m, index),
      precipitationProbabilityPercent: valueAt(hourly.precipitation_probability, index),
      precipitationMm: valueAt(hourly.precipitation, index),
      rainMm: valueAt(hourly.rain, index),
      showersMm: valueAt(hourly.showers, index),
      snowfallCm: valueAt(hourly.snowfall, index),
      pressureMeanSeaLevelHpa: valueAt(hourly.pressure_msl, index),
      cloudCoverPercent: valueAt(hourly.cloud_cover, index),
      visibilityKm: kilometers(valueAt(hourly.visibility, index)),
      uvIndex: valueAt(hourly.uv_index, index),
      windSpeedKmh: valueAt(hourly.wind_speed_10m, index),
      windDirectionDegrees: valueAt(hourly.wind_direction_10m, index),
      windDirectionText: windDirectionText(valueAt(hourly.wind_direction_10m, index)),
      windGustsKmh: valueAt(hourly.wind_gusts_10m, index),
    }
  })
}

function normalizeDaily(
  daily: z.infer<typeof forecastResponseSchema>['daily'],
  forecastDays: number,
): PublicWeatherSnapshot['daily'] {
  const length = Math.min(forecastDays, daily.time.length)
  return Array.from({ length }, (_, index) => {
    const code = valueAt(daily.weather_code, index)
    return {
      date: daily.time[index] ?? '',
      weatherCode: code,
      weatherText: weatherCodeText(code),
      temperatureMaxC: valueAt(daily.temperature_2m_max, index),
      temperatureMinC: valueAt(daily.temperature_2m_min, index),
      apparentTemperatureMaxC: valueAt(daily.apparent_temperature_max, index),
      apparentTemperatureMinC: valueAt(daily.apparent_temperature_min, index),
      sunrise: daily.sunrise[index] ?? '',
      sunset: daily.sunset[index] ?? '',
      daylightDurationHours: hoursFromSeconds(valueAt(daily.daylight_duration, index)),
      sunshineDurationHours: hoursFromSeconds(valueAt(daily.sunshine_duration, index)),
      uvIndexMax: valueAt(daily.uv_index_max, index),
      rainSumMm: valueAt(daily.rain_sum, index),
      showersSumMm: valueAt(daily.showers_sum, index),
      snowfallSumCm: valueAt(daily.snowfall_sum, index),
      precipitationSumMm: valueAt(daily.precipitation_sum, index),
      precipitationHours: valueAt(daily.precipitation_hours, index),
      precipitationProbabilityMaxPercent: valueAt(daily.precipitation_probability_max, index),
      windSpeedMaxKmh: valueAt(daily.wind_speed_10m_max, index),
      windGustsMaxKmh: valueAt(daily.wind_gusts_10m_max, index),
      dominantWindDirectionDegrees: valueAt(daily.wind_direction_10m_dominant, index),
      dominantWindDirectionText: windDirectionText(valueAt(daily.wind_direction_10m_dominant, index)),
    }
  })
}

function normalizeAirQualityHourly(
  hourly: z.infer<typeof airQualityResponseSchema>['hourly'],
): NonNullable<PublicWeatherSnapshot['airQuality']>['hourly'] {
  const length = Math.min(AIR_QUALITY_FORECAST_HOURS, hourly.time.length)
  return Array.from({ length }, (_, index) => {
    const usAqi = valueAt(hourly.us_aqi, index)
    const europeanAqi = valueAt(hourly.european_aqi, index)
    return {
      forecastAt: hourly.time[index] ?? '',
      usAqi,
      usCategory: aqiCategory(usAqi),
      europeanAqi,
      europeanCategory: europeanAqiCategory(europeanAqi),
      pm25MicrogramsPerCubicMeter: valueAt(hourly.pm2_5, index),
      pm10MicrogramsPerCubicMeter: valueAt(hourly.pm10, index),
      nitrogenDioxideMicrogramsPerCubicMeter: valueAt(hourly.nitrogen_dioxide, index),
      ozoneMicrogramsPerCubicMeter: valueAt(hourly.ozone, index),
      dustMicrogramsPerCubicMeter: valueAt(hourly.dust, index),
    }
  })
}

function forecastHoursForDays(forecastDays: number): number {
  return Math.min(
    MAX_FORECAST_HOURS,
    Math.max(HOURS_PER_DAY, Math.trunc(forecastDays) * HOURS_PER_DAY),
  )
}

function valueAt(values: Array<number | null>, index: number): number | null {
  return values[index] ?? null
}

function kilometers(meters: number | null): number | null {
  return meters === null ? null : meters / 1_000
}

function hoursFromSeconds(seconds: number | null): number | null {
  return seconds === null ? null : seconds / 3_600
}

function booleanFromBinary(value: number | null): boolean | null {
  return value === null ? null : value >= 0.5
}

function weatherCodeText(code: number | null): string {
  if (code === null) return '未知'
  const labels: Record<number, string> = {
    0: '晴', 1: '大致晴朗', 2: '局部多云', 3: '阴', 45: '雾', 48: '雾凇',
    51: '小毛毛雨', 53: '毛毛雨', 55: '强毛毛雨', 56: '轻微冻毛毛雨', 57: '强冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '轻微冻雨', 67: '强冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪', 80: '小阵雨', 81: '阵雨', 82: '强阵雨',
    85: '小阵雪', 86: '强阵雪', 95: '雷暴', 96: '雷暴伴小冰雹', 99: '雷暴伴强冰雹',
  }
  return labels[Math.trunc(code)] ?? `未知天气代码 ${code}`
}

function windDirectionText(degrees: number | null): string | null {
  if (degrees === null) return null
  const labels = ['北', '北东北', '东北', '东东北', '东', '东东南', '东南', '南东南', '南', '南西南', '西南', '西西南', '西', '西西北', '西北', '北西北']
  const normalized = ((degrees % 360) + 360) % 360
  return `${labels[Math.round(normalized / 22.5) % 16] ?? '未知'}风`
}

function aqiCategory(value: number | null): string | null {
  if (value === null) return null
  if (value <= 50) return '优'
  if (value <= 100) return '良'
  if (value <= 150) return '对敏感人群不健康'
  if (value <= 200) return '不健康'
  if (value <= 300) return '非常不健康'
  return '危险'
}

function europeanAqiCategory(value: number | null): string | null {
  if (value === null) return null
  if (value <= 20) return '良好'
  if (value <= 40) return '尚可'
  if (value <= 60) return '中等'
  if (value <= 80) return '较差'
  if (value <= 100) return '很差'
  return '极差'
}

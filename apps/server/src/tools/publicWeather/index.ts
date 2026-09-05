// +-------------------------------------------------------------------------
//
//   地理智能平台 - 公开天气 ToolProvider
//
//   文件:       index.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import manifest from './manifest.json' with { type: 'json' }

import type { Env } from '../../framework/env.js'
import { parseToolManifest } from '../../framework/schema.js'
import type { ToolProvider } from '../../framework/types.js'
import { createPublicWeatherTool } from './handler.js'
import { OpenMeteoClient } from './openMeteoClient.js'

const toolManifest = parseToolManifest(manifest)

export function createPublicWeatherProvider(env: Env): ToolProvider {
  const client = new OpenMeteoClient({
    forecastBaseUrl: env.OPEN_METEO_FORECAST_BASE_URL,
    geocodingBaseUrl: env.OPEN_METEO_GEOCODING_BASE_URL,
    airQualityBaseUrl: env.OPEN_METEO_AIR_QUALITY_BASE_URL,
    timeoutMs: env.OPEN_METEO_TIMEOUT_MS,
  })
  return {
    manifest: toolManifest,
    tools: () => [createPublicWeatherTool(client)],
  }
}

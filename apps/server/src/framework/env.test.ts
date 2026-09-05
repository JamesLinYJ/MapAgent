// +-------------------------------------------------------------------------
//
//   地理智能平台 - 环境配置测试
//
//   文件:       env.test.ts
//
//   日期:       2026年07月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'
import { parseEnv } from './env.js'

describe('parseEnv', () => {
  it('uses secure authentication defaults when deployment env is not explicit', () => {
    const env = parseEnv(minimalEnv())

    expect(env.BETTER_AUTH_ALLOW_SIGN_UP).toBe(false)
    expect(env.BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION).toBe(true)
    expect(env.OPEN_METEO_FORECAST_BASE_URL).toBe('https://api.open-meteo.com')
    expect(env.OPEN_METEO_GEOCODING_BASE_URL).toBe('https://geocoding-api.open-meteo.com')
    expect(env.OPEN_METEO_AIR_QUALITY_BASE_URL).toBe('https://air-quality-api.open-meteo.com')
    expect(env.OPEN_METEO_TIMEOUT_MS).toBe(10_000)
  })

  it('accepts the SDK Docker sandbox backend as an explicit deployment choice', () => {
    expect(parseEnv({
      ...minimalEnv(),
      SANDBOX_BACKEND: 'sdk_docker',
    }).SANDBOX_BACKEND).toBe('sdk_docker')
  })

  it('discards inherited Provider API keys instead of admitting them to server configuration', () => {
    let reads = 0
    const input = minimalEnv()
    for (const name of [
      'DEEPSEEK_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'OPENAI_API_KEY',
    ]) {
      Object.defineProperty(input, name, {
        enumerable: true,
        get: () => {
          reads += 1
          return 'must-not-be-read'
        },
      })
    }
    const env = parseEnv(input)

    expect(env).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(env).not.toHaveProperty('GEMINI_API_KEY')
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(reads).toBe(0)
  })
})

function minimalEnv(): NodeJS.ProcessEnv {
  return {
    API_PORT: '8000',
    API_HOST: '127.0.0.1',
    DATABASE_URL: 'postgres://geo_agent:geo_agent@localhost:5432/geo_agent',
    RUNTIME_ROOT: 'runtime',
    APP_BASE_URL: 'http://localhost:8000',
    BETTER_AUTH_URL: 'http://localhost:8000',
    BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
    ENABLED_TOOL_PROVIDERS: 'geo-platform-plan',
  }
}

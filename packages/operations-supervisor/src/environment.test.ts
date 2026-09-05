// +-------------------------------------------------------------------------
//
//   地理智能平台 - 受监督环境隔离测试
//
//   文件:       environment.test.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import {
  environmentWithoutSystemCredentials,
  environmentForConcurrently,
  environmentForService,
  projectSupervisorEnvironment,
  utilityProcessEnvironment,
} from './environment.js'

describe('service environment isolation', () => {
  it('never passes provider, supervisor or local-root secrets to child services', () => {
    const result = environmentForService('api', {
      PATH: 'test-path',
      API_PORT: '8000',
      OPENAI_API_KEY: 'provider-secret',
      OPEN_METEO_TIMEOUT_MS: '10000',
      GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN: 'supervisor-secret',
      GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET: 'root-secret',
      NODE_OPTIONS: '--require malicious-hook.js',
      WEB_DEV_PORT: '5173',
      UNRELATED_SECRET: 'unrelated-secret',
    }, { GEO_AGENT_PLATFORM_ROOT: 'C:\\project' })

    expect(result).toMatchObject({
      PATH: 'test-path',
      API_PORT: '8000',
      OPEN_METEO_TIMEOUT_MS: '10000',
    })
    expect(result).not.toHaveProperty('OPENAI_API_KEY')
    expect(result).not.toHaveProperty('GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN')
    expect(result).not.toHaveProperty('GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET')
    expect(result).not.toHaveProperty('NODE_OPTIONS')
    expect(result).not.toHaveProperty('WEB_DEV_PORT')
    expect(result).not.toHaveProperty('UNRELATED_SECRET')
  })

  it('passes every fixed input required by the native infrastructure launcher', () => {
    const result = environmentForService('infra', {
      DATABASE_URL: 'postgresql://geo_agent:secret@127.0.0.1:55432/geo_agent',
      POSTGIS_PORT: '55432',
      POSTGRES_BIN_DIR: 'C:\\Program Files\\PostgreSQL\\18\\bin',
      POSTGRES_DATA_DIR: 'C:\\runtime\\postgresql',
      ProgramFiles: 'C:\\Program Files',
      GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN: 'must-not-leak',
    }, {
      GEO_AGENT_PLATFORM_ROOT: 'C:\\project',
      RUNTIME_ROOT: 'C:\\runtime',
    })

    expect(result).toMatchObject({
      DATABASE_URL: 'postgresql://geo_agent:secret@127.0.0.1:55432/geo_agent',
      POSTGIS_PORT: '55432',
      POSTGRES_BIN_DIR: 'C:\\Program Files\\PostgreSQL\\18\\bin',
      POSTGRES_DATA_DIR: 'C:\\runtime\\postgresql',
      ProgramFiles: 'C:\\Program Files',
      GEO_AGENT_PLATFORM_ROOT: 'C:\\project',
      RUNTIME_ROOT: 'C:\\runtime',
    })
    expect(result).not.toHaveProperty('GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN')
  })

  it('passes the complete fixed API runtime configuration surface', () => {
    const apiEnvironmentNames = [
      'API_PORT',
      'API_HOST',
      'DATABASE_URL',
      'RUNTIME_ROOT',
      'APP_BASE_URL',
      'BETTER_AUTH_URL',
      'BETTER_AUTH_SECRET',
      'BETTER_AUTH_ALLOW_SIGN_UP',
      'BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION',
      'BETTER_AUTH_MIN_PASSWORD_LENGTH',
      'CSRF_HEADER_NAME',
      'BOOTSTRAP_ADMIN_EMAIL',
      'TRUSTED_ORIGINS',
      'SEED_LAYERS_DIR',
      'MAX_FILE_UPLOAD_BYTES',
      'MAX_GEOJSON_UPLOAD_BYTES',
      'MAX_METEOROLOGY_UPLOAD_BYTES',
      'MAX_GEOJSON_FEATURES',
      'MAX_GEOJSON_COORDINATES',
      'MAP_TILE_TIMEOUT_MS',
      'DEFAULT_MODEL_PROVIDER',
      'DEFAULT_MODEL_NAME',
      'DEEPSEEK_BASE_URL',
      'DEEPSEEK_MODEL',
      'DEEPSEEK_TOOL_SCHEMA_MODE',
      'DEEPSEEK_RESULT_CACHE_ENABLED',
      'DEEPSEEK_RESULT_CACHE_TTL_SECONDS',
      'DEEPSEEK_RESULT_CACHE_MAX_BYTES',
      'USAGE_DAILY_TOTAL_TOKEN_LIMIT',
      'USAGE_MONTHLY_TOTAL_TOKEN_LIMIT',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_VERSION',
      'GEMINI_BASE_URL',
      'GEMINI_MODEL',
      'OLLAMA_BASE_URL',
      'OLLAMA_MODEL',
      'WORKER_URL',
      'WORKER_SHARED_SECRET',
      'WORKER_MAX_CONCURRENCY',
      'WORKER_REQUEST_TIMEOUT_MS',
      'AZURE_SPEECH_KEY',
      'AZURE_SPEECH_REGION',
      'AZURE_SPEECH_ENDPOINT',
      'AZURE_SPEECH_DEFAULT_LANGUAGE',
      'AZURE_SPEECH_SUPPORTED_LANGUAGES',
      'AZURE_SPEECH_DEFAULT_VOICE',
      'SANDBOX_BACKEND',
      'ENABLED_TOOL_PROVIDERS',
      'DEVELOPER_TOOL_ALLOWED_ROOTS',
      'OPEN_METEO_FORECAST_BASE_URL',
      'OPEN_METEO_GEOCODING_BASE_URL',
      'OPEN_METEO_AIR_QUALITY_BASE_URL',
      'OPEN_METEO_TIMEOUT_MS',
      'VALHALLA_BASE_URL',
      'ROUTING_TIMEOUT_MS',
      'TIANDITU_API_KEY',
      'GEO_AGENT_PLATFORM_MEMORY_BASE_DIR',
      'RIPGREP_PATH',
      'RG_PATH',
      'GEO_AGENT_PLATFORM_RELEASE_ID',
    ] as const
    const source = Object.fromEntries(apiEnvironmentNames.map(name => [name, `value-for-${name}`]))

    const result = environmentForService('api', source, {})

    expect(Object.keys(result).sort()).toEqual([...apiEnvironmentNames].sort())
  })

  it('does not read inherited Provider credential values while projecting child environments', () => {
    let reads = 0
    const source = {
      PATH: 'test-path',
      API_PORT: '8000',
    } as NodeJS.ProcessEnv
    Object.defineProperty(source, 'DEEPSEEK_API_KEY', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'must-not-be-read'
      },
    })

    expect(environmentForService('api', source, {})).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(projectSupervisorEnvironment(source)).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(reads).toBe(0)
  })

  it('projects only explicit service secrets and never reads unrelated system secrets', () => {
    let unrelatedReads = 0
    const source = {
      API_PORT: '8000',
      BETTER_AUTH_SECRET: 'explicit-service-secret',
    } as NodeJS.ProcessEnv
    Object.defineProperty(source, 'UNRELATED_TOKEN', {
      enumerable: true,
      get: () => {
        unrelatedReads += 1
        return 'must-not-be-read'
      },
    })

    expect(projectSupervisorEnvironment(source)).toEqual({
      API_PORT: '8000',
      BETTER_AUTH_SECRET: 'explicit-service-secret',
    })
    expect(unrelatedReads).toBe(0)
  })

  it('removes system and signing credentials before reading their values', () => {
    let reads = 0
    const source = {
      PATH: 'test-path',
      DATABASE_URL: 'postgresql://local:secret@127.0.0.1:55432/platform',
      API_PORT: '8000',
    } as NodeJS.ProcessEnv
    for (const name of ['UNRELATED_PASSWORD', 'CSC_LINK', 'NPM_CONFIG_USERCONFIG']) {
      Object.defineProperty(source, name, {
        enumerable: true,
        get: () => {
          reads += 1
          return 'must-not-be-read'
        },
      })
    }

    expect(environmentWithoutSystemCredentials(source)).toEqual({
      PATH: 'test-path',
      DATABASE_URL: 'postgresql://local:secret@127.0.0.1:55432/platform',
      API_PORT: '8000',
    })
    expect(reads).toBe(0)
  })

  it('gives ACL helpers only the minimum non-secret process environment', () => {
    const result = utilityProcessEnvironment({
      PATH: 'test-path',
      SystemRoot: 'C:\\Windows',
      LANG: 'zh_CN.UTF-8',
      DATABASE_URL: 'postgresql://local:secret@127.0.0.1:55432/platform',
      API_PORT: '8000',
      GEO_AGENT_PLATFORM_OPERATORS_PRINCIPAL: 'MapAgents Operators',
      BETTER_AUTH_SECRET: 'must-not-leak',
    })

    expect(result).toEqual({
      PATH: 'test-path',
      SystemRoot: 'C:\\Windows',
      LANG: 'zh_CN.UTF-8',
      GEO_AGENT_PLATFORM_OPERATORS_PRINCIPAL: 'MapAgents Operators',
    })
  })

  it('masks parent-only values when concurrently merges its inherited environment', () => {
    const parent = { PATH: process.env.PATH, GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN: 'must-not-leak' }
    const allowed = { PATH: process.env.PATH, API_PORT: '8000' }
    const adapterEnvironment = environmentForConcurrently(parent, allowed)
    const merged = { ...parent, ...adapterEnvironment }
    const child = spawnSync(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify({token:process.env.GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN ?? null,port:process.env.API_PORT}))',
    ], { env: merged, encoding: 'utf8' })

    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({ token: null, port: '8000' })
  })
})

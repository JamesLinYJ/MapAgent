// +-------------------------------------------------------------------------
//
//   地理智能平台 - 环境配置（零默认值，严格校验）
//
//   文件:       env.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { z } from 'zod'
import {
  PLATFORM_DESKTOP_APP_ORIGIN,
  PLATFORM_DESKTOP_AUTH_CALLBACK_URL,
} from '@geo-agent-platform/shared-types/product-identity'
import { errorLogPayload, logger } from '../observability/logger.js'

const booleanEnvSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return value
}, z.boolean())

const envSchema = z.object({
  API_PORT: z.coerce.number(),
  API_HOST: z.string(),
  GEO_AGENT_PLATFORM_RELEASE_ID: z.string().trim().min(1).optional(),
  DATABASE_URL: z.string(),
  RUNTIME_ROOT: z.string(),
  APP_BASE_URL: z.string().url(),
  BETTER_AUTH_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_ALLOW_SIGN_UP: booleanEnvSchema.default(false),
  BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION: booleanEnvSchema.default(true),
  BETTER_AUTH_MIN_PASSWORD_LENGTH: z.coerce.number().int().min(8).default(12),
  CSRF_HEADER_NAME: z.string().min(1).default('x-geo-agent-platform-csrf'),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  TRUSTED_ORIGINS: z.string().default(
    `${PLATFORM_DESKTOP_APP_ORIGIN},${PLATFORM_DESKTOP_AUTH_CALLBACK_URL}`,
  ),
  SEED_LAYERS_DIR: z.string().optional(),
  MAX_FILE_UPLOAD_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  MAX_GEOJSON_UPLOAD_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  MAX_METEOROLOGY_UPLOAD_BYTES: z.coerce.number().int().positive().default(500 * 1024 * 1024),
  MAX_GEOJSON_FEATURES: z.coerce.number().int().positive().default(50_000),
  MAX_GEOJSON_COORDINATES: z.coerce.number().int().positive().default(2_000_000),
  MAP_TILE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // 模型 providers（至少一个）
  DEFAULT_MODEL_PROVIDER: z.string().optional(),
  DEFAULT_MODEL_NAME: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().optional(),
  DEEPSEEK_MODEL: z.string().optional(),
  DEEPSEEK_TOOL_SCHEMA_MODE: z.enum(['strict', 'compatible']).default('compatible'),
  DEEPSEEK_RESULT_CACHE_ENABLED: booleanEnvSchema.default(true),
  DEEPSEEK_RESULT_CACHE_TTL_SECONDS: z.coerce.number().int().positive().max(7 * 24 * 60 * 60).default(24 * 60 * 60),
  DEEPSEEK_RESULT_CACHE_MAX_BYTES: z.coerce.number().int().positive().max(1024 * 1024).default(256 * 1024),
  USAGE_DAILY_TOTAL_TOKEN_LIMIT: z.coerce.number().int().nonnegative().default(0),
  USAGE_MONTHLY_TOTAL_TOKEN_LIMIT: z.coerce.number().int().nonnegative().default(0),

  ANTHROPIC_BASE_URL: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  ANTHROPIC_VERSION: z.string().optional(),

  GEMINI_BASE_URL: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),

  OLLAMA_BASE_URL: z.string().optional(),
  OLLAMA_MODEL: z.string().optional(),

  // Python sidecar + Python tools
  WORKER_URL: z.string().optional(),
  WORKER_SHARED_SECRET: z.string().min(32).optional(),
  WORKER_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  AZURE_SPEECH_KEY: z.string().optional(),
  AZURE_SPEECH_REGION: z.string().default('eastasia'),
  AZURE_SPEECH_ENDPOINT: z.string().url().default('https://eastasia.api.cognitive.microsoft.com'),
  AZURE_SPEECH_DEFAULT_LANGUAGE: z.string().default('zh-CN'),
  AZURE_SPEECH_SUPPORTED_LANGUAGES: z.string().default('zh-CN,en-US,ja-JP,ko-KR'),
  AZURE_SPEECH_DEFAULT_VOICE: z.string().default('zh-CN-XiaoxiaoNeural'),
  SANDBOX_BACKEND: z.enum(['disabled', 'unix_local', 'sdk_docker']).default('disabled'),
  ENABLED_TOOL_PROVIDERS: z.string(),
  DEVELOPER_TOOL_ALLOWED_ROOTS: z.string().optional(),
  OPEN_METEO_FORECAST_BASE_URL: z.string().url().default('https://api.open-meteo.com'),
  OPEN_METEO_GEOCODING_BASE_URL: z.string().url().default('https://geocoding-api.open-meteo.com'),
  OPEN_METEO_AIR_QUALITY_BASE_URL: z.string().url().default('https://air-quality-api.open-meteo.com'),
  OPEN_METEO_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  VALHALLA_BASE_URL: z.string().url().optional(),
  ROUTING_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // Tianditu
  TIANDITU_API_KEY: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

let _env: Env | null = null

export function getEnv(): Env {
  if (_env) return _env
  try {
    _env = parseEnv(process.env)
  } catch (error) {
    logger.fatal({ error: errorLogPayload(error) }, '环境变量校验失败——服务启动中止')
    process.exit(1)
  }
  return _env
}

export function parseEnv(input: NodeJS.ProcessEnv): Env {
  // 只按声明字段读取环境值。尤其不能把完整 process.env 交给边界解析器后再
  // 丢弃未知字段，否则旧 Provider/系统凭据仍可能在解析阶段被访问。
  const declaredInput: NodeJS.ProcessEnv = {}
  for (const name of Object.keys(envSchema.shape)) {
    const value = input[name]
    if (value !== undefined) declaredInput[name] = value
  }
  const result = envSchema.safeParse(declaredInput)
  if (!result.success) {
    const details = result.error.issues.map(issue => {
      const field = issue.path.join('.') || 'environment'
      return `${field}: ${issue.message}`
    })
    throw new Error(details.join('；'))
  }
  return result.data
}

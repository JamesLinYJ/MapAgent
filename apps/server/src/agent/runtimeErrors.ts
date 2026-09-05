// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agents SDK 稳定错误映射
//
//   文件:       runtimeErrors.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  MaxTurnsExceededError,
  ModelBehaviorError,
  ToolTimeoutError,
  UserError,
} from '@openai/agents'
import type { RunFailure, RunFailureSource } from '../schemas/types.js'

export function runtimeFailureMessage(error: unknown): string {
  return runtimeFailure(error).message
}

export function runtimeFailure(
  error: unknown,
  context: { failedTool?: string | null } = {},
): RunFailure {
  const declaredSource = declaredFailureSource(error)
  if (error instanceof MaxTurnsExceededError) {
    return failure('platform', '智能体已达到最大运行轮次，为避免循环调用已停止。', 'max_turns_exceeded')
  }
  if (error instanceof ToolTimeoutError) {
    return failure('tool', '工具执行超时，运行已停止；请检查依赖服务后重试。', 'tool_timeout', true)
  }
  if (error instanceof ModelBehaviorError) {
    return failure('model', '模型返回了不符合 Agent 协议的内容，运行已停止。', 'model_protocol_error')
  }
  if (error instanceof UserError) {
    return failure(
      declaredSource ?? 'platform',
      stableChineseMessage(
        error.message,
        'Agents SDK 拒绝了当前运行配置或恢复状态；请查看服务端日志。',
      ),
      errorCode(error),
    )
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return failure('transport', '运行已取消。', 'aborted')
  }
  if (error instanceof Error && /sandbox|manifest|backend|session state/iu.test(error.message)) {
    return failure(
      declaredSource ?? 'platform',
      stableChineseMessage(error.message, 'Sandbox 创建或恢复失败；请检查后端配置和服务日志。'),
      errorCode(error),
    )
  }
  if (error instanceof Error) {
    const source = declaredSource
      ?? databaseFailureSource(error)
      ?? modelFailureSource(error)
      ?? (context.failedTool ? toolFailureSource(error) : null)
      ?? transportFailureSource(error)
      ?? 'platform'
    return failure(
      source,
      stableChineseMessage(error.message, '服务处理失败。请查看服务端日志。'),
      errorCode(error),
      source === 'transport',
    )
  }
  return failure('platform', '服务处理失败。请查看服务端日志。')
}

function stableChineseMessage(message: string, fallback: string): string {
  const normalized = message.trim()
  if (!normalized) return fallback
  return /[\u3400-\u9fff]/u.test(normalized) ? normalized : fallback
}

function failure(
  source: RunFailureSource,
  message: string,
  code: string | null = null,
  retryable = false,
): RunFailure {
  return { source, message, code, retryable }
}

function declaredFailureSource(error: unknown): RunFailureSource | null {
  if (!isRecord(error)) return null
  const source = error.failureSource
  return source === 'model'
    || source === 'tool'
    || source === 'data'
    || source === 'database'
    || source === 'transport'
    || source === 'platform'
    ? source
    : null
}

function databaseFailureSource(error: Error): 'database' | null {
  const code = errorCode(error)
  if (code && /^[0-9A-Z]{5}$/u.test(code)) return 'database'
  return /(postgres|postgis|sqlstate|database|数据库|数据表|数据库函数)/iu.test(error.message)
    ? 'database'
    : null
}

function modelFailureSource(error: Error): 'model' | null {
  return /\b(model|response_format|structured output|json output|deepseek|openai|rate limit|context length)\b/iu.test(
    `${error.name} ${error.message}`,
  )
    ? 'model'
    : null
}

function toolFailureSource(error: Error): 'tool' | 'data' {
  return /(dataset|file|geojson|bbox|valueRef|数据|文件|图层|坐标|边界|范围|上传)/iu.test(error.message)
    ? 'data'
    : 'tool'
}

function transportFailureSource(error: Error): 'transport' | null {
  const code = errorCode(error)
  if (code && /^(ECONN|ENET|EHOST|ETIMEDOUT|UND_ERR)/u.test(code)) return 'transport'
  return /(network|socket|connection|fetch failed|timeout|连接|网络|传输)/iu.test(error.message)
    ? 'transport'
    : null
}

function errorCode(error: unknown): string | null {
  if (!isRecord(error)) return null
  return typeof error.code === 'string' && error.code.trim()
    ? error.code.trim().slice(0, 120)
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

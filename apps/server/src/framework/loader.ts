// +-------------------------------------------------------------------------
//
//   地理智能平台 - Tool Provider 显式加载器
//
//   文件:       loader.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { Env } from './env.js'
import type { ToolRegistry } from './registry.js'
import type { InstallContext, ToolProvider } from './types.js'
import type { ManagedLayerService } from '../gis/managedLayers/managedLayerService.js'
import chartProvider from '../tools/chart/index.js'
import geocodeProvider from '../tools/geocode/index.js'
import { createMediaProvider } from '../tools/media/index.js'
import memoryProvider from '../tools/memory/index.js'
import planProvider from '../tools/plan/index.js'
import developerProvider from '../tools/developer/index.js'
import { createMeteorologyProvider } from '../tools/meteorology/index.js'
import { createPublicWeatherProvider } from '../tools/publicWeather/index.js'
import { createSpatialProvider } from '../tools/spatial/index.js'
import { createRoutingProvider } from '../tools/routing/index.js'
import { createScheduledWakeUpProvider } from '../tools/scheduledWakeUp/index.js'
import { errorLogPayload, logger } from '../observability/logger.js'
import type { ScheduledTaskService } from '../automations/scheduledTaskService.js'

const LEGACY_METEOROLOGY_PROVIDER_ID = ['wea', 'ther'].join('')

// 安装到仓库并不等于启用；只有 ENABLED_TOOL_PROVIDERS 中的精确 ID 会进入运行时。
export async function discoverAndLoad(
  managedLayers: ManagedLayerService,
  deps: { env: Env; registry: ToolRegistry; scheduledTaskService?: ScheduledTaskService },
): Promise<void> {
  const { env, registry } = deps
  const spatialProvider = createSpatialProvider(managedLayers, { runtimeRoot: env.RUNTIME_ROOT })
  const routingProvider = createRoutingProvider({
    ...(env.VALHALLA_BASE_URL ? { valhallaBaseUrl: env.VALHALLA_BASE_URL } : {}),
    timeoutMs: env.ROUTING_TIMEOUT_MS,
  })
  const mediaProvider = createMediaProvider(env)
  const meteorologyProvider = createMeteorologyProvider(env)
  const publicWeatherProvider = createPublicWeatherProvider(env)
  const scheduledWakeUpProvider = deps.scheduledTaskService
    ? createScheduledWakeUpProvider(deps.scheduledTaskService)
    : null
  const providers: ToolProvider[] = [
    chartProvider as ToolProvider,
    geocodeProvider as ToolProvider,
    mediaProvider as ToolProvider,
    memoryProvider as ToolProvider,
    planProvider as ToolProvider,
    developerProvider as ToolProvider,
    meteorologyProvider as ToolProvider,
    publicWeatherProvider as ToolProvider,
    spatialProvider as ToolProvider,
    routingProvider as ToolProvider,
    ...(scheduledWakeUpProvider ? [scheduledWakeUpProvider as ToolProvider] : []),
  ]
  const builtinProviders = new Map<string, ToolProvider>(
    providers.map(provider => [provider.manifest.id, provider]),
  )
  const enabledIds = env.ENABLED_TOOL_PROVIDERS.split(',').map(value => value.trim()).filter(Boolean)
  const legacyMeteorologyId = enabledIds.find(providerId => providerId === LEGACY_METEOROLOGY_PROVIDER_ID)
  if (legacyMeteorologyId) {
    throw new Error(
      `ENABLED_TOOL_PROVIDERS 不再接受旧 Provider ID "${LEGACY_METEOROLOGY_PROVIDER_ID}"；请改用 "geo-platform-meteorology"，并运行 npm run reset:conversations 清理旧运行配置。`,
    )
  }
  const config = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value === undefined ? undefined : String(value)]),
  )

  for (const providerId of enabledIds) {
    const provider = builtinProviders.get(providerId)
    if (!provider) {
      registry.markUnavailable(providerId, 'Provider 不在显式内置目录中')
      logger.warn({
        event: 'tool.provider.unavailable',
        category: 'tool',
        retention: 'operational',
        provider: providerId,
        failureCode: 'provider_not_found',
      }, '已启用的工具 Provider 不在内置目录中。')
      continue
    }
    const missing = requiredDependencies(provider).filter(key => !config[key])
    if (missing.length) {
      const reason = `缺少依赖：${missing.join(', ')}`
      registry.markUnavailable(providerId, reason)
      logger.warn({
        event: 'tool.provider.unavailable',
        category: 'tool',
        retention: 'operational',
        provider: providerId,
        failureCode: 'missing_required_dependency',
      }, '已启用的工具 Provider 缺少必需配置。')
      continue
    }
    try {
      const ctx: InstallContext = {
        config,
        state: new Map(),
        log: (level, message) => logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']({ provider: providerId }, message),
      }
      await provider.onInstall?.(ctx)
      registry.register(provider)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      registry.markUnavailable(providerId, reason)
      logger.warn({
        event: 'tool.provider.unavailable',
        category: 'tool',
        retention: 'operational',
        provider: providerId,
        failureCode: 'provider_install_failed',
        error: errorLogPayload(error),
      }, '工具 Provider 初始化失败。')
    }
  }

  logger.info({ providers: registry.listProviders().length, tools: registry.list().length }, 'providers loaded')
}

function requiredDependencies(provider: ToolProvider): string[] {
  return Object.entries(provider.manifest.requires ?? {})
    .filter(([, level]) => level === 'required')
    .map(([key]) => key)
}

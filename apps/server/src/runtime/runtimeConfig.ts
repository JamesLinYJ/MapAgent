// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行时配置解析
//
//   运行时配置是应用服务和传输适配器共享的边界；它不属于 WS 实现。
// --------------------------------------------------------------------------

import {
  agentRuntimeConfigSchema,
  runtimeConfigDocumentSchema,
  type AgentRuntimeConfig,
  type RuntimeConfigDocument,
} from '@geo-agent-platform/shared-types/runtime'
import { defaultRuntimeConfig } from '../agent/defaultRuntimeConfig.js'
import type { RuntimeConfigStore } from '../store/postgres/runtimeConfigStore.js'

export async function resolveRuntimeConfig(
  store: Pick<RuntimeConfigStore, 'getRuntimeConfig'>,
  fallbackConfig: AgentRuntimeConfig = defaultRuntimeConfig(),
): Promise<AgentRuntimeConfig> {
  return (await resolveRuntimeConfigDocument(store, fallbackConfig)).config
}

export async function resolveRuntimeConfigDocument(
  store: Pick<RuntimeConfigStore, 'getRuntimeConfig'>,
  fallbackConfig: AgentRuntimeConfig = defaultRuntimeConfig(),
): Promise<RuntimeConfigDocument> {
  const stored = await store.getRuntimeConfig('agent-runtime')
  return runtimeConfigDocumentSchema.parse(stored ? {
    config: agentRuntimeConfigSchema.parse(stored.config),
    revision: stored.revision,
    origin: 'database',
    updatedAt: stored.updatedAt,
  } : {
    config: agentRuntimeConfigSchema.parse(fallbackConfig),
    revision: 0,
    origin: 'default',
    updatedAt: '1970-01-01T00:00:00.000Z',
  })
}

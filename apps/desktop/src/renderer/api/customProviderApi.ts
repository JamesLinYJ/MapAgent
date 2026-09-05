// +-------------------------------------------------------------------------
//
//   地理智能平台 - 自定义模型 Provider API
//
//   文件:       customProviderApi.ts
//
//   日期:       2026年08月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  CustomProviderConfig,
  CustomProviderRecord,
  CustomProviderSaveResult,
  CustomProviderTestMode,
  CustomProviderTestResult,
  ProviderModelDiscovery,
} from '@geo-agent-platform/shared-types'

import { requestControl } from './transport'

export function listCustomProviders(): Promise<CustomProviderRecord[]> {
  return requestControl('provider:custom:list')
}

export function stageProviderCredential(secret: string): Promise<{
  credentialHandle: string
  expiresAt: string
}> {
  return requestControl('provider:credential:stage', { secret })
}

export function saveCustomProvider(input: {
  config: CustomProviderConfig
  expectedRevision: number | null
  credentialHandle?: string | null
  clearApiKey?: boolean
}): Promise<CustomProviderSaveResult> {
  return requestControl('provider:custom:upsert', {
    config: input.config,
    expectedRevision: input.expectedRevision,
    ...(input.credentialHandle ? { credentialHandle: input.credentialHandle } : {}),
    ...(input.clearApiKey ? { clearApiKey: true } : {}),
  })
}

export function discoverCustomProviderModels(input: {
  providerId: string
  baseUrl: string
  credentialHandle?: string | null
}): Promise<ProviderModelDiscovery> {
  return requestControl('provider:custom:discover-models', {
    providerId: input.providerId,
    baseUrl: input.baseUrl,
    ...(input.credentialHandle ? { credentialHandle: input.credentialHandle } : {}),
  })
}

export function testCustomProvider(input: {
  config: CustomProviderConfig
  mode: CustomProviderTestMode
  credentialHandle?: string | null
}): Promise<CustomProviderTestResult> {
  return requestControl('provider:custom:test', {
    config: input.config,
    mode: input.mode,
    ...(input.credentialHandle ? { credentialHandle: input.credentialHandle } : {}),
  })
}

export function deleteCustomProvider(providerId: string, expectedRevision: number): Promise<{
  deleted: boolean
  providerId: string
}> {
  return requestControl('provider:custom:delete', { providerId, expectedRevision })
}

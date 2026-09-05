// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具、配置与系统状态 API
//
//   文件:       toolApi.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  wsCommandContract,
  type AgentRuntimeConfig,
  type DirectToolRunResponse,
  type ModelProviderDescriptor,
  type RuntimeConfigDocument,
  type SkillCatalogSnapshot,
  type SkillSearchResponse,
  type SpeechAuthorization,
  type SystemComponentsStatus,
  type TokenUsageSummary,
  type TokenUsageThreadSummary,
  type ToolDescriptor,
} from '@geo-agent-platform/shared-types'

import { requestControl } from './transport'

export function listProviders(): Promise<ModelProviderDescriptor[]> {
  return requestControl('provider:list')
}

export function getSystemComponents(): Promise<SystemComponentsStatus> {
  return requestControl('system:get')
}

export function getSpeechAuthorization(): Promise<SpeechAuthorization> {
  return requestControl('speech:authorization')
}

export function getTokenUsageSummary(): Promise<TokenUsageSummary> {
  return requestControl('usage:summary')
}

export function getThreadTokenUsageSummary(threadId: string): Promise<TokenUsageThreadSummary> {
  return requestControl('usage:thread-summary', { threadId })
}

export function listTools(): Promise<ToolDescriptor[]> {
  return requestControl('tool:list')
}

export function listToolCatalogEntries(): Promise<Array<Record<string, unknown>>> {
  return requestControl('tool-catalog:list')
}

export function listSkills(): Promise<SkillCatalogSnapshot> {
  return requestControl('skill:list')
}

export function searchSkills(query: string): Promise<SkillSearchResponse> {
  return requestControl('skill:search', { query })
}

export function getRuntimeConfig(): Promise<RuntimeConfigDocument> {
  return requestControl('runtime-config:get')
}

export function updateRuntimeConfig(
  config: AgentRuntimeConfig,
  expectedRevision: number,
): Promise<RuntimeConfigDocument> {
  return requestControl('runtime-config:update', { config, expectedRevision })
}

export function upsertToolCatalogEntry(
  toolKind: string,
  toolName: string,
  payload: Record<string, unknown>,
  sortOrder?: number,
): Promise<Record<string, unknown>> {
  return requestControl('tool-catalog:upsert', { toolKind, toolName, payload, sortOrder })
}

export function deleteToolCatalogEntry(toolKind: string, toolName: string): Promise<Record<string, unknown>> {
  return requestControl('tool-catalog:delete', { toolKind, toolName })
}

export function runTool(payload: Record<string, unknown>): Promise<DirectToolRunResponse> {
  const parsedPayload = wsCommandContract('tool:run').payload.parse(payload)
  return requestControl('tool:run', parsedPayload)
}

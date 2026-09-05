// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象工具定义构造器
//
//   文件:       toolDefinition.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult } from '../../framework/types.js'
import { meteorologyToolPrompt } from './prompts.js'
import type { MeteorologyWorkerToolName } from './meteorologyWorkerClient.js'

export interface MeteorologyToolDeps {
  runtimeRoot: string
  callWorker(
    name: MeteorologyWorkerToolName,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ message: string; payload: Record<string, unknown> }>
}

export type MeteorologyToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
  deps: MeteorologyToolDeps,
) => Promise<ToolResult>

export function withMeteorologyDeps(deps: MeteorologyToolDeps, handler: MeteorologyToolHandler): ToolDef['handler'] {
  return (args, ctx) => handler(args, ctx, deps)
}

export function tool(
  name: string,
  label: string,
  description: string,
  properties: Record<string, unknown>,
  handler: ToolDef['handler'],
  required: string[] = [],
  options: Partial<Pick<ToolDef, 'executionSurfaces' | 'agentResultMode' | 'isReadOnly' | 'isDestructive' | 'requiresApproval'>> = {},
): ToolDef {
  const miniApp = miniAppMetadata(name)
  const {
    isReadOnly = true,
    isDestructive = false,
    requiresApproval = false,
    ...executionOptions
  } = options
  return {
    name,
    label,
    description,
    prompt: meteorologyToolPrompt(name),
    group: '气象',
    tags: ['meteorology'],
    isReadOnly,
    isDestructive,
    requiresApproval,
    ...executionOptions,
    jsonSchema: { type: 'object', properties, required, ...(miniApp ? { 'x-mini-app': miniApp } : {}) },
    handler,
  }
}

export function refParameter(title: string, kinds: string[] = []) {
  return {
    type: 'string',
    title,
    description: '必须使用当前 run 中已存在的 valueRef ID',
    'x-source': 'value_ref',
    ...(kinds.length ? { 'x-value-ref-kinds': kinds } : {}),
  }
}

export function textParameter(title: string) {
  return { type: 'string', title, 'x-source': 'text' }
}

export function numberParameter(title: string) {
  return { type: 'number', title, 'x-source': 'number' }
}

export function selectParameter(title: string, values: string[]) {
  return { type: 'string', title, enum: values, 'x-source': 'text' }
}

export function jsonParameter(title: string, schema: Record<string, unknown>, defaultValue?: unknown) {
  return {
    ...schema,
    title,
    'x-source': 'json',
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  }
}

function miniAppMetadata(name: string): Record<string, string> | null {
  if ([
    'inspect_radar_station_collection',
    'recommend_radar_mosaic_strategy',
    'render_radar_mosaic',
    'compare_radar_mosaic_reference',
  ].includes(name)) return { type: 'radar_mosaic_console' }
  if (['define_rainfall_risk_thresholds', 'render_rainfall_risk_map'].includes(name)) return { type: 'rainfall_risk_map_console' }
  if (name === 'generate_area_rainfall_table') return { type: 'area_rainfall_table_console' }
  return null
}

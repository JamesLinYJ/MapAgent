// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具参数 Schema 边界
//
//   文件:       schema.ts
//
//   日期:       2026年06月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { z } from 'zod'
import type { ToolManifest } from './types.js'

export type ToolParameterSchema = z.ZodObject

const toolExecutionSurfaceSchema = z.enum(['agent', 'automation', 'debug'])
const agentToolResultModeSchema = z.enum(['continue', 'return_direct'])
const toolRuntimePolicySchema = z.object({
  namespace: z.string().trim().min(1).optional(),
  exposure: z.enum(['immediate', 'deferred', 'hidden', 'plan_readonly']).optional(),
  effect: z.enum(['read', 'world_write', 'external_write', 'destructive']).optional(),
  parallelism: z.enum(['shared', 'exclusive']).optional(),
  approvalAction: z.string().trim().min(1).nullable().optional(),
  replayPolicy: z.enum(['safe', 'idempotency_key', 'manual_recovery']).optional(),
  requiredCapabilities: z.array(z.string().trim().min(1)).optional(),
}).strict()

const toolManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  author: z.string().min(1),
  description: z.string().min(1),
  language: z.string().min(1),
  homepage: z.string().min(1).optional(),
  endpoint: z.string().min(1).optional(),
  requires: z.record(z.string(), z.string()).optional(),
  tools: z.array(z.object({
    name: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1),
    group: z.string().min(1),
    tags: z.array(z.string()),
    isReadOnly: z.boolean(),
    isDestructive: z.boolean(),
    parallelSafe: z.boolean().optional(),
    requiresApproval: z.boolean().default(false),
    executionSurfaces: z.array(toolExecutionSurfaceSchema).min(1).optional(),
    agentResultMode: agentToolResultModeSchema.optional(),
    runtimePolicy: toolRuntimePolicySchema.optional(),
    jsonSchema: z.record(z.string(), z.unknown()),
  })).min(1),
})

// JSON manifest 是外部配置边界；解析后 Provider 才能依赖其公开契约。
export function parseToolManifest(value: unknown): ToolManifest {
  const parsed = toolManifestSchema.parse(value)
  return {
    id: parsed.id,
    name: parsed.name,
    version: parsed.version,
    author: parsed.author,
    description: parsed.description,
    language: parsed.language,
    ...(parsed.homepage ? { homepage: parsed.homepage } : {}),
    ...(parsed.endpoint ? { endpoint: parsed.endpoint } : {}),
    ...(parsed.requires ? { requires: parsed.requires } : {}),
    tools: parsed.tools.map(tool => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      group: tool.group,
      tags: tool.tags,
      isReadOnly: tool.isReadOnly,
      isDestructive: tool.isDestructive,
      ...(tool.parallelSafe === undefined ? {} : { parallelSafe: tool.parallelSafe }),
      requiresApproval: tool.requiresApproval,
      ...(tool.executionSurfaces ? { executionSurfaces: tool.executionSurfaces } : {}),
      ...(tool.agentResultMode ? { agentResultMode: tool.agentResultMode } : {}),
      ...(tool.runtimePolicy ? { runtimePolicy: normalizeRuntimePolicy(tool.runtimePolicy) } : {}),
      jsonSchema: tool.jsonSchema,
    })),
  }
}

function normalizeRuntimePolicy(
  policy: z.output<typeof toolRuntimePolicySchema>,
): NonNullable<ToolManifest['tools'][number]['runtimePolicy']> {
  return {
    ...(policy.namespace === undefined ? {} : { namespace: policy.namespace }),
    ...(policy.exposure === undefined ? {} : { exposure: policy.exposure }),
    ...(policy.effect === undefined ? {} : { effect: policy.effect }),
    ...(policy.parallelism === undefined ? {} : { parallelism: policy.parallelism }),
    ...(policy.approvalAction === undefined ? {} : { approvalAction: policy.approvalAction }),
    ...(policy.replayPolicy === undefined ? {} : { replayPolicy: policy.replayPolicy }),
    ...(policy.requiredCapabilities === undefined
      ? {}
      : { requiredCapabilities: policy.requiredCapabilities }),
  }
}

export function deriveJsonSchema(parameters: ToolParameterSchema): Record<string, unknown> {
  const schema = z.toJSONSchema(parameters) as Record<string, unknown>
  const { $schema: _schema, ...rest } = schema
  return rest
}

export function ensureToolSchemas(tool: {
  name: string
  parameters?: ToolParameterSchema
  jsonSchema?: Record<string, unknown>
}): { parameters: ToolParameterSchema; jsonSchema: Record<string, unknown> } {
  if (tool.parameters) {
    tool.jsonSchema = tool.jsonSchema ?? deriveJsonSchema(tool.parameters)
    return { parameters: tool.parameters, jsonSchema: tool.jsonSchema }
  }
  if (!tool.jsonSchema) {
    throw new Error(`工具 "${tool.name}" 缺少 parameters`)
  }
  tool.parameters = parametersFromJsonSchema(tool.jsonSchema)
  return { parameters: tool.parameters, jsonSchema: tool.jsonSchema }
}

// Zod v4 内置 JSON Schema → Zod 转换。
// runtime 模式下 optional 字段仅允许省略；agents 模式下额外接受 null。
// JSON Schema 规范：未设置 additionalProperties 时默认允许额外字段。
// 平台 约定相反：未设置时默认拒绝未识别参数。
export function parametersFromJsonSchema(schema: Record<string, unknown>): ToolParameterSchema {
  const result = z.fromJSONSchema(schema)
  if (!(result instanceof z.ZodObject)) throw new Error('工具 parameters 顶层必须是 object')
  const annotated = preserveJsonSchemaDescriptions(result, schema)
  return schema.additionalProperties === true ? annotated.passthrough() : annotated.strict()
}

export function parametersForAgentsSdk(schema: Record<string, unknown>): ToolParameterSchema {
  return parametersFromJsonSchema(toStrictAgentSchema(schema))
}

export type CompatibleAgentToolSchema = Record<string, unknown> & {
  type: 'object'
  properties: Record<string, Record<string, unknown>>
  required: string[]
  additionalProperties: true
}

// Agents SDK 的非严格工具使用原生 JSON Schema，并由 ToolRegistry 在执行边界进行
// Zod 校验。additionalProperties=true 是 SDK 对非严格 schema 的公开契约；平台
// 内部 schema 仍保持 strict，未知字段不会进入工具处理器。
export function parametersForCompatibleAgentsSdk(schema: Record<string, unknown>): CompatibleAgentToolSchema {
  const cloned = structuredClone(schema)
  if (cloned.type !== 'object' || !isRecord(cloned.properties)) {
    throw new Error('兼容模式工具 parameters 顶层必须是 object')
  }
  const properties: Record<string, Record<string, unknown>> = {}
  for (const [key, property] of Object.entries(cloned.properties)) {
    if (!isRecord(property)) throw new Error(`兼容模式工具参数 '${key}' 必须是 JSON Schema object`)
    properties[key] = property
  }
  const propertyNames = new Set(Object.keys(properties))
  const required = Array.isArray(cloned.required)
    ? cloned.required.map(String).filter(name => propertyNames.has(name))
    : []
  return {
    ...cloned,
    type: 'object',
    properties,
    required,
    additionalProperties: true,
  }
}

// OpenAI strict function schema 要求 object 的每个 property 都出现在 required 中。
// 内部工具仍以“字段可省略”表达可选参数；模型边界则改为“字段必填、值可为 null”，
// 执行前再由 stripNullObjectValues 恢复内部契约。
function toStrictAgentSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return normalizeStrictNode(structuredClone(schema))
}

function normalizeStrictNode(node: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...node }
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = normalized[keyword]
    if (Array.isArray(variants)) {
      normalized[keyword] = variants.map(variant => isRecord(variant) ? normalizeStrictNode(variant) : variant)
    }
  }
  if (isRecord(normalized.items)) normalized.items = normalizeStrictNode(normalized.items)
  if (!isRecord(normalized.properties)) return normalized

  const sourceRequired = new Set(Array.isArray(normalized.required) ? normalized.required.map(String) : [])
  const properties: Record<string, unknown> = {}
  for (const [key, rawProperty] of Object.entries(normalized.properties)) {
    if (!isRecord(rawProperty)) {
      properties[key] = rawProperty
      continue
    }
    const property = normalizeStrictNode(rawProperty)
    properties[key] = sourceRequired.has(key) ? property : makeNullable(property)
  }
  normalized.properties = properties
  normalized.required = Object.keys(properties)
  return normalized
}

function makeNullable(schema: Record<string, unknown>): Record<string, unknown> {
  if (typeof schema.type === 'string') return { ...schema, type: [schema.type, 'null'] }
  if (Array.isArray(schema.type)) {
    const types = schema.type.map(String)
    return types.includes('null') ? schema : { ...schema, type: [...types, 'null'] }
  }
  if (Array.isArray(schema.anyOf)) {
    const alreadyNullable = schema.anyOf.some(variant => isRecord(variant) && variant.type === 'null')
    return alreadyNullable ? schema : { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] }
  }
  return { anyOf: [schema, { type: 'null' }] }
}

export function stripNullObjectValues<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => stripNullObjectValues(item)) as T
  if (!isRecord(value)) return value
  const cleaned: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    if (nested === null) continue
    cleaned[key] = stripNullObjectValues(nested)
  }
  return cleaned as T
}

export function schemaParameters(schema: Record<string, unknown>) {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  return Object.entries(properties).map(([key, raw]) => {
    const property = isRecord(raw) ? raw : {}
    return {
      key,
      label: typeof property.title === 'string' ? property.title : key,
      dataType: typeof property.type === 'string' ? property.type : 'string',
      source: typeof property['x-source'] === 'string' ? property['x-source'] : 'text',
      required: required.has(key),
      description: typeof property.description === 'string' ? property.description : null,
      placeholder: null,
      defaultValue: property.default ?? null,
      options: Array.isArray(property.enum)
        ? property.enum.map(value => ({ label: String(value), value: String(value) }))
        : [],
      acceptedValueRefKinds: Array.isArray(property['x-value-ref-kinds'])
        ? property['x-value-ref-kinds'].map(String)
        : [],
    }
  })
}

export function valueRefRules(schema: Record<string, unknown>, prefix = ''): string[] {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const rules: string[] = []
  for (const [key, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) continue
    const path = prefix ? `${prefix}.${key}` : key
    const kinds = valueRefKinds(raw)
    if (kinds.length) {
      const inline = schemaAllowsType(raw, 'object') ? '；也可按 schema 传内联 object' : ''
      rules.push(`${path} 传字符串 refId 时只接受 ${kinds.join(' / ')}${inline}`)
    }
    rules.push(...valueRefRules(raw, path))
  }
  return rules
}

export function enrichValueRefDescriptions(schema: Record<string, unknown>): Record<string, unknown> {
  return enrichSchema(schema) as Record<string, unknown>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function enrichSchema(value: unknown): unknown {
  if (!isRecord(value)) return value
  const schema: Record<string, unknown> = { ...value }
  const kinds = valueRefKinds(schema)
  if (kinds.length) {
    const base = typeof schema.description === 'string' && schema.description.trim()
      ? schema.description.trim()
      : '字符串输入必须使用当前 run 中已存在的 valueRef ID'
    const inline = schemaAllowsType(schema, 'object') ? '；同时允许 schema 声明的内联 object' : ''
    schema.description = `${base}；字符串 refId 允许的 valueRef kind: ${kinds.join(' / ')}；禁止传入其它 kind 的 valueRef${inline}。`
  }
  if (isRecord(schema.properties)) {
    schema.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, nested]) => [key, enrichSchema(nested)]))
  }
  if (isRecord(schema.items)) schema.items = enrichSchema(schema.items)
  return schema
}

function valueRefKinds(schema: Record<string, unknown>): string[] {
  if (!Array.isArray(schema['x-value-ref-kinds'])) return []
  return schema['x-value-ref-kinds'].map(String).filter(Boolean)
}

// Zod 的 JSON Schema 导入器负责结构与校验，但不会在所有版本中保留字段级
// description。Agents SDK 随后再输出 JSON Schema，因此这里显式保留标准注解，
// 防止模型丢失 valueRef kind 等参数约束。
function preserveJsonSchemaDescriptions(
  object: z.ZodObject,
  jsonSchema: Record<string, unknown>,
): z.ZodObject {
  if (!isRecord(jsonSchema.properties)) return object
  const replacements: Record<string, z.ZodType> = {}
  for (const [key, rawProperty] of Object.entries(jsonSchema.properties)) {
    const field = object.shape[key]
    if (!field || !isRecord(rawProperty)) continue
    let annotated: z.ZodType = field
    if (typeof rawProperty.description === 'string' && rawProperty.description.trim()) {
      annotated = annotated.describe(rawProperty.description.trim())
    }
    if (annotated instanceof z.ZodObject) {
      annotated = preserveJsonSchemaDescriptions(annotated, rawProperty)
    }
    replacements[key] = annotated
  }
  return object.safeExtend(replacements)
}

function schemaAllowsType(schema: Record<string, unknown>, expected: string): boolean {
  if (schema.type === expected) return true
  if (Array.isArray(schema.type) && schema.type.map(String).includes(expected)) return true
  return ['anyOf', 'oneOf'].some(keyword => (
    Array.isArray(schema[keyword])
    && schema[keyword].some(candidate => isRecord(candidate) && schemaAllowsType(candidate, expected))
  ))
}

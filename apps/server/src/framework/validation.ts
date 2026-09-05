// +-------------------------------------------------------------------------
//
//   地理智能平台 - Tool 定义校验
//
//   文件:       validation.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------
import { ensureToolSchemas, stableJson } from './schema.js'
import type { ToolDef, ToolManifest, ToolManifestEntry, ToolProvider } from './types.js'

// Provider 暴露前校验是工具目录的硬边界，坏定义不能进入 Agent 或 DebugPage。
function validateToolDefinition(tool: ToolDef): void {
    requireText(tool.name, 'tool.name');
    requireText(tool.label, `${tool.name}.label`);
    requireChineseLabel(tool.label, `${tool.name}.label`);
    requireText(tool.description, `${tool.name}.description`);
    requireText(tool.prompt, `${tool.name}.prompt`);
    requireText(tool.group, `${tool.name}.group`);
    const { jsonSchema } = ensureToolSchemas(tool);
    if (jsonSchema.type !== 'object') {
        throw new Error(`工具 "${tool.name}" 的 parameters 必须派生为 object JSON Schema`);
    }
    if (typeof tool.handler !== 'function') {
        throw new Error(`工具 "${tool.name}" 缺少 handler`);
    }
    validateJsonSchema(jsonSchema, `${tool.name}.jsonSchema`);
}
export function validateToolProvider(provider: ToolProvider): ToolDef[] {
    validateManifest(provider.manifest);
    const tools = provider.tools();
    for (const tool of tools) ensureToolSchemas(tool);
    if (tools.length !== provider.manifest.tools.length) {
        throw new Error(`Provider "${provider.manifest.id}" manifest 与运行时工具数量不一致`);
    }
    const manifestNames = new Set(provider.manifest.tools.map(tool => tool.name));
    const runtimeNames = new Set(tools.map(tool => tool.name));
    for (const tool of tools) {
        validateToolDefinition(tool);
        if (!manifestNames.has(tool.name)) {
            throw new Error(`工具 "${tool.name}" 未在 Provider manifest 中声明`);
        }
        const entry = provider.manifest.tools.find(candidate => candidate.name === tool.name);
        if (!entry) throw new Error(`工具 "${tool.name}" 未在 Provider manifest 中声明`);
        if (
            entry.isReadOnly !== tool.isReadOnly
            || entry.isDestructive !== tool.isDestructive
            || (entry.parallelSafe ?? false) !== (tool.parallelSafe ?? false)
            || (entry.requiresApproval ?? false) !== (tool.requiresApproval ?? false)
        ) {
            throw new Error(`工具 "${tool.name}" 的读写、并发安全、破坏性或审批属性与 manifest 不一致`);
        }
        validateManifestParity(entry, tool);
    }
    for (const entry of provider.manifest.tools) {
        if (!runtimeNames.has(entry.name))
            throw new Error(`Provider "${provider.manifest.id}" 的工具 "${entry.name}" 缺少运行时实现`);
    }
    return tools;
}
function validateManifestParity(manifestTool: ToolManifestEntry, runtimeTool: ToolDef): void {
    // Manifest 是 UI、Agent 与运行时共享的公开契约；运行时实现不能悄悄扩展参数或改写描述。
    const fields: Array<keyof ToolManifestEntry> = [
        'label',
        'description',
        'group',
        'tags',
        'executionSurfaces',
        'agentResultMode',
        'runtimePolicy',
        'jsonSchema',
    ];
    for (const field of fields) {
        if (stableJson(manifestTool[field]) !== stableJson(runtimeTool[field])) {
            throw new Error(`工具 "${runtimeTool.name}" 的 ${field} 与 manifest 不一致`);
        }
    }
}
function validateManifest(manifest: ToolManifest): void {
    requireText(manifest.id, 'manifest.id');
    requireText(manifest.name, `${manifest.id}.name`);
    requireText(manifest.version, `${manifest.id}.version`);
    if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
        throw new Error(`Provider "${manifest.id}" 未声明工具`);
    }
    const names = new Set<string>();
    for (const tool of manifest.tools) {
        requireText(tool.name, `${manifest.id}.tool.name`);
        requireText(tool.label, `${manifest.id}.${tool.name}.label`);
        requireChineseLabel(tool.label, `${manifest.id}.${tool.name}.label`);
        if (names.has(tool.name))
            throw new Error(`Provider "${manifest.id}" 重复声明工具 "${tool.name}"`);
        names.add(tool.name);
        if (tool.jsonSchema.type !== 'object') {
            throw new Error(`Provider "${manifest.id}" 的工具 "${tool.name}" 缺少 object 参数 schema`);
        }
        if (tool.executionSurfaces?.length === 0) {
            throw new Error(`Provider "${manifest.id}" 的工具 "${tool.name}" executionSurfaces 不能为空`);
        }
        validateJsonSchema(tool.jsonSchema, `${manifest.id}.${tool.name}.jsonSchema`);
    }
}
function validateJsonSchema(
    schema: Record<string, unknown>,
    field: string,
    root: Record<string, unknown> = schema,
    seenRefs: Set<string> = new Set(),
): void {
    let hasRef = false;
    if (schema.$ref !== undefined) {
        if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/'))
            throw new Error(`${field}.$ref 必须是本地 JSON Pointer`);
        const ref = schema.$ref;
        if (seenRefs.has(ref)) throw new Error(`${field}.$ref 存在循环: ${ref}`);
        const target = resolveLocalJsonSchemaRef(root, ref, field);
        validateJsonSchema(target, `${field}.$ref(${ref})`, root, new Set(seenRefs).add(ref));
        hasRef = true;
    }
    const supportedTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
    const types = typeof schema.type === 'string'
        ? [schema.type]
        : Array.isArray(schema.type) && schema.type.every(value => typeof value === 'string')
            ? schema.type
            : [];
    const compositeKeywords = ['anyOf', 'oneOf', 'allOf'] as const;
    let hasComposite = false;
    for (const keyword of compositeKeywords) {
        if (schema[keyword] === undefined) continue;
        hasComposite = true;
        const alternatives = schema[keyword];
        if (!Array.isArray(alternatives) || alternatives.length === 0)
            throw new Error(`${field}.${keyword} 必须是非空 schema 数组`);
        for (const [index, alternative] of alternatives.entries()) {
            if (!isRecord(alternative))
                throw new Error(`${field}.${keyword}.${index} 必须是 schema 对象`);
            validateJsonSchema(alternative, `${field}.${keyword}.${index}`, root, new Set(seenRefs));
        }
    }
    if (types.length === 0 && !hasComposite && !hasRef) {
        throw new Error(`${field}.type 不受支持，且未声明 anyOf/oneOf/allOf`);
    }
    if (types.some(type => !supportedTypes.has(type))) {
        throw new Error(`${field}.type 不受支持`);
    }
    if (schema.enum !== undefined && !Array.isArray(schema.enum))
        throw new Error(`${field}.enum 必须是数组`);
    if (types.includes('object')) {
        if (schema.properties !== undefined && !isRecord(schema.properties))
            throw new Error(`${field}.properties 必须是对象`);
        for (const [key, value] of Object.entries(isRecord(schema.properties) ? schema.properties : {})) {
            if (!isRecord(value))
                throw new Error(`${field}.properties.${key} 必须是 schema 对象`);
            validateJsonSchema(value, `${field}.properties.${key}`, root, new Set(seenRefs));
        }
        if (schema.required !== undefined && !Array.isArray(schema.required))
            throw new Error(`${field}.required 必须是数组`);
        if (isRecord(schema.additionalProperties))
            validateJsonSchema(schema.additionalProperties, `${field}.additionalProperties`, root, new Set(seenRefs));
    }
    if (types.includes('array') && schema.items !== undefined) {
        if (!isRecord(schema.items))
            throw new Error(`${field}.items 必须是 schema 对象`);
        validateJsonSchema(schema.items, `${field}.items`, root, new Set(seenRefs));
    }
    if (schema.prefixItems !== undefined) {
        if (!Array.isArray(schema.prefixItems))
            throw new Error(`${field}.prefixItems 必须是 schema 数组`);
        for (const [index, item] of schema.prefixItems.entries()) {
            if (!isRecord(item)) throw new Error(`${field}.prefixItems.${index} 必须是 schema 对象`);
            validateJsonSchema(item, `${field}.prefixItems.${index}`, root, new Set(seenRefs));
        }
    }
    if (schema.$defs !== undefined) {
        if (!isRecord(schema.$defs)) throw new Error(`${field}.$defs 必须是 schema 对象`);
        for (const [key, definition] of Object.entries(schema.$defs)) {
            if (!isRecord(definition)) throw new Error(`${field}.$defs.${key} 必须是 schema 对象`);
            validateJsonSchema(definition, `${field}.$defs.${key}`, root, new Set(seenRefs));
        }
    }
}

function resolveLocalJsonSchemaRef(root: Record<string, unknown>, ref: string, field: string): Record<string, unknown> {
    let current: unknown = root;
    for (const token of ref.slice(2).split('/').map(value => value.replace(/~1/gu, '/').replace(/~0/gu, '~'))) {
        if (!isRecord(current) || !(token in current)) throw new Error(`${field}.$ref 不存在: ${ref}`);
        current = current[token];
    }
    if (!isRecord(current)) throw new Error(`${field}.$ref 不是 schema 对象: ${ref}`);
    return current;
}
function requireText(value: string | undefined, field: string): void {
    if (!value?.trim())
        throw new Error(`${field} 不能为空`);
}
function requireChineseLabel(value: string, field: string): void {
    if (!/[\u3400-\u9fff]/u.test(value))
        throw new Error(`${field} 必须包含中文展示名称`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

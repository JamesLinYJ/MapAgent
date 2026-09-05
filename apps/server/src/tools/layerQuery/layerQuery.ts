// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostGIS 图层查询工具
//
//   文件:       layerQuery.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------
import { makeId } from '../../utils/ids.js';
import type { ToolDef } from '../../framework/types.js';
import type {
    LayerFeatureQuery,
    ManagedLayerService,
} from '../../gis/managedLayers/managedLayerService.js';
import type { GeoJsonFeatureCollection } from '../../gis/geojson.js';
import { QUERY_LAYER_PROMPT } from '../spatial/prompts.js';

type BBox = [number, number, number, number];

export function createLayerQueryTool(managedLayers: ManagedLayerService): ToolDef {
    return {
        name: 'query_layer',
        label: '查询图层',
        description: '从 PostGIS 图层读取真实要素。',
        prompt: QUERY_LAYER_PROMPT,
        group: '空间分析',
        tags: ['postgis', 'query'],
        isReadOnly: true,
        isDestructive: false,
        jsonSchema: {
            type: 'object',
            properties: {
                layerKey: { type: 'string' },
                bbox: { type: 'array' },
                limit: { type: 'integer', minimum: 1, maximum: 1000 },
                properties: { type: 'array', items: { type: 'string' } },
                propertyFilter: {
                    type: 'object',
                    description: '按单个属性的一个或多个精确值筛选；筛选在 limit 之前由 PostGIS 执行。',
                    properties: {
                        property: { type: 'string', description: '属性字段名，例如 name 或 adcode。' },
                        values: {
                            type: 'array',
                            minItems: 1,
                            maxItems: 50,
                            items: {
                                anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
                            },
                            description: '允许匹配的精确属性值；多个值使用 OR 语义。',
                        },
                    },
                    required: ['property', 'values'],
                    additionalProperties: false,
                },
                requireComplete: { type: 'boolean', description: '为 true 时，若查询结果少于筛选后匹配要素数则硬失败。' },
            },
            required: ['layerKey'],
        },
        async handler(args) {
            const layerKey = String(args.layerKey);
            const bbox = parseBbox(args.bbox);
            const limit = parseLimit(args.limit);
            const propertyFilter = parsePropertyFilter(args.propertyFilter);
            const requireComplete = args.requireComplete === true;
            const selectedProperties = Array.isArray(args.properties) ? new Set(args.properties.map(String)) : null;
            const query: LayerFeatureQuery = {
                ...(bbox ? { bbox } : {}),
                ...(propertyFilter ? { propertyFilter } : {}),
                limit,
            };
            const countQuery = {
                ...(bbox ? { bbox } : {}),
                ...(propertyFilter ? { propertyFilter } : {}),
            };
            const [rows, sourceTotalCount, matchedCount] = await Promise.all([
                managedLayers.queryFeatures(layerKey, query),
                managedLayers.featureCount(layerKey),
                managedLayers.featureCount(layerKey, countQuery),
            ]);
            const complete = rows.length >= matchedCount;
            if (requireComplete && !complete) {
                throw new Error(`图层 '${layerKey}' 筛选后共 ${matchedCount} 个要素，本次只读取 ${rows.length} 个，不能作为完整分析范围。`);
            }
            const featureCollection: GeoJsonFeatureCollection = {
                type: 'FeatureCollection',
                features: rows.map(row => ({
                    type: 'Feature',
                    geometry: row.geometry,
                    properties: selectedProperties
                        ? Object.fromEntries(Object.entries(row.properties).filter(([key]) => selectedProperties.has(key)))
                        : row.properties,
                })),
            };
            const scope = matchedCount === sourceTotalCount
                ? `${matchedCount} 个要素`
                : `${matchedCount} 个匹配要素（图层共 ${sourceTotalCount} 个）`;
            return {
                message: `读取 ${rows.length} / ${scope}`,
                payload: {
                    layerKey,
                    totalCount: matchedCount,
                    sourceTotalCount,
                    matchedCount,
                    returnedCount: rows.length,
                    complete,
                    featureCollection,
                },
                warnings: complete ? [] : [`图层 '${layerKey}' 查询结果已截断：${rows.length} / ${matchedCount} 个匹配要素。`],
                resultId: makeId('result'),
                source: 'postgis',
                valueRefs: [{ refId: makeId('ref'), kind: 'feature_collection', label: `${layerKey} 查询结果`, value: featureCollection }],
            };
        },
    };
}

function parseLimit(value: unknown): number {
    if (value === undefined)
        return 100;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000)
        throw new Error('limit 必须是 1 到 1000 之间的整数');
    return value;
}

function parsePropertyFilter(value: unknown): LayerFeatureQuery['propertyFilter'] {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('propertyFilter 必须是对象');
    const candidate = value as Record<string, unknown>;
    const property = typeof candidate.property === 'string' ? candidate.property.trim() : '';
    if (!property || property.length > 128)
        throw new Error('propertyFilter.property 必须是 1 到 128 个字符的字段名');
    if (!Array.isArray(candidate.values) || candidate.values.length < 1 || candidate.values.length > 50)
        throw new Error('propertyFilter.values 必须包含 1 到 50 个值');
    const values = candidate.values;
    if (!values.every(item => (
        typeof item === 'string'
        || typeof item === 'boolean'
        || (typeof item === 'number' && Number.isFinite(item))
    ))) {
        throw new Error('propertyFilter.values 只允许字符串、有限数字或布尔值');
    }
    return { property, values };
}

function parseBbox(value: unknown): BBox | undefined {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.length !== 4)
        throw new Error('bbox 必须是 [minX, minY, maxX, maxY]');
    const bbox = value.map(Number);
    if (!bbox.every(item => Number.isFinite(item)))
        throw new Error('bbox 必须只包含有限数字');
    const [minX, minY, maxX, maxY] = bbox;
    if (minX === undefined || minY === undefined || maxX === undefined || maxY === undefined)
        throw new Error('bbox 必须包含四个坐标');
    return [minX, minY, maxX, maxY];
}

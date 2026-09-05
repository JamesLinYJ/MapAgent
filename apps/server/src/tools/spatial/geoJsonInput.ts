// +-------------------------------------------------------------------------
//
//   地理智能平台 - GeoJSON 工具输入边界
//
//   文件:       geoJsonInput.ts
//
//   日期:       2026年07月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ToolContext } from '../../framework/types.js'
import { normalizeGeoJsonToCrs84,type CanonicalGeoJson } from '../../gis/geojsonCrs.js'

const GEOJSON_VALUE_REF_KINDS = ['feature_collection', 'geojson', 'route', 'layer'] as const

// GeoJSON 消费工具既接受用户明确提供的小型内联对象，也接受前序工具产生的
// valueRef。字符串永远按 refId 解析，不能被当成 JSON 文本或文件路径猜测。
export function geoJsonInputSchema(description: string): Record<string, unknown> {
  return {
    anyOf: [
      { type: 'string', minLength: 1 },
      { type: 'object', additionalProperties: true },
    ],
    description,
    'x-source': 'json-or-value-ref',
    'x-value-ref-kinds': [...GEOJSON_VALUE_REF_KINDS],
  }
}

export function resolveCanonicalGeoJsonInput(
  value: unknown,
  context: Pick<ToolContext, 'resolveValueRef'>,
  field: string,
): CanonicalGeoJson {
  if (typeof value !== 'string') return normalizeGeoJsonToCrs84(value, field)
  const refId = value.trim()
  if (!refId) throw new Error(`${field} valueRef 不能为空`)
  const reference = context.resolveValueRef(refId)
  if (!GEOJSON_VALUE_REF_KINDS.includes(reference.kind as typeof GEOJSON_VALUE_REF_KINDS[number])) {
    throw new Error(`${field} 不接受 kind '${reference.kind}' 的 valueRef`)
  }
  const candidate = reference.kind === 'layer' && isRecord(reference.value)
    ? reference.value.featureCollection
    : reference.value
  return normalizeGeoJsonToCrs84(candidate, `${field}(${refId})`, reference.metadata?.crs)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - GeoJSON CRS 规范化边界
//
//   文件:       geojsonCrs.ts
//
//   日期:       2026年08月09日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6
// --------------------------------------------------------------------------

import {
  createGeometryTransformer,
  GEOJSON_CRS84,
  normalizeCrsIdentifier,
  type GeometryTransformer,
} from './crs.js'
import {
  parseGeoJsonEntity,
  parseProjectedGeoJsonEntity,
  type GeoJsonEntity,
  type GeoJsonFeature,
  type Geometry,
  type Position,
} from './geojson.js'

export type GeoJsonBounds = [number, number, number, number]
const canonicalGeoJsonBrand: unique symbol = Symbol('CanonicalGeoJson')

export interface CanonicalGeoJson {
  readonly [canonicalGeoJsonBrand]: true
  entity: GeoJsonEntity
  crs: typeof GEOJSON_CRS84
  bounds: GeoJsonBounds | null
  sourceCrs: string
  reprojected: boolean
}

/**
 * GeoJSON 的单一 CRS 入口。无 CRS 的输入必须已经是 RFC 7946/CRS84；
 * 投影坐标只有在显式声明源 CRS 后才会进入确定性重投影。
 */
export function normalizeGeoJsonToCrs84(
  value: unknown,
  label = 'GeoJSON',
  declaredCrs?: unknown,
): CanonicalGeoJson {
  const embeddedCrs = readEmbeddedCrs(value, label)
  const externalCrs = declaredCrs === undefined || declaredCrs === null
    ? null
    : normalizeCrsIdentifier(declaredCrs, `${label} CRS`)
  if (embeddedCrs && externalCrs && embeddedCrs !== externalCrs) {
    throw new Error(`${label} 的内嵌 CRS '${embeddedCrs}' 与引用 CRS '${externalCrs}' 冲突`)
  }
  const sourceCrs = embeddedCrs ?? externalCrs ?? GEOJSON_CRS84
  const withoutCrs = stripEmbeddedCrs(value)
  const parsed = sourceCrs === GEOJSON_CRS84
    ? parseGeoJsonEntity(withoutCrs, label)
    : parseProjectedGeoJsonEntity(withoutCrs, label)
  const entity = sourceCrs === GEOJSON_CRS84
    ? parsed
    : transformEntity(parsed, sourceCrs, GEOJSON_CRS84)
  // transformGeometry 在产生每个目标位置时立即验证 CRS84 数值域；几何结构
  // 已由源解析验证，因此不再对整棵结果做第二次重复 parse。
  return {
    [canonicalGeoJsonBrand]: true,
    entity,
    crs: GEOJSON_CRS84,
    bounds: computeCrs84Bounds(entity),
    sourceCrs,
    reprojected: sourceCrs !== GEOJSON_CRS84,
  }
}

export function geoJsonSpatialMetadata(value: Pick<CanonicalGeoJson, 'crs' | 'bounds' | 'sourceCrs' | 'reprojected'>) {
  return {
    crs: value.crs,
    ...(value.bounds ? { bounds: value.bounds } : {}),
    sourceCrs: value.sourceCrs,
    reprojected: value.reprojected,
  }
}

function computeCrs84Bounds(entity: GeoJsonEntity): GeoJsonBounds | null {
  let west = Number.POSITIVE_INFINITY
  let east = Number.NEGATIVE_INFINITY
  let south = Number.POSITIVE_INFINITY
  let north = Number.NEGATIVE_INFINITY
  let positionCount = 0
  forEachEntityPosition(entity, position => {
    positionCount += 1
    west = Math.min(west, position[0])
    east = Math.max(east, position[0])
    south = Math.min(south, position[1])
    north = Math.max(north, position[1])
  })
  if (positionCount === 0) return null

  // 绝大多数数据不跨反经线，可以在一次常量内存扫描后直接返回。只有原始
  // 经度跨度超过 180° 时才做第二次扫描和排序，以求精确的最短环形区间。
  // 这样既不对大数据展开 Math.min(...array)，也不为常见输入复制坐标数组。
  if (east - west > 180) {
    const longitudes: number[] = []
    forEachEntityPosition(entity, position => longitudes.push(position[0]))
    const [minimalWest, minimalEast] = minimalLongitudeBounds(longitudes)
    west = minimalWest
    east = minimalEast
  }
  const [paddedWest, paddedEast] = padDegenerateRange(west, east, -180, 180)
  const [paddedSouth, paddedNorth] = padDegenerateRange(south, north, -90, 90)
  return [paddedWest, paddedSouth, paddedEast, paddedNorth]
}

export function requireRenderableCrs84Bounds(
  bounds: GeoJsonBounds | null,
  label = 'GeoJSON',
): GeoJsonBounds {
  if (!bounds) throw new Error(`${label} 没有可制图坐标`)
  if (bounds[0] > bounds[2]) {
    throw new Error(`${label} 跨越反经线；当前地图 bounds 契约不接受 west > east，不能静默扩张为近全球范围`)
  }
  return bounds
}

function minimalLongitudeBounds(longitudes: number[]): [number, number] {
  longitudes.sort((left, right) => left - right)
  const first = longitudes[0]
  if (first === undefined) throw new Error('GeoJSON 不包含经度坐标')
  if (longitudes.length === 1) return [first, first]
  let largestGap = Number.NEGATIVE_INFINITY
  let gapStartIndex = 0
  for (let index = 0; index < longitudes.length; index += 1) {
    const current = longitudes[index]
    const next = index === longitudes.length - 1 ? first + 360 : longitudes[index + 1]
    if (current === undefined || next === undefined) continue
    const gap = next - current
    if (gap > largestGap) {
      largestGap = gap
      gapStartIndex = index
    }
  }
  const west = longitudes[(gapStartIndex + 1) % longitudes.length]
  const east = longitudes[gapStartIndex]
  if (west === undefined || east === undefined) throw new Error('GeoJSON 经度范围计算失败')
  return [west, east]
}

function transformEntity(entity: GeoJsonEntity, sourceCrs: string, targetCrs: string): GeoJsonEntity {
  const transformGeometry = createGeometryTransformer(sourceCrs, targetCrs)
  if (entity.type === 'FeatureCollection') {
    return {
      type: 'FeatureCollection',
      features: entity.features.map(feature => transformFeature(feature, transformGeometry)),
    }
  }
  return transformFeature(entity, transformGeometry)
}

function transformFeature(feature: GeoJsonFeature, transformGeometry: GeometryTransformer): GeoJsonFeature {
  return {
    ...feature,
    geometry: transformGeometry(feature.geometry),
  }
}

function readEmbeddedCrs(value: unknown, label: string): string | null {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'crs')) return null
  const crs = value.crs
  if (typeof crs === 'string' || typeof crs === 'number') {
    return normalizeCrsIdentifier(crs, `${label}.crs`)
  }
  if (!isRecord(crs)) throw new Error(`${label}.crs 必须是 CRS 字符串或命名 CRS 对象`)
  if (crs.type === 'name' && isRecord(crs.properties) && typeof crs.properties.name === 'string') {
    return normalizeCrsIdentifier(crs.properties.name, `${label}.crs.properties.name`)
  }
  if (crs.type === 'EPSG' && isRecord(crs.properties)) {
    return normalizeCrsIdentifier(crs.properties.code, `${label}.crs.properties.code`)
  }
  throw new Error(`${label}.crs 不支持外部链接或隐式定义；请使用明确的 EPSG 代码`)
}

function stripEmbeddedCrs(value: unknown): unknown {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'crs')) return value
  const { crs: _discarded, ...geojson } = value
  return geojson
}

function forEachEntityPosition(entity: GeoJsonEntity, visit: (position: Position) => void): void {
  if (entity.type === 'FeatureCollection') {
    for (const feature of entity.features) forEachGeometryPosition(feature.geometry, visit)
    return
  }
  forEachGeometryPosition(entity.geometry, visit)
}

function forEachGeometryPosition(geometry: Geometry, visit: (position: Position) => void): void {
  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries) forEachGeometryPosition(child, visit)
    return
  }
  forEachPosition(geometry.coordinates, visit)
}

function forEachPosition(value: unknown, visit: (position: Position) => void): void {
  if (!Array.isArray(value)) return
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    visit(value as Position)
    return
  }
  for (const child of value) forEachPosition(child, visit)
}

function padDegenerateRange(minimum: number, maximum: number, lower: number, upper: number): [number, number] {
  if (minimum !== maximum) return [minimum, maximum]
  const epsilon = 0.0001
  const paddedMinimum = Math.max(lower, minimum - epsilon)
  const paddedMaximum = Math.min(upper, maximum + epsilon)
  if (paddedMinimum < paddedMaximum) return [paddedMinimum, paddedMaximum]
  return minimum === lower ? [lower, lower + epsilon] : [upper - epsilon, upper]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

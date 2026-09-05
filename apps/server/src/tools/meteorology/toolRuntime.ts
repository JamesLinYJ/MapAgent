// +-------------------------------------------------------------------------
//
//   地理智能平台 - 气象工具运行时边界
//
//   文件:       toolRuntime.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import {
METEOROLOGICAL_BOUNDARY_SUFFIXES as BOUNDARY_SUFFIXES,METEOROLOGICAL_RADAR_SUFFIXES as RADAR_SUFFIXES,
METEOROLOGICAL_TOOL_FILE_SUFFIXES as METEOROLOGICAL_FILE_SUFFIXES
} from '@geo-agent-platform/shared-types/meteorology'

import type { ToolArtifact,ToolContext,ToolResult,ValueRef } from '../../framework/types.js'
import {
normalizeGeoJsonToCrs84,
type CanonicalGeoJson,
} from '../../gis/geojsonCrs.js'
import type { ArtifactDisplay,MapBounds,MapLayerStyle,MeteorologicalDatasetRecord } from '../../schemas/types.js'
import { atomicWriteText } from '../../store/durableFileIo.js'
import { makeId } from '../../utils/ids.js'
import type { MeteorologyToolDeps } from './toolDefinition.js'

export {  METEOROLOGICAL_FILE_SUFFIXES }
export const NETCDF_SUFFIXES = ['.nc', '.nc4']
export const RADAR_PRODUCTS = ['reflectivity', 'velocity', 'spectrum_width', 'zdr', 'cc', 'dp', 'kdp', 'snrh', 'echo_top']
export const BOUNDARY_REF_KINDS = ['meteorological_file', 'feature_collection', 'nowcast_area', 'layer']

export interface MeteorologicalDatasetLineage {
  datasetId: string
  contentHash: string
}

export interface MeteorologicalDatasetFile {
  name: string
  relativePath: string
  lineage: MeteorologicalDatasetLineage
}

const THIRD_PARTY_SOURCE_SNAPSHOTS = {
  radar_mosaic_agent: 'packages/gis-meteorology/src/gis_meteorology/third_party/radar_mosaic_agent/source/original',
  rainfall_risk_map: 'packages/gis-meteorology/src/gis_meteorology/third_party/rainfall_risk_map/source/original',
  short_term_forecast: 'packages/gis-meteorology/src/gis_meteorology/third_party/short_term_forecast/source/original',
} as const
const THIRD_PARTY_WRAPPER_VERSION = 'geo-agent-platform-wrapper-2026-06-23'

export function result(
  name: string,
  message: string,
  payload: Record<string, unknown>,
  valueRefs: ValueRef[],
  artifacts: MeteorologicalArtifactTarget[] = [],
  provenance: Record<string, unknown> = {},
): ToolResult {
  return {
    message,
    payload,
    warnings: [],
    resultId: makeId('result'),
    source: `gis_meteorology.${name}`,
    valueRefs,
    artifacts,
    provenance: { backend: 'gis_meteorology', ...provenance },
  }
}

export function resultRefs(
  name: string,
  label: string,
  payload: Record<string, unknown>,
  lineage?: MeteorologicalDatasetLineage,
  variable?: string | null,
): ValueRef[] {
  const unit = textValue(payload.unit) ?? textValue(payload.units)
  const refs: ValueRef[] = [{
    refId: makeId('ref'), kind: `${name}_result`, label, value: payload,
    ...(unit ? { unit } : {}),
    ...(lineage ? { metadata: meteorologicalLineageMetadata(lineage, variable) } : {}),
  }]
  if (name === 'meteorological_stats') {
    for (const key of ['min', 'mean', 'median', 'p50', 'p90', 'max']) {
      const value = payload[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      refs.push({
        refId: makeId('ref'), kind: 'meteorological_threshold', label: `${label} / ${key}`, value,
        unit,
        ...(lineage ? { metadata: meteorologicalLineageMetadata(lineage, variable) } : {}),
      })
    }
    const levels = ['min', 'p50', 'p90', 'max']
      .map(key => payload[key])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (levels.length >= 2) refs.push({
      refId: makeId('ref'), kind: 'meteorological_contour_levels', label: `${label} / 等值线层级`,
      value: [...new Set(levels)],
      unit,
      ...(lineage ? { metadata: meteorologicalLineageMetadata(lineage, variable) } : {}),
    })
  }
  return refs
}

function requiredRef(ctx: ToolContext, args: Record<string, unknown>, key: string): ValueRef {
  const refId = args[key]
  if (typeof refId !== 'string' || !refId.trim()) throw new Error(`${key} 不能为空`)
  return ctx.resolveValueRef(refId)
}

export function requiredRefKind(ctx: ToolContext, args: Record<string, unknown>, key: string, kinds: string[]): ValueRef {
  const ref = requiredRef(ctx, args, key)
  if (!kinds.includes(ref.kind)) throw new Error(`${key} 必须引用 ${kinds.join(' 或 ')}，实际为 ${ref.kind}`)
  return ref
}

export async function datasetFileFromArgs(
  ctx: ToolContext,
  args: Record<string, unknown>,
  refKey: string,
  allowedKinds: string[],
): Promise<MeteorologicalDatasetFile> {
  const refId = typeof args[refKey] === 'string' ? String(args[refKey]).trim() : ''
  if (refId) {
    if (refId === 'latest_upload') {
      throw new Error(`${refKey} 只接受 valueRef ID；当前 thread 最新上传请使用 dataset_id='latest_upload'`)
    }
    return verifiedDatasetValue(ctx, requiredRefKind(ctx, args, refKey, allowedKinds), refKey)
  }

  const datasetId = typeof args.dataset_id === 'string' && args.dataset_id.trim()
    ? args.dataset_id.trim()
    : null
  const filename = typeof args.filename === 'string' && args.filename.trim() ? args.filename.trim() : null
  if (!ctx.resolveMeteorologicalDataset) {
    throw new Error('当前运行上下文不支持解析气象数据集')
  }
  const usesCurrentThread = !datasetId || datasetId === 'latest_upload'
  if (usesCurrentThread && !ctx.threadId) {
    throw new Error('当前运行没有 threadId，不能解析 latest_upload')
  }
  const dataset = await ctx.resolveMeteorologicalDataset(usesCurrentThread
    ? { selector: 'current_thread_latest', filename }
    : { selector: 'explicit_dataset_id', datasetId })
  if (!dataset) {
    throw new Error('当前 thread 没有可用的气象数据集；请先上传 NetCDF、GRIB、GeoTIFF、HDF5 或雷达 bz2 文件。')
  }
  if (dataset.status !== 'ready') throw new Error(`气象数据集 '${dataset.datasetId}' 状态为 ${dataset.status}，尚不可执行`)
  return {
    name: dataset.filename,
    relativePath: dataset.fileRelativePath,
    lineage: requireMeteorologicalLineage({
      refId: dataset.datasetId,
      kind: 'meteorological_dataset',
      label: dataset.filename,
      value: { datasetId: dataset.datasetId, contentHash: dataset.contentHash },
    }, 'resolved dataset'),
  }
}

function datasetValue(_ctx: ToolContext, ref: ValueRef): { name: string; relativePath: string } {
  const value = refObject(ref.value)
  const relativePath = typeof value.relativePath === 'string'
    ? value.relativePath
    : typeof value.datasetRelativePath === 'string' ? value.datasetRelativePath : ''
  if (!relativePath) throw new Error(`引用 "${ref.refId}" 不包含数据文件路径`)
  return { name: typeof value.name === 'string' ? value.name : ref.label, relativePath }
}

function lineagedDatasetValue(ctx: ToolContext, ref: ValueRef, key = 'dataset_ref'): MeteorologicalDatasetFile {
  return { ...datasetValue(ctx, ref), lineage: requireMeteorologicalLineage(ref, key) }
}

export async function verifiedDatasetValue(
  ctx: ToolContext,
  ref: ValueRef,
  key = 'dataset_ref',
): Promise<MeteorologicalDatasetFile> {
  const claimed = lineagedDatasetValue(ctx, ref, key)
  if (!ctx.resolveMeteorologicalDataset) throw new Error('当前运行上下文不支持校验气象数据集血缘')
  const dataset = await ctx.resolveMeteorologicalDataset({
    selector: 'explicit_dataset_id',
    datasetId: claimed.lineage.datasetId,
  })
  if (!dataset) throw new Error(`${key} 引用的数据集不存在或当前 workspace/session 未授权`)
  return verifyPersistedDatasetClaim(claimed, dataset, key)
}

function verifyPersistedDatasetClaim(
  claimed: MeteorologicalDatasetFile,
  dataset: MeteorologicalDatasetRecord | null,
  key: string,
): MeteorologicalDatasetFile {
  if (!dataset) throw new Error(`${key} 引用的数据集不存在或当前 workspace/session 未授权`)
  if (dataset.status !== 'ready') throw new Error(`${key} 引用的数据集状态为 ${dataset.status}，尚不可执行`)
  const persistedLineage = requireMeteorologicalLineage({
    refId: dataset.datasetId,
    kind: 'meteorological_dataset',
    label: dataset.filename,
    value: { datasetId: dataset.datasetId, contentHash: dataset.contentHash },
  }, `${key} persisted dataset`)
  if (!sameMeteorologicalLineage(claimed.lineage, persistedLineage)) {
    throw new Error(`${key} 的 contentHash 已过期或与持久化数据集不匹配`)
  }
  if (claimed.relativePath !== dataset.fileRelativePath || claimed.name !== dataset.filename) {
    throw new Error(`${key} 的文件路径或文件名与持久化数据集不匹配`)
  }
  return { name: dataset.filename, relativePath: dataset.fileRelativePath, lineage: persistedLineage }
}

export function meteorologicalLineageMetadata(
  lineage: MeteorologicalDatasetLineage,
  variable?: string | null,
): Record<string, string> {
  return {
    datasetId: lineage.datasetId,
    contentHash: lineage.contentHash,
    ...(variable?.trim() ? { variable: variable.trim() } : {}),
  }
}

export function requireMeteorologicalLineage(ref: ValueRef, key: string): MeteorologicalDatasetLineage {
  const value = isRecord(ref.value) ? ref.value : null
  const valueLineage = readMeteorologicalLineage(value)
  const metadataLineage = readMeteorologicalLineage(ref.metadata)
  if (valueLineage && metadataLineage && !sameMeteorologicalLineage(valueLineage, metadataLineage)) {
    throw new Error(`${key} 的 value 与 metadata 数据集血缘冲突`)
  }
  const lineage = valueLineage ?? metadataLineage
  if (!lineage) throw new Error(`${key} 缺少不可变 datasetId/contentHash 血缘`)
  return lineage
}

export function requireMatchingMeteorologicalLineage(
  ref: ValueRef,
  expected: MeteorologicalDatasetLineage,
  key: string,
): ValueRef {
  const actual = requireMeteorologicalLineage(ref, key)
  if (!sameMeteorologicalLineage(actual, expected)) {
    throw new Error(`${key} 属于数据集 ${actual.datasetId}@${actual.contentHash}，与 dataset_ref ${expected.datasetId}@${expected.contentHash} 不匹配`)
  }
  return ref
}

export function requireMatchingMeteorologicalVariable(ref: ValueRef, expectedVariable: string, key: string): ValueRef {
  const expected = expectedVariable.trim()
  const value = isRecord(ref.value) ? ref.value : null
  const actual = textValue(ref.metadata?.variable)
    ?? (value ? textValue(value.variable) ?? textValue(value.name) : null)
  if (!actual) throw new Error(`${key} 缺少变量血缘`)
  if (actual !== expected) throw new Error(`${key} 属于变量 ${actual}，与 variable_ref ${expected} 不匹配`)
  return ref
}

export function valueRefUnit(ref: ValueRef): string | null {
  if (typeof ref.unit === 'string' && ref.unit.trim()) return ref.unit.trim()
  if (isRecord(ref.value)) {
    const direct = textValue(ref.value.unit) ?? textValue(ref.value.units)
    if (direct) return direct
    if (isRecord(ref.value.metadata)) {
      const nested = textValue(ref.value.metadata.unit) ?? textValue(ref.value.metadata.units)
      if (nested) return nested
    }
  }
  return textValue(ref.metadata?.unit) ?? textValue(ref.metadata?.units)
}

export function convertMeteorologicalUnitValue(
  value: number,
  sourceUnit: string | null,
  targetUnit: string | null,
  key: string,
): number {
  if (!sourceUnit || !targetUnit) {
    throw new Error(`${key} 与变量必须同时声明单位，不能隐式假定单位一致`)
  }
  const sourceKey = normalizeUnitKey(sourceUnit)
  const targetKey = normalizeUnitKey(targetUnit)
  if (sourceKey === targetKey) return value
  const source = UNIT_CONVERSIONS[sourceKey]
  const target = UNIT_CONVERSIONS[targetKey]
  if (!source || !target || source.dimension !== target.dimension) {
    throw new Error(`${key} 单位 ${sourceUnit} 与变量单位 ${targetUnit} 不兼容`)
  }
  return target.fromBase(source.toBase(value))
}

function readMeteorologicalLineage(record: Record<string, unknown> | undefined | null): MeteorologicalDatasetLineage | null {
  if (!record) return null
  const datasetId = typeof record.datasetId === 'string' ? record.datasetId.trim() : ''
  const contentHash = typeof record.contentHash === 'string' ? record.contentHash.trim() : ''
  return datasetId && contentHash ? { datasetId, contentHash } : null
}

function sameMeteorologicalLineage(left: MeteorologicalDatasetLineage, right: MeteorologicalDatasetLineage): boolean {
  return left.datasetId === right.datasetId && left.contentHash === right.contentHash
}

interface UnitConversion {
  dimension: 'length' | 'pressure' | 'speed' | 'temperature'
  toBase(value: number): number
  fromBase(value: number): number
}

const linearUnit = (dimension: UnitConversion['dimension'], scale: number): UnitConversion => ({
  dimension,
  toBase: value => value * scale,
  fromBase: value => value / scale,
})

const kelvinUnit: UnitConversion = { dimension: 'temperature', toBase: value => value, fromBase: value => value }
const celsiusUnit: UnitConversion = { dimension: 'temperature', toBase: value => value + 273.15, fromBase: value => value - 273.15 }
const fahrenheitUnit: UnitConversion = {
  dimension: 'temperature',
  toBase: value => (value - 32) * 5 / 9 + 273.15,
  fromBase: value => (value - 273.15) * 9 / 5 + 32,
}

const UNIT_CONVERSIONS: Record<string, UnitConversion> = {
  k: kelvinUnit, kelvin: kelvinUnit,
  c: celsiusUnit, degc: celsiusUnit, celsius: celsiusUnit,
  f: fahrenheitUnit, degf: fahrenheitUnit, fahrenheit: fahrenheitUnit,
  m: linearUnit('length', 1), meter: linearUnit('length', 1), metre: linearUnit('length', 1),
  cm: linearUnit('length', 0.01),
  mm: linearUnit('length', 0.001), millimeter: linearUnit('length', 0.001), millimetre: linearUnit('length', 0.001),
  'kgm-2': linearUnit('length', 0.001), 'kg/m2': linearUnit('length', 0.001), 'kg/m^2': linearUnit('length', 0.001),
  pa: linearUnit('pressure', 1), hpa: linearUnit('pressure', 100), mbar: linearUnit('pressure', 100),
  'm/s': linearUnit('speed', 1), 'ms-1': linearUnit('speed', 1), 'km/h': linearUnit('speed', 1 / 3.6),
}

function normalizeUnitKey(unit: string): string {
  return unit.trim().toLowerCase().replace(/°/gu, 'deg').replace(/\s+/gu, '')
}

type MeteorologicalArtifactExt = 'png' | 'tif' | 'geojson' | 'docx' | 'xlsx' | 'npz'

export type MeteorologicalArtifactTarget = ToolArtifact & {
  relativePath: string
  metadata: Record<string, unknown>
}

export type CanonicalGeoJsonArtifact = CanonicalGeoJson & {
  serializedContent: string
  sizeBytes: number
  featureCount: number
}

export function artifactTarget(ctx: ToolContext, artifactType: MeteorologicalArtifactExt, name: string): MeteorologicalArtifactTarget {
  const artifactId = makeId('artifact')
  const relativePath = path.posix.join('artifacts', ctx.runId, `${artifactId}.${artifactType}`)
  return {
    artifactId, artifactType: artifactKind(artifactType), name,
    uri: `/api/v1/results/${artifactId}/${artifactType === 'geojson' ? 'geojson' : 'file'}`,
    display: {
      surfaces: ['download'],
      primarySurface: 'download',
      map: null,
    },
    relativePath,
    metadata: { relativePath },
  }
}

function artifactKind(ext: MeteorologicalArtifactExt): string {
  if (ext === 'png') return 'raster_png'
  return ext
}

export function thirdPartyProvenance(
  source: keyof typeof THIRD_PARTY_SOURCE_SNAPSHOTS,
  inputRefs: Record<string, unknown>,
  artifacts: MeteorologicalArtifactTarget[] = [],
): Record<string, unknown> {
  return {
    thirdPartySource: source,
    sourceSnapshot: THIRD_PARTY_SOURCE_SNAPSHOTS[source],
    wrapperVersion: THIRD_PARTY_WRAPPER_VERSION,
    inputRefs,
    outputArtifacts: artifacts.map(artifact => ({
      artifactId: artifact.artifactId,
      artifactType: artifact.artifactType,
      relativePath: artifact.relativePath,
    })),
  }
}

export function mergeArtifactMetadata(
  artifact: MeteorologicalArtifactTarget,
  payload: Record<string, unknown>,
  display?: ArtifactDisplay,
): void {
  const { displaySurfaces: _legacySurfaces, primarySurface: _legacyPrimary, ...metadata } = payload
  artifact.metadata = { ...metadata, relativePath: artifact.relativePath }
  if (display) artifact.display = display
}

export function miniAppDisplay(): ArtifactDisplay {
  return { surfaces: ['mini_app', 'download'], primarySurface: 'mini_app', map: null }
}

export function downloadDisplay(): ArtifactDisplay {
  return { surfaces: ['download'], primarySurface: 'download', map: null }
}

export function rasterImageDisplay(
  artifact: MeteorologicalArtifactTarget,
  payload: Record<string, unknown>,
  title = artifact.name,
): ArtifactDisplay {
  const bounds = requireMapBounds(payload.bounds, `${title} bounds`)
  const coordinates = mapCoordinates(payload.coordinates, bounds)
  const range = valueRange(payload.valueRange)
  const unit = textValue(payload.unit) ?? textValue(payload.units)
  const colorStops = precipitationColorStops(range, textValue(payload.variable))
  return {
    surfaces: ['map', 'download'],
    primarySurface: 'map',
    map: {
      title,
      replacementGroup: null,
      bounds,
      crs: 'EPSG:4326',
      minZoom: 0,
      maxZoom: 22,
      source: { kind: 'raster_image', url: artifact.uri, coordinates },
      style: {
        kind: 'continuous_raster',
        rangeMode: 'data',
        dataRange: range,
        renderRange: range,
        colorStops,
        opacity: 0.86,
      },
      legend: {
        kind: 'continuous',
        title,
        unit,
        range,
        stops: colorStops,
        nodataLabel: '无数据',
      },
      temporal: null,
      capabilities: {
        query: false,
        labels: false,
        style: true,
        temporal: false,
        opacity: true,
        download: true,
      },
    },
  }
}

export function rasterTileDisplay(
  artifact: MeteorologicalArtifactTarget,
  payload: Record<string, unknown>,
  title = artifact.name,
  replacementGroup: string | null = null,
): ArtifactDisplay {
  const bounds = requireMapBounds(payload.bounds, `${title} bounds`)
  const range = valueRange(payload.valueRange)
  const unit = textValue(payload.unit) ?? textValue(payload.units)
  const colorStops = precipitationColorStops(range, textValue(payload.variable))
  return {
    surfaces: ['map', 'download'],
    primarySurface: 'map',
    map: {
      title,
      replacementGroup,
      bounds,
      crs: 'EPSG:4326',
      minZoom: 0,
      maxZoom: 22,
      source: {
        kind: 'raster_tiles',
        tileJsonUrl: `/api/v1/map/layers/map_layer_${artifact.artifactId}/tilejson`,
        tileSize: 256,
      },
      style: {
        kind: 'continuous_raster',
        rangeMode: 'data',
        dataRange: range,
        renderRange: range,
        colorStops,
        opacity: 0.9,
      },
      legend: {
        kind: 'continuous',
        title,
        unit,
        range,
        stops: colorStops,
        nodataLabel: '无数据',
      },
      temporal: null,
      capabilities: {
        query: false,
        labels: false,
        style: true,
        temporal: false,
        opacity: true,
        download: true,
      },
    },
  }
}

export function geoJsonDisplay(
  artifact: MeteorologicalArtifactTarget,
  payload: Record<string, unknown>,
  styleKind: 'line' | 'polygon',
  options: {
    title?: string
    bounds?: unknown
    colorField?: string | null
    categories?: Array<{ value: string | number | boolean; label: string; color: string }>
    legendTitle?: string
    coordinateCrs?: string
    featureCount?: number
    sizeBytes?: number
  } = {},
): ArtifactDisplay {
  const title = options.title ?? artifact.name
  const bounds = requireMapBounds(options.bounds ?? payload.bounds ?? geoJsonBounds(payload), `${title} bounds`)
  const features = options.featureCount
    ?? (Array.isArray(payload.features) ? payload.features.length : payload.type === 'Feature' ? 1 : 0)
  const sizeBytes = options.sizeBytes ?? Buffer.byteLength(JSON.stringify(payload), 'utf8')
  const categories = options.categories ?? []
  const style: MapLayerStyle = styleKind === 'line'
    ? {
        kind: 'line', opacity: 1, colorField: options.colorField ?? null, categories,
        color: '#1769aa', width: 2, dashArray: null,
      }
    : {
        kind: 'polygon', opacity: 0.72, colorField: options.colorField ?? null, categories,
        color: '#2e8b70', outlineColor: '#145c4a', outlineWidth: 1,
      }
  return {
    surfaces: ['map', 'download'],
    primarySurface: 'map',
    map: {
      title,
      replacementGroup: null,
      bounds,
      crs: options.coordinateCrs ?? 'EPSG:4326',
      minZoom: 0,
      maxZoom: 22,
      source: { kind: 'geojson', url: artifact.uri, featureCount: features, sizeBytes },
      style,
      legend: categories.length
        ? { kind: 'categorical', title: options.legendTitle ?? title, categories }
        : null,
      temporal: null,
      capabilities: {
        query: true,
        labels: styleKind === 'line',
        style: true,
        temporal: false,
        opacity: true,
        download: true,
      },
    },
  }
}

function requireMapBounds(value: unknown, label: string): MapBounds {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(item => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error(`${label} 缺少有效的 WGS84 范围`)
  }
  const [west, south, east, north] = value as [number, number, number, number]
  if (west >= east || south >= north || west < -180 || east > 180 || south < -90 || north > 90) {
    throw new Error(`${label} 不是有效的 WGS84 范围`)
  }
  return [west, south, east, north]
}

function mapCoordinates(value: unknown, bounds: MapBounds): [[number, number], [number, number], [number, number], [number, number]] {
  if (Array.isArray(value) && value.length === 4 && value.every(item =>
    Array.isArray(item) && item.length === 2 && item.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate)),
  )) {
    return value as [[number, number], [number, number], [number, number], [number, number]]
  }
  const [west, south, east, north] = bounds
  return [[west, north], [east, north], [east, south], [west, south]]
}

function valueRange(value: unknown): [number, number] {
  const record = isRecord(value) ? value : null
  const rawMin = record?.min
  const rawMax = record?.max
  const min = typeof rawMin === 'number' && Number.isFinite(rawMin) ? rawMin : 0
  const max = typeof rawMax === 'number' && Number.isFinite(rawMax) ? rawMax : min + 1
  return max > min ? [min, max] : [min, min + 1]
}

function precipitationColorStops(range: [number, number], variable: string | null) {
  const [min, max] = range
  const at = (ratio: number) => min + ((max - min) * ratio)
  const transparentMinimum = min === 0 && isZeroTransparentMeteorologicalVariable(variable)
  return [
    { value: min, color: transparentMinimum ? '#f7fbff00' : '#f7fbff' },
    { value: at(0.2), color: '#9ecae1' },
    { value: at(0.4), color: '#41ab5d' },
    { value: at(0.6), color: '#fdd835' },
    { value: at(0.8), color: '#f57c00' },
    { value: max, color: '#b71c1c' },
  ]
}

function isZeroTransparentMeteorologicalVariable(variable: string | null): boolean {
  if (!variable) return false
  return /(?:^|_)(?:qpf(?:_\d+)?|precipitation|rainfall|rain|thunder)(?:$|_)/iu.test(variable)
}

function geoJsonBounds(value: unknown): MapBounds | null {
  if (!isRecord(value) || !Array.isArray(value.features)) return null
  const positions: Array<[number, number]> = []
  for (const feature of value.features) collectGeoJsonPositions(isRecord(feature) ? feature.geometry : null, positions)
  if (!positions.length) return null
  const xs = positions.map(position => position[0])
  const ys = positions.map(position => position[1])
  return requireMapBounds([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], 'GeoJSON bounds')
}

function collectGeoJsonPositions(value: unknown, positions: Array<[number, number]>): void {
  if (!isRecord(value)) return
  if (value.type === 'GeometryCollection' && Array.isArray(value.geometries)) {
    for (const geometry of value.geometries) collectGeoJsonPositions(geometry, positions)
    return
  }
  collectCoordinateArray(value.coordinates, positions)
}

function collectCoordinateArray(value: unknown, positions: Array<[number, number]>): void {
  if (!Array.isArray(value)) return
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    positions.push([value[0], value[1]])
    return
  }
  for (const child of value) collectCoordinateArray(child, positions)
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function writeJsonArtifact(
  deps: MeteorologyToolDeps,
  relativePath: string,
  payload: Record<string, unknown>,
): Promise<CanonicalGeoJsonArtifact> {
  const canonical = normalizeGeoJsonToCrs84(payload, `气象 Worker GeoJSON '${relativePath}'`)
  const artifact = serializeCanonicalGeoJson(canonical)
  await atomicWriteText(resolveRuntimeArtifactPath(deps.runtimeRoot, relativePath), artifact.serializedContent)
  return artifact
}

export async function normalizeGeoJsonArtifactFile(
  deps: MeteorologyToolDeps,
  relativePath: string,
  declaredCrs?: unknown,
): Promise<CanonicalGeoJsonArtifact> {
  const target = resolveRuntimeArtifactPath(deps.runtimeRoot, relativePath)
  let payload: unknown
  try {
    payload = JSON.parse(await readFile(target, 'utf8'))
  } catch (error) {
    throw new Error(`气象 Worker GeoJSON '${relativePath}' 无法读取或不是有效 JSON`, { cause: error })
  }
  const canonical = normalizeGeoJsonToCrs84(payload, `气象 Worker GeoJSON '${relativePath}'`, declaredCrs)
  const artifact = serializeCanonicalGeoJson(canonical)
  await atomicWriteText(target, artifact.serializedContent)
  return artifact
}

function serializeCanonicalGeoJson(canonical: CanonicalGeoJson): CanonicalGeoJsonArtifact {
  const serializedContent = JSON.stringify(canonical.entity)
  return {
    ...canonical,
    serializedContent,
    sizeBytes: Buffer.byteLength(serializedContent, 'utf8'),
    featureCount: canonical.entity.type === 'FeatureCollection' ? canonical.entity.features.length : 1,
  }
}

function resolveRuntimeArtifactPath(runtimeRoot: string, relativePath: string): string {
  const root = path.resolve(runtimeRoot)
  const target = path.resolve(root, relativePath)
  if (!target.startsWith(root + path.sep)) throw new Error('artifact 路径越出 runtime 根目录')
  return target
}

export function inputKind(name: string): 'dataset' | 'radar' | 'boundary' {
  const lower = name.toLowerCase()
  if (RADAR_SUFFIXES.some(suffix => lower.endsWith(suffix))) return 'radar'
  if (BOUNDARY_SUFFIXES.some(suffix => lower.endsWith(suffix))) return 'boundary'
  return 'dataset'
}

function collectionFiles(collection: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const files = collection.files
  if (!Array.isArray(files) || !files.length || !files.every(isRecord)) {
    throw new Error(`${key} 不包含文件集合`)
  }
  return files
}

export async function verifiedCollectionFiles(
  ctx: ToolContext,
  collection: Record<string, unknown>,
  key: string,
): Promise<Record<string, unknown>[]> {
  return verifiedFileObjects(ctx, collectionFiles(collection, key), `${key}.files`)
}

function sequenceFiles(sequence: Record<string, unknown>): Record<string, unknown>[] {
  const datasets = sequence.datasets
  if (!Array.isArray(datasets) || !datasets.length || !datasets.every(isRecord)) {
    throw new Error('nowcast_sequence 不包含 datasets')
  }
  return datasets.map((item, index) => {
    const relativePath = typeof item.relativePath === 'string' ? item.relativePath : ''
    if (!relativePath) throw new Error(`nowcast_sequence.datasets[${index}] 缺少 relativePath`)
    return {
      datasetId: typeof item.datasetId === 'string' ? item.datasetId : '',
      contentHash: typeof item.contentHash === 'string' ? item.contentHash : '',
      fileId: typeof item.datasetId === 'string' ? item.datasetId : `dataset_${index + 1}`,
      name: typeof item.filename === 'string' ? item.filename : path.posix.basename(relativePath),
      relativePath,
    }
  })
}

export async function verifiedSequenceFiles(
  ctx: ToolContext,
  sequence: Record<string, unknown>,
  key = 'sequence_ref',
): Promise<Record<string, unknown>[]> {
  return verifiedFileObjects(ctx, sequenceFiles(sequence), `${key}.datasets`)
}

async function verifiedFileObjects(
  ctx: ToolContext,
  files: Record<string, unknown>[],
  key: string,
): Promise<Record<string, unknown>[]> {
  if (!ctx.resolveMeteorologicalDatasets) throw new Error('当前运行上下文不支持批量校验气象数据集血缘')
  const claims = files.map((file, index) => ({
    file,
    claim: claimedDatasetFile(file, `${key}[${index}]`),
    itemKey: `${key}[${index}]`,
  }))
  const datasetIds = [...new Set(claims.map(item => item.claim.lineage.datasetId))]
  const datasets = await ctx.resolveMeteorologicalDatasets(datasetIds)
  const byId = new Map(datasets.map(dataset => [dataset.datasetId, dataset]))
  if (byId.size !== datasetIds.length) throw new Error(`${key} 包含不存在或未授权的气象数据集`)
  return claims.map(({ file, claim, itemKey }) => {
    const verified = verifyPersistedDatasetClaim(claim, byId.get(claim.lineage.datasetId) ?? null, itemKey)
    return canonicalFileObject(file, verified)
  })
}

export async function verifiedFileObject(
  ctx: ToolContext,
  file: Record<string, unknown>,
  key: string,
): Promise<Record<string, unknown>> {
  const verified = await verifiedDatasetValue(ctx, datasetFileRef(file, key), key)
  return canonicalFileObject(file, verified)
}

export function meteorologicalMembersFingerprint(files: Record<string, unknown>[]): string {
  const members = files.map((file, index) => {
    const datasetId = typeof file.datasetId === 'string' ? file.datasetId.trim() : ''
    const contentHash = typeof file.contentHash === 'string' ? file.contentHash.trim() : ''
    if (!datasetId || !contentHash) throw new Error(`气象文件集第 ${index + 1} 项缺少 datasetId/contentHash`)
    return `${datasetId}@${contentHash}`
  }).sort()
  return createHash('sha256').update(members.join('\n')).digest('hex')
}

function claimedDatasetFile(file: Record<string, unknown>, key: string): MeteorologicalDatasetFile {
  const ref = datasetFileRef(file, key)
  const value = refObject(ref.value)
  const relativePath = typeof value.relativePath === 'string' ? value.relativePath : ''
  if (!relativePath) throw new Error(`${key} 不包含数据文件路径`)
  return {
    name: typeof value.name === 'string' ? value.name : ref.label,
    relativePath,
    lineage: requireMeteorologicalLineage(ref, key),
  }
}

function datasetFileRef(file: Record<string, unknown>, key: string): ValueRef {
  const datasetId = typeof file.datasetId === 'string' ? file.datasetId.trim() : ''
  const contentHash = typeof file.contentHash === 'string' ? file.contentHash.trim() : ''
  const name = typeof file.name === 'string' ? file.name.trim() : typeof file.filename === 'string' ? file.filename.trim() : ''
  const relativePath = typeof file.relativePath === 'string' ? file.relativePath.trim() : ''
  return {
    refId: datasetId || key,
    kind: 'meteorological_file',
    label: name || key,
    value: { datasetId, contentHash, name, relativePath },
    metadata: { datasetId, contentHash },
  }
}

function canonicalFileObject(file: Record<string, unknown>, verified: MeteorologicalDatasetFile): Record<string, unknown> {
  return {
    ...file,
    datasetId: verified.lineage.datasetId,
    contentHash: verified.lineage.contentHash,
    fileId: typeof file.fileId === 'string' && file.fileId.trim() ? file.fileId : verified.lineage.datasetId,
    name: verified.name,
    filename: verified.name,
    relativePath: verified.relativePath,
  }
}

export function assertSuffix(filename: string, suffixes: ReadonlyArray<string>, label: string): void {
  const lower = filename.toLowerCase()
  if (!suffixes.some(suffix => lower.endsWith(suffix))) {
    throw new Error(`${label} 文件类型不受支持: ${filename}`)
  }
}

export function assertFileObjectsSuffix(files: Record<string, unknown>[], suffixes: ReadonlyArray<string>, label: string): void {
  for (const [index, file] of files.entries()) {
    const name = typeof file.name === 'string' ? file.name : typeof file.filename === 'string' ? file.filename : ''
    if (!name) throw new Error(`${label} 文件集合第 ${index + 1} 项缺少 name`)
    assertSuffix(name, suffixes, label)
  }
}

export async function boundaryInputRelativePath(ctx: ToolContext, args: Record<string, unknown>, key: string, deps: MeteorologyToolDeps): Promise<string> {
  const ref = requiredRefKind(ctx, args, key, BOUNDARY_REF_KINDS)
  if (ref.kind === 'meteorological_file') {
    const file = await verifiedDatasetValue(ctx, ref, key)
    assertSuffix(file.name, BOUNDARY_SUFFIXES, '边界')
    return file.relativePath
  }
  const payload = featureCollectionFromBoundaryRef(ref, key)
  const relativePath = path.posix.join('artifacts', ctx.runId, `${makeId('boundary')}.geojson`)
  await writeJsonArtifact(deps, relativePath, {
    ...payload,
    ...(ref.metadata?.crs ? { crs: ref.metadata.crs } : {}),
  })
  return relativePath
}

type FeatureCollectionRecord = Record<string, unknown> & { type: 'FeatureCollection'; features: unknown[] }

export function featureCollectionFromBoundaryRef(ref: ValueRef, key: string): FeatureCollectionRecord {
  const payload = ref.kind === 'layer' ? refObject(ref.value).featureCollection : ref.value
  if (!isFeatureCollectionRecord(payload)) {
    if (ref.kind === 'layer') {
      throw new Error(`${key} 的 layer 引用缺少 featureCollection，请先使用 query_layer 生成 feature_collection 引用`)
    }
    throw new Error(`${key} 必须是 FeatureCollection、layer 或边界文件引用`)
  }
  return payload
}

function isFeatureCollectionRecord(value: unknown): value is FeatureCollectionRecord {
  return isRecord(value) && value.type === 'FeatureCollection' && Array.isArray(value.features)
}

export function coordinateFromRef(ref: ValueRef): { lat: number; lng: number; label: string } {
  const payload = refObject(ref.value)
  const lat = Number(payload.lat)
  const lng = Number(payload.lng ?? payload.lon)
  const label = typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : ref.label
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`scope_ref '${ref.refId}' 不包含有效经纬度`)
  }
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    throw new Error(`scope_ref '${ref.refId}' 坐标必须是 CRS84 [经度, 纬度] 有效范围`)
  }
  return { lat, lng, label }
}

export function normalizeThresholds(value: unknown): Array<{ label: string; min: number; max: number; color: string }> {
  const raw = value === undefined || value === null ? defaultRainfallThresholds() : value
  const parsed = typeof raw === 'string' ? parseJson(raw, 'thresholds') : raw
  const array = isRecord(parsed) && Array.isArray(parsed.thresholds) ? parsed.thresholds : parsed
  if (!Array.isArray(array)) throw new Error('thresholds 必须是数组或包含 thresholds 数组的对象')
  const thresholds = array.map((item, index) => {
    if (!isRecord(item)) throw new Error(`thresholds[${index}] 必须是对象`)
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    const min = Number(item.min)
    const max = Number(item.max)
    const color = typeof item.color === 'string' ? item.color.trim() : ''
    if (!label || !Number.isFinite(min) || !Number.isFinite(max) || max <= min || !/^#[0-9a-f]{6}$/iu.test(color)) {
      throw new Error(`thresholds[${index}] 必须包含 label、递增 min/max 和 #RRGGBB color`)
    }
    return { label, min, max, color }
  }).sort((a, b) => a.min - b.min)
  if (!thresholds.length) throw new Error('thresholds 不能为空')
  return thresholds
}

export function defaultRainfallThresholds() {
  return [
    { label: '无雨/小雨', min: 0, max: 1.5, color: '#f0f0f0' },
    { label: '短时大雨', min: 1.5, max: 3, color: '#a6d96a' },
    { label: '短时暴雨', min: 3, max: 5, color: '#1a9850' },
    { label: '短时大暴雨', min: 5, max: 8, color: '#fdae61' },
    { label: '短时大暴雨~特大暴雨', min: 8, max: 12, color: '#d73027' },
    { label: '短时特大暴雨', min: 12, max: 999, color: '#7a0177' },
  ]
}

export function rainfallThresholdsSchema(): Record<string, unknown> {
  return {
    type: 'array',
    minItems: 1,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'min', 'max', 'color'],
      properties: {
        label: { type: 'string', minLength: 1 },
        min: { type: 'number' },
        max: { type: 'number' },
        color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
      },
    },
  }
}

export function areaRainfallStyleSchema(): Record<string, unknown> {
  const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      titleText: { type: 'string', minLength: 1 },
      titleColor: color,
      headerBg: color,
      headerColor: color,
      top3Bg: color,
      borderColor: color,
      dataColor: color,
      bgColor: color,
    },
  }
}

export function defaultAreaRainfallStyle(): Record<string, string> {
  return {
    titleText: '区域累计面雨量排行',
    titleColor: '#2E72D6',
    headerBg: '#E8F0FA',
    headerColor: '#333333',
    top3Bg: '#FFF2CC',
    borderColor: '#D0D0D0',
    dataColor: '#333333',
    bgColor: '#FFFFFF',
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${label} 不是合法 JSON`)
  }
}

export function requiredText(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 不能为空`)
  return value.trim()
}

export function selectNowcastMapCandidate(analysis: Record<string, unknown>): Record<string, unknown> {
  const candidates = Array.isArray(analysis.mapCandidates) ? analysis.mapCandidates.filter(isRecord) : []
  if (!candidates.length) throw new Error('短时临近预报（短临）分析没有可渲染的地图候选时次')
  const selected = candidates.find(candidate => candidate.reason === '降雨峰值时次') ?? candidates[0]
  if (!selected) throw new Error('短时临近预报（短临）分析没有有效地图候选时次')
  return selected
}

export function requiredCandidateText(candidate: Record<string, unknown>, key: string): string {
  const value = candidate[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`短时临近预报（短临）地图候选缺少 ${key}`)
  return value.trim()
}

export function nowcastRenderBbox(analysis: Record<string, unknown>): number[] | undefined {
  const scope = isRecord(analysis.scope) ? analysis.scope : null
  if (!scope || !Array.isArray(scope.renderBbox)) return undefined
  if (scope.renderBbox.length !== 4 || !scope.renderBbox.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error('短时临近预报范围必须是四个有限数值组成的 bbox')
  }
  return scope.renderBbox
}

export function refObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('valueRef 的值必须是对象')
  return value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

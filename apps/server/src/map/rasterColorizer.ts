// +-------------------------------------------------------------------------
//
//   地理智能平台 - 栅格像素着色器
//
//   文件:       rasterColorizer.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { MapLayerSource, MapLayerStyle } from '../schemas/types.js'
import type { TypedArray } from 'geotiff'

type Rgba = readonly [number, number, number, number]

interface RasterColorInput {
  values: TypedArray
  width: number
  height: number
  source: Extract<MapLayerSource, { kind: 'raster_tiles' | 'raster_dem' }>
  style: MapLayerStyle
  noData: number | null
}

export function colorizeRaster(input: RasterColorInput): Uint8Array {
  const output = new Uint8Array(input.width * input.height * 4)
  if (input.source.kind === 'raster_dem') {
    colorizeElevation(input, input.source, output)
    return output
  }
  if (input.style.kind === 'continuous_raster') {
    colorizeContinuous(input, input.style, output)
    return output
  }
  if (input.style.kind === 'categorical_raster') {
    colorizeCategorical(input, input.style, output)
    return output
  }
  throw new Error(`普通栅格瓦片不支持样式 '${input.style.kind}'。`)
}

function colorizeContinuous(
  input: RasterColorInput,
  style: Extract<MapLayerStyle, { kind: 'continuous_raster' }>,
  output: Uint8Array,
): void {
  const stops = style.colorStops
    .map(stop => ({ value: stop.value, color: parseColor(stop.color) }))
    .sort((left, right) => left.value - right.value)
  const first = stops[0]
  const last = stops.at(-1)
  if (!first || !last || first.value === last.value) {
    throw new Error('连续栅格色带至少需要两个不同数值的色标。')
  }
  forEachValue(input.values, (value, index) => {
    if (isNoData(value, input.noData)) return
    const upperIndex = stops.findIndex(stop => stop.value >= value)
    const upper = upperIndex < 0 ? last : (stops[upperIndex] ?? last)
    const lower = upperIndex <= 0 ? first : (stops[upperIndex - 1] ?? first)
    const ratio = upper.value === lower.value
      ? 0
      : clamp((value - lower.value) / (upper.value - lower.value), 0, 1)
    writeColor(output, index, interpolate(lower.color, upper.color, ratio), style.opacity)
  })
}

function colorizeCategorical(
  input: RasterColorInput,
  style: Extract<MapLayerStyle, { kind: 'categorical_raster' }>,
  output: Uint8Array,
): void {
  const colors = new Map<number, Rgba>()
  for (const category of style.categories) {
    const numeric = typeof category.value === 'number' ? category.value : Number(category.value)
    if (Number.isFinite(numeric)) colors.set(numeric, parseColor(category.color))
  }
  if (!colors.size) throw new Error('分类栅格图层没有数值型类别。')
  forEachValue(input.values, (value, index) => {
    if (isNoData(value, input.noData)) return
    const color = colors.get(value)
    if (color) writeColor(output, index, color, style.opacity)
  })
}

function colorizeElevation(
  input: RasterColorInput,
  source: Extract<MapLayerSource, { kind: 'raster_dem' }>,
  output: Uint8Array,
): void {
  forEachValue(input.values, (value, index) => {
    if (isNoData(value, input.noData)) return
    const offset = index * 4
    if (source.encoding === 'terrarium') {
      const encoded = clamp(value + 32_768, 0, 65_535.99609375)
      output[offset] = Math.floor(encoded / 256)
      output[offset + 1] = Math.floor(encoded % 256)
      output[offset + 2] = Math.floor((encoded - Math.floor(encoded)) * 256)
    } else {
      const encoded = Math.round(clamp((value + 10_000) * 10, 0, 16_777_215))
      output[offset] = (encoded >> 16) & 255
      output[offset + 1] = (encoded >> 8) & 255
      output[offset + 2] = encoded & 255
    }
    output[offset + 3] = 255
  })
}

function forEachValue(values: TypedArray, callback: (value: number, index: number) => void): void {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === undefined) throw new Error('GeoTIFF 返回的像素数组不完整。')
    callback(value, index)
  }
}

function isNoData(value: number, noData: number | null): boolean {
  return !Number.isFinite(value) || (noData !== null && (value === noData || (Number.isNaN(noData) && Number.isNaN(value))))
}

function writeColor(output: Uint8Array, index: number, color: Rgba, opacity: number): void {
  const offset = index * 4
  output[offset] = color[0]
  output[offset + 1] = color[1]
  output[offset + 2] = color[2]
  output[offset + 3] = Math.round(color[3] * opacity)
}

function interpolate(lower: Rgba, upper: Rgba, ratio: number): Rgba {
  return [
    Math.round(lower[0] + (upper[0] - lower[0]) * ratio),
    Math.round(lower[1] + (upper[1] - lower[1]) * ratio),
    Math.round(lower[2] + (upper[2] - lower[2]) * ratio),
    Math.round(lower[3] + (upper[3] - lower[3]) * ratio),
  ]
}

function parseColor(value: string): Rgba {
  const match = /^#([\da-f]{6}|[\da-f]{8})$/iu.exec(value)
  if (!match?.[1]) throw new Error(`不支持的色标颜色 '${value}'。`)
  const hex = match[1]
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
    hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255,
  ]
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

import {
  mapScreenshotContextSchema,
  type MapScreenshotContext,
} from '@geo-agent-platform/shared-types'

import { DESKTOP_STAGED_IMAGE_MAX_BYTES } from '../../../contracts/desktopIpc'
import type { SceneRenderLayer } from './useMapScene'
import { sceneSourceId } from './MapCanvasLayerSync'

const MAP_SCREENSHOT_MAX_PIXELS = 4_000_000

export interface MapScreenshotViewport {
  bounds: [number, number, number, number]
  center: [number, number]
  zoom: number
  bearing: number
  pitch: number
}

export interface MapScreenshotRenderEvidence {
  status: 'idle'
  tilesLoaded: true
  renderedLayerIds: readonly string[]
}

interface MapStyleLayerEvidence {
  type?: string
  source?: unknown
  layout?: Record<string, unknown> & { visibility?: unknown }
  paint?: Record<string, unknown>
}

export interface MapRenderEvidenceReader {
  getStyle(): { layers?: MapStyleLayerEvidence[] } | undefined
  getSource(sourceId: string): unknown
  isSourceLoaded(sourceId: string): boolean
}

type SourceReadiness = 'loading' | 'ready' | 'errored'

interface SourceGenerationState {
  generation: number
  status: SourceReadiness
}

/**
 * MapLibre 的 loaded/idle 包含已失败瓦片，不能单独用来证明截图图层成功。
 * 此跟踪器为每次 source 替换分配单调 generation，只允许同代事件改变当前状态。
 */
export class MapSourceReadinessTracker {
  private readonly generationCounters = new Map<string, number>()
  private readonly activeSources = new Map<string, SourceGenerationState>()

  beginSourceGeneration(sourceId: string): number {
    const generation = (this.generationCounters.get(sourceId) ?? 0) + 1
    this.generationCounters.set(sourceId, generation)
    this.activeSources.set(sourceId, { generation, status: 'loading' })
    return generation
  }

  removeSource(sourceId: string): void {
    this.activeSources.delete(sourceId)
  }

  clear(): void {
    this.activeSources.clear()
    this.generationCounters.clear()
  }

  currentGeneration(sourceId: string): number | null {
    return this.activeSources.get(sourceId)?.generation ?? null
  }

  markLoading(sourceId: string, generation: number): void {
    this.updateMatchingGeneration(sourceId, generation, current => (
      current.status === 'errored' ? current : { ...current, status: 'loading' }
    ))
  }

  markReady(sourceId: string, generation: number): void {
    this.updateMatchingGeneration(sourceId, generation, current => (
      current.status === 'errored' ? current : { ...current, status: 'ready' }
    ))
  }

  markErrored(sourceId: string, generation: number): void {
    this.updateMatchingGeneration(sourceId, generation, current => ({ ...current, status: 'errored' }))
  }

  isReady(sourceId: string, generation: number): boolean {
    const current = this.activeSources.get(sourceId)
    return current?.generation === generation && current.status === 'ready'
  }

  entries(): Array<{ sourceId: string; generation: number; status: SourceReadiness }> {
    return [...this.activeSources].map(([sourceId, state]) => ({ sourceId, ...state }))
  }

  private updateMatchingGeneration(
    sourceId: string,
    generation: number,
    update: (current: SourceGenerationState) => SourceGenerationState,
  ): void {
    const current = this.activeSources.get(sourceId)
    if (!current || current.generation !== generation) return
    this.activeSources.set(sourceId, update(current))
  }
}

/** 只在 MapLibre 全局 idle 时，确认本代 source 已成功完成。 */
export function confirmReadySourcesAtIdle(
  map: Pick<MapRenderEvidenceReader, 'getSource' | 'isSourceLoaded'>,
  readiness: MapSourceReadinessTracker,
): void {
  for (const { sourceId, generation, status } of readiness.entries()) {
    if (status === 'errored') continue
    if (map.getSource(sourceId) && map.isSourceLoaded(sourceId)) {
      readiness.markReady(sourceId, generation)
    }
  }
}

/** 从实际 MapLibre style/source 状态生成截图图层证据。 */
export function collectRenderedSceneLayerIds(
  map: MapRenderEvidenceReader,
  layers: readonly SceneRenderLayer[],
  layerErrors: Readonly<Record<string, string>>,
  readiness: MapSourceReadinessTracker,
): string[] {
  const renderedSourceIds = new Set<string>()
  for (const styleLayer of map.getStyle()?.layers ?? []) {
    if (!styleLayerHasVisibleOpacity(styleLayer)) continue
    if (typeof styleLayer.source === 'string') renderedSourceIds.add(styleLayer.source)
  }
  return layers.flatMap(layer => {
    if (
      !layer.scene.visible
      || !isPositiveOpacity(layer.scene.opacity)
      || layerErrors[layer.manifest.mapLayerId]
    ) return []
    const sourceId = sceneSourceId(layer.manifest.mapLayerId)
    const generation = readiness.currentGeneration(sourceId)
    if (
      generation === null
      || !readiness.isReady(sourceId, generation)
      || !renderedSourceIds.has(sourceId)
      || !map.getSource(sourceId)
      || !map.isSourceLoaded(sourceId)
    ) return []
    return [layer.manifest.mapLayerId]
  })
}

const OPACITY_PROPERTIES_BY_LAYER_TYPE: Readonly<Record<string, readonly string[]>> = {
  circle: ['circle-opacity'],
  fill: ['fill-opacity'],
  'fill-extrusion': ['fill-extrusion-opacity'],
  heatmap: ['heatmap-opacity'],
  line: ['line-opacity'],
  raster: ['raster-opacity'],
}

function styleLayerHasVisibleOpacity(layer: MapStyleLayerEvidence): boolean {
  if (layer.layout?.visibility === 'none') return false
  if (layer.type === 'symbol') return symbolLayerHasVisibleOpacity(layer)
  const opacityProperties = layer.type ? OPACITY_PROPERTIES_BY_LAYER_TYPE[layer.type] : undefined
  if (!opacityProperties) return true
  return opacityProperties.every(property => !(property in (layer.paint ?? {})))
    || opacityProperties.some(property => isPositiveOpacity(layer.paint?.[property]))
}

function symbolLayerHasVisibleOpacity(layer: MapStyleLayerEvidence): boolean {
  const layout = layer.layout ?? {}
  const hasText = hasRenderableSymbolValue(layout['text-field'])
  const hasIcon = hasRenderableSymbolValue(layout['icon-image'])
  if (!hasText && !hasIcon) return false
  return (hasText && opacityPropertyIsVisible(layer.paint, 'text-opacity'))
    || (hasIcon && opacityPropertyIsVisible(layer.paint, 'icon-opacity'))
}

function hasRenderableSymbolValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false
  return true
}

function opacityPropertyIsVisible(paint: Record<string, unknown> | undefined, property: string): boolean {
  return !paint || !(property in paint) || isPositiveOpacity(paint[property])
}

function isPositiveOpacity(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export interface MapScreenshotEncoderOptions {
  maxBytes?: number
  maxPixels?: number
  createCanvas?: () => HTMLCanvasElement
  encode?: (canvas: HTMLCanvasElement) => Promise<Blob>
}

/**
 * 先按像素预算复制/缩小画布，再创建 PNG Blob；字节数仍超限时继续降采样。
 */
export async function encodeMapScreenshotPng(
  source: HTMLCanvasElement,
  options: MapScreenshotEncoderOptions = {},
): Promise<Blob> {
  const maxBytes = options.maxBytes ?? DESKTOP_STAGED_IMAGE_MAX_BYTES
  const maxPixels = options.maxPixels ?? MAP_SCREENSHOT_MAX_PIXELS
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('PNG 字节预算必须为正数。')
  const encode = options.encode ?? encodeCanvasAsPng
  const createCanvas = options.createCanvas ?? (() => document.createElement('canvas'))
  let dimensions = fitCanvasDimensions(source.width, source.height, maxPixels)
  let candidate = dimensions.width === source.width && dimensions.height === source.height
    ? source
    : copyCanvasAtSize(source, dimensions, createCanvas)
  let blob = await encode(candidate)

  for (let attempt = 0; blob.size > maxBytes && attempt < 8; attempt += 1) {
    if (dimensions.width === 1 && dimensions.height === 1) break
    const byteScale = Math.sqrt((maxBytes * 0.9) / blob.size)
    const scale = Math.min(0.9, Number.isFinite(byteScale) ? byteScale : 0.5)
    dimensions = smallerDimensions(dimensions, scale)
    candidate = copyCanvasAtSize(source, dimensions, createCanvas)
    blob = await encode(candidate)
  }

  if (blob.size > maxBytes) {
    throw new Error(`地图 PNG 缩小后仍超过 ${maxBytes} 字节上限。`)
  }
  return blob
}

export function fitCanvasDimensions(
  width: number,
  height: number,
  maxPixels = MAP_SCREENSHOT_MAX_PIXELS,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('地图画布尺寸无效。')
  }
  if (!Number.isFinite(maxPixels) || maxPixels < 1) throw new Error('地图截图像素预算无效。')
  const integerWidth = Math.max(1, Math.floor(width))
  const integerHeight = Math.max(1, Math.floor(height))
  const scale = Math.min(1, Math.sqrt(maxPixels / (integerWidth * integerHeight)))
  return {
    width: Math.max(1, Math.floor(integerWidth * scale)),
    height: Math.max(1, Math.floor(integerHeight * scale)),
  }
}

function smallerDimensions(
  dimensions: { width: number; height: number },
  scale: number,
): { width: number; height: number } {
  const width = Math.max(1, Math.floor(dimensions.width * scale))
  const height = Math.max(1, Math.floor(dimensions.height * scale))
  if (width !== dimensions.width || height !== dimensions.height) return { width, height }
  return dimensions.width >= dimensions.height
    ? { width: Math.max(1, dimensions.width - 1), height: dimensions.height }
    : { width: dimensions.width, height: Math.max(1, dimensions.height - 1) }
}

function copyCanvasAtSize(
  source: HTMLCanvasElement,
  dimensions: { width: number; height: number },
  createCanvas: () => HTMLCanvasElement,
): HTMLCanvasElement {
  const canvas = createCanvas()
  canvas.width = dimensions.width
  canvas.height = dimensions.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建地图截图缩放画布。')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, dimensions.width, dimensions.height)
  return canvas
}

function encodeCanvasAsPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(new Error('地图画布没有产生可用的 PNG。'))
    }, 'image/png')
  })
}

/** Build the exact structured context that accompanies a rendered map image. */
export function buildMapScreenshotContext(
  viewport: MapScreenshotViewport,
  layers: readonly SceneRenderLayer[],
  evidence: MapScreenshotRenderEvidence,
  capturedAt = new Date().toISOString(),
): MapScreenshotContext {
  const renderedLayerIds = new Set(evidence.renderedLayerIds)
  const renderedLayers = layers
    .filter(layer => layer.scene.visible && renderedLayerIds.has(layer.manifest.mapLayerId))
    .map(layer => {
      const temporal = layer.manifest.temporal
      const currentFrameId = temporal
        ? (layer.scene.currentFrameId ?? temporal.defaultFrameId)
        : null
      const currentFrame = temporal?.frames.find(frame => frame.frameId === currentFrameId)
      return {
        mapLayerId: layer.manifest.mapLayerId,
        title: layer.manifest.title,
        currentFrameId,
        validTime: currentFrame?.validTime ?? null,
      }
    })
  const validTimes = renderedLayers
    .flatMap(layer => layer.validTime ? [layer.validTime] : [])
    .sort((left, right) => Date.parse(left) - Date.parse(right))

  return mapScreenshotContextSchema.parse({
    capturedAt,
    viewport: {
      bounds: normalizeBounds(viewport.bounds),
      center: [normalizeLongitude(viewport.center[0]), viewport.center[1]],
      zoom: viewport.zoom,
      bearing: viewport.bearing,
      pitch: viewport.pitch,
    },
    crs: 'OGC:CRS84',
    renderProjection: 'EPSG:3857',
    renderState: {
      status: evidence.status,
      tilesLoaded: evidence.tilesLoaded,
    },
    renderedLayers,
    timeRange: validTimes.length
      ? { start: validTimes[0], end: validTimes[validTimes.length - 1] }
      : null,
  })
}

function normalizeBounds(
  [west, south, east, north]: [number, number, number, number],
): [number, number, number, number] {
  const longitudeSpan = east - west
  if (Number.isFinite(longitudeSpan) && longitudeSpan >= 360) {
    return [-180, south, 180, north]
  }
  return [normalizeLongitude(west), south, normalizeLongitude(east), north]
}

function normalizeLongitude(value: number): number {
  if (!Number.isFinite(value)) return value
  const normalized = ((value + 180) % 360 + 360) % 360 - 180
  return Object.is(normalized, -0) ? 0 : normalized
}

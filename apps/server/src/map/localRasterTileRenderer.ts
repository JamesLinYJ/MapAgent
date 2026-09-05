// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本地 GeoTIFF 栅格瓦片渲染器
//
//   文件:       localRasterTileRenderer.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'

import { fromFile, type GeoTIFF, type TypedArrayWithDimensions } from 'geotiff'
import PQueue from 'p-queue'
import proj4 from 'proj4'
import QuickLRU from 'quick-lru'
import sharp from 'sharp'

import { GEOJSON_CRS84, normalizeCrsIdentifier } from '../gis/crs.js'
import type { MapLayerSource } from '../schemas/types.js'
import type { MapTileExecutionSpec } from '../store/postgres/mapStore.js'
import type { MapTileResponse, RasterTileSource } from './mapTileSource.js'
import { colorizeRaster } from './rasterColorizer.js'
import { RuntimeRasterArtifactResolver, type ResolvedRasterArtifact } from './runtimeRasterArtifact.js'

type Bounds = readonly [number, number, number, number]

interface OpenRaster {
  tiff: GeoTIFF
  bounds: Bounds
  noData: number | null
}

interface PixelPlacement {
  bounds: Bounds
  left: number
  top: number
  width: number
  height: number
}

export class LocalRasterTileRenderer implements RasterTileSource {
  private readonly resolver: RuntimeRasterArtifactResolver
  private readonly renderQueue: PQueue
  private readonly rasterCache: QuickLRU<string, Promise<OpenRaster>>
  private readonly tileCache = new QuickLRU<string, Promise<MapTileResponse>>({ maxSize: 256 })
  private closed = false

  constructor(input: {
    runtimeRoot: string
    timeoutMs: number
    concurrency?: number
  }) {
    this.resolver = new RuntimeRasterArtifactResolver(input.runtimeRoot)
    this.timeoutMs = input.timeoutMs
    this.renderQueue = new PQueue({ concurrency: input.concurrency ?? 4 })
    this.rasterCache = new QuickLRU({
      maxSize: 16,
      onEviction: (_key, raster) => {
        void raster.then(closeRaster).catch(() => undefined)
      },
    })
  }

  private readonly timeoutMs: number

  async renderTile(
    spec: MapTileExecutionSpec,
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<MapTileResponse> {
    if (this.closed) throw new Error('栅格瓦片渲染器已经关闭。')
    signal?.throwIfAborted()
    if (!spec.artifactRelativePath) throw new Error('栅格瓦片图层缺少已注册 GeoTIFF Artifact。')
    const artifact = await this.resolver.resolve(spec.artifactRelativePath)
    const key = tileCacheKey(spec, artifact, z, x, y)
    let pending = this.tileCache.get(key)
    if (!pending) {
      pending = this.renderQueue.add(() => this.renderFresh(spec, artifact, z, x, y))
      this.tileCache.set(key, pending)
      void pending.catch(() => this.tileCache.delete(key))
    }
    return waitForCaller(pending, signal)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.renderQueue.onIdle()
    const rasters = [...this.rasterCache.values()]
    this.rasterCache.clear()
    this.tileCache.clear()
    await Promise.allSettled(rasters.map(async raster => closeRaster(await raster)))
  }

  private async renderFresh(
    spec: MapTileExecutionSpec,
    artifact: ResolvedRasterArtifact,
    z: number,
    x: number,
    y: number,
  ): Promise<MapTileResponse> {
    const signal = AbortSignal.timeout(this.timeoutMs)
    const source = rasterSource(spec)
    const tileSize = source.tileSize
    const raster = await this.openRaster(artifact, signal)
    const tileBounds = projectTileBounds(z, x, y, spec.manifest.crs)
    const placement = intersectBounds(tileBounds, raster.bounds, tileSize)
    const pixels = new Uint8Array(tileSize * tileSize * 4)

    if (placement) {
      const values = await raster.tiff.readRasters({
        bbox: [...placement.bounds],
        width: placement.width,
        height: placement.height,
        samples: [0],
        interleave: true,
        resampleMethod: source.kind === 'raster_dem' || spec.manifest.style.kind === 'continuous_raster'
          ? 'bilinear'
          : 'nearest',
        fillValue: raster.noData ?? Number.NaN,
        signal,
      })
      if (!isTypedRaster(values)) throw new Error('GeoTIFF 未返回单波段交错像素数组。')
      if (values.width !== placement.width || values.height !== placement.height) {
        throw new Error('GeoTIFF 返回的栅格窗口尺寸不符合请求。')
      }
      const colored = colorizeRaster({
        values,
        width: values.width,
        height: values.height,
        source,
        style: spec.manifest.style,
        noData: raster.noData,
      })
      placePixels(pixels, tileSize, colored, placement)
    }

    signal.throwIfAborted()
    const encoded = await sharp(pixels, {
      raw: { width: tileSize, height: tileSize, channels: 4 },
      limitInputPixels: tileSize * tileSize,
    }).png({
      compressionLevel: 6,
      adaptiveFiltering: true,
    }).toBuffer()
    signal.throwIfAborted()
    const body = Uint8Array.from(encoded).buffer
    return {
      body,
      contentType: 'image/png',
      cacheControl: 'private, max-age=60',
      etag: `"${createHash('sha256').update(encoded).digest('base64url')}"`,
    }
  }

  private async openRaster(artifact: ResolvedRasterArtifact, signal: AbortSignal): Promise<OpenRaster> {
    let pending = this.rasterCache.get(artifact.fingerprint)
    if (!pending) {
      pending = (async () => {
        const tiff = await fromFile(artifact.path, signal)
        try {
          const image = await tiff.getImage()
          validateRasterLayout({
            width: image.getWidth(),
            height: image.getHeight(),
            samples: image.getSamplesPerPixel(),
            blockWidth: image.getBlockWidth(),
            blockHeight: image.getBlockHeight(0),
          })
          const bounds = validateBounds(image.getBoundingBox(), 'GeoTIFF')
          return { tiff, bounds, noData: image.getGDALNoData() }
        } catch (error) {
          await closeRaster({ tiff, bounds: [0, 0, 1, 1], noData: null })
          throw error
        }
      })()
      this.rasterCache.set(artifact.fingerprint, pending)
      void pending.catch(() => this.rasterCache.delete(artifact.fingerprint))
    }
    return pending
  }
}

function validateRasterLayout(input: {
  width: number
  height: number
  samples: number
  blockWidth: number
  blockHeight: number
}): void {
  if (
    !Number.isInteger(input.width)
    || !Number.isInteger(input.height)
    || input.width < 1
    || input.height < 1
    || input.width > 1_000_000
    || input.height > 1_000_000
    || !Number.isInteger(input.samples)
    || input.samples < 1
    || input.samples > 64
  ) {
    throw new Error('GeoTIFF 尺寸或波段数量超出安全范围。')
  }
  if (
    !Number.isInteger(input.blockWidth)
    || !Number.isInteger(input.blockHeight)
    || input.blockWidth < 1
    || input.blockHeight < 1
    || input.blockWidth * input.blockHeight > 16_777_216
  ) {
    throw new Error('GeoTIFF 单个压缩块过大，拒绝在瓦片请求中解码。')
  }
}

function rasterSource(spec: MapTileExecutionSpec): Extract<MapLayerSource, { kind: 'raster_tiles' | 'raster_dem' }> {
  const source = spec.manifest.source
  if (source.kind !== 'raster_tiles' && source.kind !== 'raster_dem') {
    throw new Error(`图层 '${spec.manifest.mapLayerId}' 不是栅格瓦片数据源。`)
  }
  return source
}

function projectTileBounds(z: number, x: number, y: number, targetCrs: string): Bounds {
  const wgs84 = xyzBounds(z, x, y)
  const projection = projectionFor(targetCrs)
  if (projection === 'EPSG:4326') return wgs84
  const corners: Array<readonly [number, number]> = [
    [wgs84[0], wgs84[1]],
    [wgs84[0], wgs84[3]],
    [wgs84[2], wgs84[1]],
    [wgs84[2], wgs84[3]],
  ]
  const projected = corners.map(coordinate => {
    const result = proj4('EPSG:4326', projection, [...coordinate])
    const projectedX = result[0]
    const projectedY = result[1]
    if (
      projectedX === undefined
      || projectedY === undefined
      || !Number.isFinite(projectedX)
      || !Number.isFinite(projectedY)
    ) {
      throw new Error(`坐标系 '${targetCrs}' 的瓦片投影结果无效。`)
    }
    return [projectedX, projectedY] as const
  })
  return validateBounds([
    Math.min(...projected.map(coordinate => coordinate[0])),
    Math.min(...projected.map(coordinate => coordinate[1])),
    Math.max(...projected.map(coordinate => coordinate[0])),
    Math.max(...projected.map(coordinate => coordinate[1])),
  ], '瓦片投影')
}

function projectionFor(value: string): string {
  const normalized = normalizeCrsIdentifier(value, '本地栅格 CRS')
  if (normalized === GEOJSON_CRS84) return 'EPSG:4326'
  if (normalized === 'EPSG:3857') return normalized
  const utm = /^EPSG:(326|327)(\d{2})$/u.exec(normalized)
  if (utm?.[1] && utm[2]) {
    const zone = Number(utm[2])
    if (zone >= 1 && zone <= 60) {
      return `+proj=utm +zone=${zone}${utm[1] === '327' ? ' +south' : ''} +datum=WGS84 +units=m +no_defs +type=crs`
    }
  }
  throw new Error(`本地栅格瓦片暂不支持坐标系 '${value}'。`)
}

function xyzBounds(z: number, x: number, y: number): Bounds {
  const count = 2 ** z
  const longitude = (column: number): number => column / count * 360 - 180
  const latitude = (row: number): number => {
    const mercator = Math.PI * (1 - 2 * row / count)
    return Math.atan(Math.sinh(mercator)) * 180 / Math.PI
  }
  return [longitude(x), latitude(y + 1), longitude(x + 1), latitude(y)]
}

function intersectBounds(tile: Bounds, raster: Bounds, tileSize: number): PixelPlacement | null {
  const bounds: Bounds = [
    Math.max(tile[0], raster[0]),
    Math.max(tile[1], raster[1]),
    Math.min(tile[2], raster[2]),
    Math.min(tile[3], raster[3]),
  ]
  if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) return null
  const horizontalSpan = tile[2] - tile[0]
  const verticalSpan = tile[3] - tile[1]
  const left = clampInteger(Math.round((bounds[0] - tile[0]) / horizontalSpan * tileSize), 0, tileSize - 1)
  const right = clampInteger(Math.round((bounds[2] - tile[0]) / horizontalSpan * tileSize), left + 1, tileSize)
  const top = clampInteger(Math.round((tile[3] - bounds[3]) / verticalSpan * tileSize), 0, tileSize - 1)
  const bottom = clampInteger(Math.round((tile[3] - bounds[1]) / verticalSpan * tileSize), top + 1, tileSize)
  return { bounds, left, top, width: right - left, height: bottom - top }
}

function placePixels(target: Uint8Array, tileSize: number, source: Uint8Array, placement: PixelPlacement): void {
  const sourceRowBytes = placement.width * 4
  for (let row = 0; row < placement.height; row += 1) {
    const sourceStart = row * sourceRowBytes
    const targetStart = ((placement.top + row) * tileSize + placement.left) * 4
    target.set(source.subarray(sourceStart, sourceStart + sourceRowBytes), targetStart)
  }
}

function validateBounds(values: readonly number[], label: string): Bounds {
  if (
    values.length !== 4
    || !values.every(Number.isFinite)
    || values[0] === undefined
    || values[1] === undefined
    || values[2] === undefined
    || values[3] === undefined
    || values[0] >= values[2]
    || values[1] >= values[3]
  ) {
    throw new Error(`${label}范围无效。`)
  }
  return [values[0], values[1], values[2], values[3]]
}

function isTypedRaster(value: unknown): value is TypedArrayWithDimensions {
  return ArrayBuffer.isView(value)
    && !(value instanceof DataView)
    && 'width' in value
    && 'height' in value
    && typeof value.width === 'number'
    && typeof value.height === 'number'
}

function tileCacheKey(
  spec: MapTileExecutionSpec,
  artifact: ResolvedRasterArtifact,
  z: number,
  x: number,
  y: number,
): string {
  return createHash('sha256').update(JSON.stringify({
    artifact: artifact.fingerprint,
    mapLayerId: spec.manifest.mapLayerId,
    dataVersion: spec.manifest.dataVersion,
    crs: spec.manifest.crs,
    source: spec.manifest.source,
    style: spec.manifest.style,
    z,
    x,
    y,
  })).digest('base64url')
}

async function closeRaster(raster: OpenRaster): Promise<void> {
  const closed = raster.tiff.close()
  if (closed) await closed
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function waitForCaller<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

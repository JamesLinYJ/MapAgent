import { describe, expect, it, vi } from 'vitest'

import { DESKTOP_STAGED_IMAGE_MAX_BYTES } from '../../../contracts/desktopIpc'
import type { SceneRenderLayer } from './useMapScene'
import {
  buildMapScreenshotContext,
  collectRenderedSceneLayerIds,
  confirmReadySourcesAtIdle,
  encodeMapScreenshotPng,
  fitCanvasDimensions,
  MapSourceReadinessTracker,
} from './mapScreenshot'

describe('map screenshot context', () => {
  it('records viewport, CRS, visible layers and temporal range without image-derived text', () => {
    const layers = [{
      manifest: {
        mapLayerId: 'radar_1',
        title: '雷达回波',
        temporal: {
          defaultFrameId: 'frame_1',
          frames: [
            { frameId: 'frame_1', validTime: '2026-08-08T03:00:00.000Z', label: '03:00' },
            { frameId: 'frame_2', validTime: '2026-08-08T04:00:00.000Z', label: '04:00' },
          ],
        },
      },
      scene: { visible: true, currentFrameId: 'frame_2' },
    }, {
      manifest: { mapLayerId: 'hidden_1', title: '隐藏图层', temporal: null },
      scene: { visible: false, currentFrameId: null },
    }] as unknown as SceneRenderLayer[]

    const result = buildMapScreenshotContext({
      bounds: [119, 29, 121, 31],
      center: [120, 30],
      zoom: 8,
      bearing: 12,
      pitch: 30,
    }, layers, {
      status: 'idle',
      tilesLoaded: true,
      renderedLayerIds: ['radar_1'],
    }, '2026-08-08T04:10:00.000Z')

    expect(result).toMatchObject({
      capturedAt: '2026-08-08T04:10:00.000Z',
      crs: 'OGC:CRS84',
      renderProjection: 'EPSG:3857',
      renderState: { status: 'idle', tilesLoaded: true },
      viewport: { bounds: [119, 29, 121, 31], center: [120, 30], zoom: 8 },
      renderedLayers: [{
        mapLayerId: 'radar_1',
        currentFrameId: 'frame_2',
        validTime: '2026-08-08T04:00:00.000Z',
      }],
      timeRange: {
        start: '2026-08-08T04:00:00.000Z',
        end: '2026-08-08T04:00:00.000Z',
      },
    })
    expect(JSON.stringify(result)).not.toContain('data:image')
  })

  it('keeps an antimeridian viewport wrapped instead of expanding it to the whole world', () => {
    const result = buildMapScreenshotContext({
      bounds: [170, -10, 190, 10],
      center: [180, 0],
      zoom: 4,
      bearing: 0,
      pitch: 0,
    }, [], {
      status: 'idle',
      tilesLoaded: true,
      renderedLayerIds: [],
    }, '2026-08-08T04:10:00.000Z')

    expect(result.viewport.bounds).toEqual([170, -10, -170, 10])
    expect(result.viewport.center).toEqual([-180, 0])
  })

  it('only records layers proven to be rendered', () => {
    const layers = [{
      manifest: { mapLayerId: 'ready_1', title: '已渲染', temporal: null },
      scene: { visible: true, currentFrameId: null },
    }, {
      manifest: { mapLayerId: 'loading_1', title: '尚未渲染', temporal: null },
      scene: { visible: true, currentFrameId: null },
    }] as unknown as SceneRenderLayer[]

    const result = buildMapScreenshotContext({
      bounds: [119, 29, 121, 31],
      center: [120, 30],
      zoom: 8,
      bearing: 0,
      pitch: 0,
    }, layers, {
      status: 'idle',
      tilesLoaded: true,
      renderedLayerIds: ['ready_1'],
    }, '2026-08-08T04:10:00.000Z')

    expect(result.renderedLayers.map(layer => layer.mapLayerId)).toEqual(['ready_1'])
  })

  it('derives rendered layer ids from visible, loaded MapLibre sources without layer errors', () => {
    const layers = ['ready_1', 'loading_1', 'hidden_1', 'error_1'].map(mapLayerId => ({
      manifest: { mapLayerId },
      scene: { visible: mapLayerId !== 'hidden_1', opacity: 1 },
    })) as unknown as SceneRenderLayer[]
    const map = {
      getStyle: () => ({
        layers: [
          { source: 'map-layer-ready_1' },
          { source: 'map-layer-loading_1' },
          { source: 'map-layer-error_1' },
          { source: 'map-layer-hidden_1', layout: { visibility: 'none' } },
        ],
      }),
      getSource: () => ({}),
      isSourceLoaded: (sourceId: string) => sourceId !== 'map-layer-loading_1',
    }
    const readiness = new MapSourceReadinessTracker()
    for (const layer of layers) readiness.beginSourceGeneration(`map-layer-${layer.manifest.mapLayerId}`)
    confirmReadySourcesAtIdle(map, readiness)

    expect(collectRenderedSceneLayerIds(map, layers, { error_1: '图层失败' }, readiness))
      .toEqual(['ready_1'])
  })

  it('only accepts readiness evidence from the current source generation', () => {
    const sourceId = 'map-layer-radar_1'
    const layers = [{
      manifest: { mapLayerId: 'radar_1' },
      scene: { visible: true, opacity: 1 },
    }] as unknown as SceneRenderLayer[]
    const map = {
      getStyle: () => ({
        layers: [{ source: sourceId, type: 'raster', paint: { 'raster-opacity': 0.8 } }],
      }),
      getSource: () => ({}),
      isSourceLoaded: () => true,
    }
    const readiness = new MapSourceReadinessTracker()
    const generation1 = readiness.beginSourceGeneration(sourceId)
    readiness.markReady(sourceId, generation1)
    expect(collectRenderedSceneLayerIds(map, layers, {}, readiness)).toEqual(['radar_1'])

    const generation2 = readiness.beginSourceGeneration(sourceId)
    readiness.markReady(sourceId, generation1)
    expect(collectRenderedSceneLayerIds(map, layers, {}, readiness)).toEqual([])
    readiness.markReady(sourceId, generation2)
    expect(collectRenderedSceneLayerIds(map, layers, {}, readiness)).toEqual(['radar_1'])

    readiness.markErrored(sourceId, generation2)
    readiness.markReady(sourceId, generation2)
    expect(collectRenderedSceneLayerIds(map, layers, {}, readiness)).toEqual([])

    readiness.removeSource(sourceId)
    const generation3 = readiness.beginSourceGeneration(sourceId)
    expect(generation3).toBeGreaterThan(generation2)
    readiness.markReady(sourceId, generation2)
    expect(collectRenderedSceneLayerIds(map, layers, {}, readiness)).toEqual([])
    readiness.markReady(sourceId, generation3)
    expect(collectRenderedSceneLayerIds(map, layers, {}, readiness)).toEqual(['radar_1'])
  })

  it('excludes scene-hidden, transparent, style-hidden, transparent-style and failed sources', () => {
    const cases = [
      { id: 'rendered', visible: true, opacity: 0.7, styleOpacity: 0.5 },
      { id: 'scene_hidden', visible: false, opacity: 1, styleOpacity: 1 },
      { id: 'scene_transparent', visible: true, opacity: 0, styleOpacity: 1 },
      { id: 'style_hidden', visible: true, opacity: 1, styleOpacity: 1, styleHidden: true },
      { id: 'style_transparent', visible: true, opacity: 1, styleOpacity: 0 },
      { id: 'expression_opacity', visible: true, opacity: 1, styleOpacity: ['get', 'opacity'] },
      { id: 'loading', visible: true, opacity: 1, styleOpacity: 1, loading: true },
      { id: 'source_error', visible: true, opacity: 1, styleOpacity: 1, errored: true },
    ] as const
    const layers = cases.map(item => ({
      manifest: { mapLayerId: item.id },
      scene: { visible: item.visible, opacity: item.opacity },
    })) as unknown as SceneRenderLayer[]
    const map = {
      getStyle: () => ({
        layers: cases.map(item => ({
          source: `map-layer-${item.id}`,
          type: 'raster',
          layout: { visibility: 'styleHidden' in item && item.styleHidden ? 'none' : 'visible' },
          paint: { 'raster-opacity': item.styleOpacity },
        })),
      }),
      getSource: () => ({}),
      isSourceLoaded: () => true,
    }
    const readiness = new MapSourceReadinessTracker()
    for (const item of cases) {
      const sourceId = `map-layer-${item.id}`
      const generation = readiness.beginSourceGeneration(sourceId)
      if ('errored' in item && item.errored) readiness.markErrored(sourceId, generation)
      else if (!('loading' in item && item.loading)) readiness.markReady(sourceId, generation)
    }

    expect(collectRenderedSceneLayerIds(map, layers, {}, readiness)).toEqual(['rendered'])
  })
})

describe('map screenshot PNG encoding', () => {
  it('downsamples a high-DPI canvas before the first encode and stays below 20 MiB', async () => {
    const source = { width: 3840, height: 2160 } as HTMLCanvasElement
    const encodedDimensions: Array<[number, number]> = []
    const drawImage = vi.fn()
    const blob = await encodeMapScreenshotPng(source, {
      createCanvas: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage,
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
        }),
      }) as unknown as HTMLCanvasElement,
      encode: async canvas => {
        encodedDimensions.push([canvas.width, canvas.height])
        return { size: canvas.width * canvas.height * 4, type: 'image/png' } as Blob
      },
    })

    expect(encodedDimensions).toEqual([[2666, 1500]])
    expect(drawImage).toHaveBeenCalledOnce()
    expect(blob.size).toBe(15_996_000)
    expect(blob.size).toBeLessThanOrEqual(DESKTOP_STAGED_IMAGE_MAX_BYTES)
  })

  it('re-encodes at a smaller size when compressed bytes still exceed the budget', async () => {
    const source = { width: 100, height: 100 } as HTMLCanvasElement
    const encodedDimensions: Array<[number, number]> = []
    const sizes = [DESKTOP_STAGED_IMAGE_MAX_BYTES + 1, DESKTOP_STAGED_IMAGE_MAX_BYTES - 1]
    const blob = await encodeMapScreenshotPng(source, {
      createCanvas: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: vi.fn(),
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
        }),
      }) as unknown as HTMLCanvasElement,
      encode: async canvas => {
        encodedDimensions.push([canvas.width, canvas.height])
        return { size: sizes.shift() ?? 0, type: 'image/png' } as Blob
      },
    })

    expect(encodedDimensions).toEqual([[100, 100], [90, 90]])
    expect(blob.size).toBe(DESKTOP_STAGED_IMAGE_MAX_BYTES - 1)
  })

  it.each([
    { width: 3840, height: 2160, maxPixels: 4_000_000, expected: { width: 2666, height: 1500 } },
    { width: 800, height: 600, maxPixels: 4_000_000, expected: { width: 800, height: 600 } },
    { width: 10, height: 10, maxPixels: 1, expected: { width: 1, height: 1 } },
  ])('fits $width x $height into a deterministic pixel budget', ({ width, height, maxPixels, expected }) => {
    expect(fitCanvasDimensions(width, height, maxPixels)).toEqual(expected)
  })
})

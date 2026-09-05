// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图画布渲染引擎
//
//   文件:       MapCanvasEngine.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 封装 MapLibre source/layer 同步、bounds 解析和图层语义判定。
// MapCanvas 负责生命周期和状态所有权，本文件只处理地图渲染规则。

import type {
Map,
PointLike,
StyleSpecification,
} from 'maplibre-gl/dist/maplibre-gl-csp'

import type { BasemapDescriptor } from '@geo-agent-platform/shared-types'
import type { SceneRenderLayer } from './useMapScene'
export type MapBounds = [west: number, south: number, east: number, north: number]

export function isStaleMapLayerError(message: string, layers: SceneRenderLayer[]) {
  const layerIds = message.match(/map_layer_[A-Za-z0-9_]+/gu) ?? []
  if (!layerIds.length) return false
  const activeIds = new Set(layers.map(layer => layer.manifest.mapLayerId))
  return layerIds.every(layerId => !activeIds.has(layerId))
}

export function formatMapResourceWarning(message: string) {
  return /(AJAXError|Failed to fetch|ERR_CONNECTION|NetworkError)/iu.test(message)
    ? '地图资源暂时未加载，请稍候重试。'
    : message
}

export function buildBasemapStyle(basemap?: BasemapDescriptor): StyleSpecification {
  const sources: StyleSpecification['sources'] = {}
  const layers: StyleSpecification['layers'] = []

  if (basemap) {
    sources.basemap = {
      type: 'raster',
      tiles: basemap.tileUrls,
      tileSize: 256,
      attribution: basemap.attribution,
    }
    layers.push({
      id: 'basemap',
      type: 'raster',
      source: 'basemap',
      paint: { 'raster-opacity': 1 },
    })

    if (basemap.labelTileUrls.length) {
      sources.labels = {
        type: 'raster',
        tiles: basemap.labelTileUrls,
        tileSize: 256,
        attribution: basemap.attribution,
      }
      layers.push({
        id: 'labels',
        type: 'raster',
        source: 'labels',
        paint: { 'raster-opacity': 1 },
      })
    }
  }

  return {
    version: 8,
    sources,
    layers,
  }
}

function extendBounds(bounds: MapBounds, collection: GeoJSON.FeatureCollection) {
  collection.features.forEach((feature) => {
    const geometry = feature.geometry
    if (!geometry) {
      return
    }
    appendGeometry(bounds, geometry)
  })
}

export function boundsFromCollection(collection?: GeoJSON.FeatureCollection) {
  if (!collection?.features.length) {
    return null
  }
  const bounds = emptyMapBounds()
  extendBounds(bounds, collection)
  return hasMapBounds(bounds) ? bounds : null
}

export function boundsFromLayer(layer?: SceneRenderLayer) {
  if (!layer) {
    return null
  }
  const [west, south, east, north] = layer.manifest.bounds
  return [west, south, east, north] satisfies MapBounds
}

function appendGeometry(bounds: MapBounds, geometry: GeoJSON.Geometry) {
  if (geometry.type === 'GeometryCollection') {
    geometry.geometries.forEach((child) => appendGeometry(bounds, child))
    return
  }
  appendCoordinates(bounds, geometry.coordinates)
}

function appendCoordinates(bounds: MapBounds, coordinates: unknown) {
  if (!Array.isArray(coordinates)) {
    return
  }
  if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
    bounds[0] = Math.min(bounds[0], coordinates[0])
    bounds[1] = Math.min(bounds[1], coordinates[1])
    bounds[2] = Math.max(bounds[2], coordinates[0])
    bounds[3] = Math.max(bounds[3], coordinates[1])
    return
  }
  coordinates.forEach((child) => appendCoordinates(bounds, child))
}

export function queryRenderedArtifactFeatures(map: Map, point: PointLike) {
  // MapLibre 在样式初始化、切换和销毁边界会短暂返回空 style；鼠标移动属于高频 UI 事件，
  // 这里把未就绪状态视为“当前没有可悬停的结果图层”，避免非业务错误冒泡到页面级边界。
  const layerIds = (map.getStyle()?.layers ?? [])
    .filter((layer) => layer.id.startsWith('map-layer-'))
    .map((layer) => layer.id)
  if (!layerIds.length) {
    return []
  }
  try {
    return map.queryRenderedFeatures(point, { layers: layerIds })
  } catch {
    return []
  }
}

function emptyMapBounds(): MapBounds {
  return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
}

function hasMapBounds(bounds: MapBounds): boolean {
  return bounds.every(Number.isFinite)
}

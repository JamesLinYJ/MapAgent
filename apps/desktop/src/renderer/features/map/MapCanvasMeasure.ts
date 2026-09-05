// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图测距图层
//
//   文件:       MapCanvasMeasure.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 封装地图测距 overlay 的 source/layer 创建和距离计算。
// 测距点状态由 MapCanvas 持有，本文件只把点集转成 MapLibre 可渲染数据。

import type { Map } from 'maplibre-gl/dist/maplibre-gl-csp'

export function ensureMeasureLayers(map: Map) {
  if (!map.getSource('measure-points')) {
    map.addSource('measure-points', {
      type: 'geojson',
      data: buildMeasurePointsCollection([]),
    })
  }
  if (!map.getSource('measure-line')) {
    map.addSource('measure-line', {
      type: 'geojson',
      data: buildMeasureLineCollection([]),
    })
  }
  if (!map.getLayer('measure-line-layer')) {
    map.addLayer({
      id: 'measure-line-layer',
      type: 'line',
      source: 'measure-line',
      paint: {
        'line-color': '#172554',
        'line-width': 3,
        'line-dasharray': [1, 1.5],
      },
    })
  }
  if (!map.getLayer('measure-point-layer')) {
    map.addLayer({
      id: 'measure-point-layer',
      type: 'circle',
      source: 'measure-points',
      paint: {
        'circle-radius': 5,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#172554',
        'circle-stroke-width': 2,
      },
    })
  }
}

export function buildMeasurePointsCollection(points: Array<[number, number]>): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points.map((point, index) => ({
      type: 'Feature',
      properties: { index: index + 1 },
      geometry: { type: 'Point', coordinates: point },
    })),
  }
}

export function buildMeasureLineCollection(points: Array<[number, number]>): GeoJSON.FeatureCollection {
  if (points.length < 2) {
    return { type: 'FeatureCollection', features: [] }
  }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: points },
      },
    ],
  }
}

export function formatMeasurementDistance(points: Array<[number, number]>) {
  if (!points.length) {
    return '未开始测距'
  }
  if (points.length === 1) {
    return '已落下第 1 个点'
  }
  const distance = totalDistanceMeters(points)
  return distance >= 1000 ? `当前量距 ${(distance / 1000).toFixed(2)} km` : `当前量距 ${Math.round(distance)} m`
}

function totalDistanceMeters(points: Array<[number, number]>) {
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]
    const end = points[index]
    if (!start || !end) continue
    total += haversineMeters(start, end)
  }
  return total
}

function haversineMeters(start: [number, number], end: [number, number]) {
  const toRad = (value: number) => (value * Math.PI) / 180
  const earthRadius = 6371000
  const dLat = toRad(end[1] - start[1])
  const dLng = toRad(end[0] - start[0])
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(start[1])) * Math.cos(toRad(end[1])) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

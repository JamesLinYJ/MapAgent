// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图弹窗内容构造
//
//   文件:       MapCanvasPopups.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 只负责把 MapLibre 查询到的 GeoJSON feature 转成受转义保护的弹窗 HTML。
// 这里不读取地图实例，也不修改任何图层状态。

import type maplibregl from 'maplibre-gl/dist/maplibre-gl-csp'
import { formatDurationLabel, formatRouteDistance } from './MapCanvasFormatters'

export function buildHoverPopupHtml(feature: maplibregl.MapGeoJSONFeature) {
  const props = (feature.properties as Record<string, unknown>) ?? {}
  if (props.distance_km != null && props.duration_min != null) {
    const name = props.name ?? '路线'
    const dist = Number(props.distance_km)
    const dur = Number(props.duration_min)
    const modeLabel = props.mode_label ?? ''
    const distStr = formatRouteDistance(dist)
    const durStr = formatDurationLabel(dur)
    return `<div class="dc-hover-popup"><strong>${escapeHtml(String(name))}</strong><span class="dc-hover-category">${escapeHtml(String(modeLabel))} · ${distStr} · ${durStr}</span></div>`
  }
  if (props.kind === 'route_start' || props.kind === 'route_end') {
    const label = props.kind === 'route_start' ? '起点' : '终点'
    const name = props.name ?? label
    return `<div class="dc-hover-popup"><strong>${escapeHtml(String(name))}</strong><span class="dc-hover-category">${label}</span></div>`
  }

  const name = props.name ?? props.Name ?? props.NAME ?? props.title ?? props.label ?? ''
  const category = props.category ?? props.type ?? props.kind ?? props.amenity ?? ''
  const parts: string[] = []
  if (name) parts.push(`<strong>${escapeHtml(String(name))}</strong>`)
  if (category) parts.push(`<span class="dc-hover-category">${escapeHtml(String(category))}</span>`)
  if (!parts.length) {
    const first = Object.entries(props).find(([, value]) => value != null && String(value).trim())
    if (first) parts.push(`<span>${escapeHtml(String(first[1]))}</span>`)
  }
  return `<div class="dc-hover-popup">${parts.join('')}</div>`
}

export function buildFeaturePopupHtml(feature: maplibregl.MapGeoJSONFeature, layerName?: string) {
  const props = (feature.properties as Record<string, unknown>) ?? {}

  if (props.distance_km != null && props.duration_min != null) {
    const dist = Number(props.distance_km)
    const dur = Number(props.duration_min)
    const distStr = formatRouteDistance(dist)
    const durStr = formatDurationLabel(dur)
    const rows = [
      `<div><span>路线</span><strong>${escapeHtml(String(props.name ?? '路线'))}</strong></div>`,
      `<div><span>方式</span><strong>${escapeHtml(String(props.mode_label ?? props.mode ?? '-'))}</strong></div>`,
      `<div><span>距离</span><strong>${distStr}</strong></div>`,
      `<div><span>耗时</span><strong>${durStr}</strong></div>`,
    ].join('')
    return `<div class="dc-map-popup"><h4>${escapeHtml(layerName ?? '路线详情')}</h4>${rows}</div>`
  }
  if (props.kind === 'route_start' || props.kind === 'route_end') {
    const label = props.kind === 'route_start' ? '起点' : '终点'
    const coordinates = feature.geometry.type === 'Point' ? feature.geometry.coordinates : null
    const longitude = coordinates?.[0]
    const latitude = coordinates?.[1]
    const coords = Number.isFinite(longitude) && Number.isFinite(latitude)
      ? ` ${Number(longitude).toFixed(4)}, ${Number(latitude).toFixed(4)}`
      : ''
    const rows = [
      `<div><span>类型</span><strong>${label}</strong></div>`,
      `<div><span>名称</span><strong>${escapeHtml(String(props.name ?? label))}</strong></div>`,
      `<div><span>坐标</span><strong>${coords}</strong></div>`,
    ].join('')
    return `<div class="dc-map-popup"><h4>${escapeHtml(layerName ?? '路线节点')}</h4>${rows}</div>`
  }

  const entries = Object.entries(props)
    .filter(([, value]) => value != null && String(value).trim())
    .slice(0, 10)
  const priorityKeys = ['name', 'Name', 'NAME', 'title', 'category', 'type', 'amenity', 'addr:street', 'addr:city']
  entries.sort(([a], [b]) => {
    const ai = priorityKeys.indexOf(a)
    const bi = priorityKeys.indexOf(b)
    if (ai >= 0 && bi >= 0) return ai - bi
    if (ai >= 0) return -1
    if (bi >= 0) return 1
    return 0
  })
  const rows = entries.length
    ? entries.map(([key, rawValue]) => {
        const value = formatPopupValue(rawValue)
        return `<div><span>${escapeHtml(key)}</span><strong>${value}</strong></div>`
      }).join('')
    : '<div><span>属性</span><strong>当前对象没有可展示字段</strong></div>'
  return `
    <div class="dc-map-popup">
      <h4>${escapeHtml(layerName ?? '地图对象')}</h4>
      ${rows}
    </div>
  `
}

function formatPopupValue(value: unknown) {
  if (value == null) return '<em class="dc-null">未设置</em>'
  if (typeof value === 'boolean') return value ? '✓' : '✗'
  if (typeof value === 'number') return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  const text = String(value).trim()
  if (/^https?:\/\/\S+$/i.test(text)) return `<a href="${escapeHtml(text)}" target="_blank" rel="noopener">${escapeHtml(new URL(text).hostname)}</a>`
  return escapeHtml(text)
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

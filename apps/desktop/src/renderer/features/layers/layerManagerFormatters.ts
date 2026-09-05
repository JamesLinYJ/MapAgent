// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层管理格式化工具
//
//   文件:       layerManagerFormatters.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 提供图层管理视图共享的纯格式化函数。
// 本文件不导出 React 组件，保证组件文件可以通过 Fast Refresh 规则。

import type { LayerTreeNode } from './useLayerManager'

export function formatLayerKind(node: LayerTreeNode) {
  if (node.type === 'group') return '图层组'
  if (node.layerKind === 'raster') return '栅格图层'
  if (node.layerKind === 'geojson') return '矢量图层'
  return '地图图层'
}

export function formatLayerBounds(bounds?: [number, number, number, number] | null) {
  if (!bounds) return '暂无范围'
  return `${bounds[0].toFixed(4)}, ${bounds[1].toFixed(4)} ~ ${bounds[2].toFixed(4)}, ${bounds[3].toFixed(4)}`
}

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(4)
  if (typeof value === 'string' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}


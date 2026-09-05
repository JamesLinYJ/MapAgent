// +-------------------------------------------------------------------------
//
//   地理智能平台 - 图层状态 Store
//
//   文件:       layerStore.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import type { LayerDescriptor } from '@geo-agent-platform/shared-types'
import { create } from 'zustand'

interface LayerState {
  layers: LayerDescriptor[]
  setLayers: (layers: LayerDescriptor[]) => void
  clearLayers: () => void
}

// Zustand 只保存浏览器事实投影。HTTP/WS 副作用由应用控制器负责，
// 避免状态容器同时承担数据访问与命令编排职责。
export const useLayerStore = create<LayerState>((set) => ({
  layers: [],
  setLayers: layers => set({ layers }),
  clearLayers: () => set({ layers: [] }),
}))

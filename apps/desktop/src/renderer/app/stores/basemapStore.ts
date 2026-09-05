// +-------------------------------------------------------------------------
//
//   地理智能平台 - 底图状态 Store
//
//   文件:       basemapStore.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { BasemapDescriptor } from '@geo-agent-platform/shared-types'
import { create } from 'zustand'
import { DEFAULT_BASEMAP } from '../../shared/constants'

interface BasemapState {
  basemaps: BasemapDescriptor[]
  selectedBasemapKey: string
  setBasemaps: (basemaps: BasemapDescriptor[]) => void
  setSelectedBasemapKey: (selectedBasemapKey: string) => void
}

export const useBasemapStore = create<BasemapState>(set => ({
  basemaps: [DEFAULT_BASEMAP],
  selectedBasemapKey: DEFAULT_BASEMAP.basemapKey,
  setBasemaps: basemaps => set({ basemaps }),
  setSelectedBasemapKey: selectedBasemapKey => set({ selectedBasemapKey }),
}))

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Artifact 状态 Store
//
//   文件:       artifactStore.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { create } from 'zustand'
import type { MapLayerPreference } from '../types'

interface ArtifactState {
  data: Record<string, GeoJSON.FeatureCollection>
  metadata: Record<string, Record<string, unknown>>
  hydrationErrors: Record<string, string>
  layerPreferences: Record<string, MapLayerPreference>
  selectedArtifactId?: string
  mergeData: (entries: Array<{ artifactId: string; data: GeoJSON.FeatureCollection }>) => void
  mergeMetadata: (entries: Array<{ artifactId: string; metadata: Record<string, unknown> }>) => void
  setHydrationErrors: (updater: (current: Record<string, string>) => Record<string, string>) => void
  setLayerPreferences: (
    updater: (current: Record<string, MapLayerPreference>) => Record<string, MapLayerPreference>
  ) => void
  setSelectedArtifactId: (selectedArtifactId?: string) => void
  clear: () => void
}

export const useArtifactStore = create<ArtifactState>(set => ({
  data: {},
  metadata: {},
  hydrationErrors: {},
  layerPreferences: {},
  selectedArtifactId: undefined,
  mergeData: entries => set(state => ({
    data: {
      ...state.data,
      ...Object.fromEntries(entries.map(entry => [entry.artifactId, entry.data])),
    },
  })),
  mergeMetadata: entries => set(state => ({
    metadata: {
      ...state.metadata,
      ...Object.fromEntries(entries.map(entry => [entry.artifactId, entry.metadata])),
    },
  })),
  setHydrationErrors: updater => set(state => ({ hydrationErrors: updater(state.hydrationErrors) })),
  setLayerPreferences: updater => set(state => ({ layerPreferences: updater(state.layerPreferences) })),
  setSelectedArtifactId: selectedArtifactId => set({ selectedArtifactId }),
  clear: () => set({
    data: {},
    metadata: {},
    hydrationErrors: {},
    layerPreferences: {},
    selectedArtifactId: undefined,
  }),
}))

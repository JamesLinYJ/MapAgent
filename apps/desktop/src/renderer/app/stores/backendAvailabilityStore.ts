// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面后台可用性投影
//
//   文件:       backendAvailabilityStore.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { OperationsSnapshot } from '@geo-agent-platform/shared-types/operations'
import { create } from 'zustand'

export type DesktopBackendAvailability = 'checking' | 'starting' | 'online' | 'offline'

interface BackendAvailabilityState {
  availability: DesktopBackendAvailability
  snapshot: OperationsSnapshot | null
  errorMessage: string | null
  onlineRevision: number
  setAvailability: (
    availability: DesktopBackendAvailability,
    options?: {
      snapshot?: OperationsSnapshot | null
      errorMessage?: string | null
    },
  ) => void
}

/**
 * 后台可用性只是 Electron Main 与本机服务的实时投影。
 * Renderer 始终可以挂载；该状态只能禁用依赖后端的动作，不能成为页面启动门。
 */
export const useBackendAvailabilityStore = create<BackendAvailabilityState>(set => ({
  availability: 'checking',
  snapshot: null,
  errorMessage: null,
  onlineRevision: 0,
  setAvailability: (availability, options = {}) => set(state => ({
    availability,
    snapshot: options.snapshot === undefined ? state.snapshot : options.snapshot,
    errorMessage: options.errorMessage === undefined ? state.errorMessage : options.errorMessage,
    onlineRevision: availability === 'online' && state.availability !== 'online'
      ? state.onlineRevision + 1
      : state.onlineRevision,
  })),
}))

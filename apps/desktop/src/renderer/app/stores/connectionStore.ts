// +-------------------------------------------------------------------------
//
//   地理智能平台 - 连接状态 Store
//
//   文件:       connectionStore.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { create } from 'zustand'

type WsConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected'

interface ConnectionState {
  wsStatus: WsConnectionStatus
  lastConnectedAt: string | null
  lastDisconnectedAt: string | null
  disconnectReason: string | null
  setWsConnecting: () => void
  setWsConnected: () => void
  setWsDisconnected: (reason: string) => void
}

// useConnectionStore
//
// WebSocket 连接状态的跨组件事实源。业务消息仍由 run/session store 承载；
// 这里仅记录连接生命周期，避免各组件自己推导重连状态。
export const useConnectionStore = create<ConnectionState>((set) => ({
  wsStatus: 'idle',
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  disconnectReason: null,
  setWsConnecting: () => set({ wsStatus: 'connecting' }),
  setWsConnected: () => set({
    wsStatus: 'connected',
    lastConnectedAt: new Date().toISOString(),
    disconnectReason: null,
  }),
  setWsDisconnected: (reason) => set({
    wsStatus: 'disconnected',
    lastDisconnectedAt: new Date().toISOString(),
    disconnectReason: reason,
  }),
}))

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 浏览器认证状态
//
//   文件:       authStore.ts
//
//   日期:       2026年07月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { DesktopAuthProjection } from '../../../contracts/desktopIpc'
import { create } from 'zustand'

export type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'error'

interface AuthStoreState {
  authMe: DesktopAuthProjection | null
  status: AuthStatus
  clear: () => void
  setAuthenticated: (auth: DesktopAuthProjection) => void
  setStatus: (status: AuthStatus) => void
}

// Renderer 只保存脱敏身份投影；Cookie、CSRF 和服务端会话始终由 Main 持有。
export const useAuthStore = create<AuthStoreState>(set => ({
  authMe: null,
  status: 'checking',
  clear: () => set({ authMe: null, status: 'unauthenticated' }),
  setAuthenticated: authMe => set({ authMe, status: 'authenticated' }),
  setStatus: status => set(state => ({
    authMe: status === 'authenticated' ? state.authMe : null,
    status,
  })),
}))

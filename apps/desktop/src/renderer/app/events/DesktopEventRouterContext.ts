// +-------------------------------------------------------------------------
//
//   地理智能平台 - Renderer 桌面事件路由上下文
//
//   文件:       DesktopEventRouterContext.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createContext, useContext } from 'react'

import type { DesktopEvent } from '../../../contracts/desktopIpc'

export interface DesktopEventConsumer {
  subscribe(listener: (event: DesktopEvent) => void): () => void
}

export const DesktopEventRouterContext = createContext<DesktopEventConsumer | null>(null)

export function useDesktopEventRouter(): DesktopEventConsumer {
  const router = useContext(DesktopEventRouterContext)
  if (!router) throw new Error('桌面事件消费者未挂载 DesktopEventRouterProvider。')
  return router
}

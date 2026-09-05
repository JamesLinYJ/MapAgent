// +-------------------------------------------------------------------------
//
//   地理智能平台 - Renderer 桌面事件路由组合根
//
//   文件:       DesktopEventRouterProvider.tsx
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useEffect, useState, type ReactNode } from 'react'

import { reportClientDiagnostic } from '../../shared/utils/clientDiagnostics'
import { wsClient } from '../../ws/client'
import { DesktopEventRouter } from './DesktopEventRouter'
import { DesktopEventRouterContext } from './DesktopEventRouterContext'

export function DesktopEventRouterProvider({ children }: { children: ReactNode }) {
  const [router] = useState(() => {
    const bridge = window.platformDesktop
    if (!bridge) throw new Error('桌面事件路由缺少 Preload 安全桥。')
    return new DesktopEventRouter({
      source: bridge.events,
      realtime: wsClient,
      onListenerError: error => reportClientDiagnostic('error', {
        scope: 'desktopEventRouter',
        error,
      }),
    })
  })

  useEffect(() => {
    router.start()
    return () => router.stop()
  }, [router])

  return (
    <DesktopEventRouterContext.Provider value={router}>
      {children}
    </DesktopEventRouterContext.Provider>
  )
}

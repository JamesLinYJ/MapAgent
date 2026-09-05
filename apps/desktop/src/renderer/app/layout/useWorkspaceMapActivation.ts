// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台地图激活状态
//
//   文件:       useWorkspaceMapActivation.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react'

export interface MapFocusRequest {
  mapLayerId?: string
  nonce: number
}

export function useWorkspaceMapActivation(pathname: string) {
  const [isMapActivated, setIsMapActivated] = useState(false)
  const [mapFocusRequest, setMapFocusRequest] = useState<MapFocusRequest>()

  const activateMap = useCallback(() => {
    setIsMapActivated(true)
  }, [])

  const requestMapFocus = useCallback((mapLayerId?: string) => {
    setIsMapActivated(true)
    setMapFocusRequest(current => ({ mapLayerId, nonce: (current?.nonce ?? 0) + 1 }))
  }, [])

  useEffect(() => {
    if (pathname !== '/' || isMapActivated) return
    let firstFrame = 0
    let secondFrame = 0
    let idleHandle: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if ('requestIdleCallback' in window) {
          idleHandle = window.requestIdleCallback(activateMap, { timeout: 1200 })
        } else {
          timer = setTimeout(activateMap, 32)
        }
      })
    })

    return () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
      if (idleHandle !== undefined && 'cancelIdleCallback' in window) window.cancelIdleCallback(idleHandle)
      if (timer) clearTimeout(timer)
    }
  }, [activateMap, isMapActivated, pathname])

  return {
    activateMap,
    isMapActivated,
    mapFocusRequest,
    requestMapFocus,
  }
}

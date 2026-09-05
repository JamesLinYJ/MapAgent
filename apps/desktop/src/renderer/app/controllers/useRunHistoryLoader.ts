// +-------------------------------------------------------------------------
//
//   地理智能平台 - 运行历史加载协调器
//
//   文件:       useRunHistoryLoader.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useEffect } from 'react'

import { formatUiError } from '../bootstrap'

interface RunHistoryLoaderOptions {
  enabled: boolean
  sessionId?: string
  loadRunHistory: (sessionId: string) => Promise<unknown>
  setUiError: (message: string | undefined) => void
}

export async function loadRunHistoryPanel(
  sessionId: string,
  loadRunHistory: (sessionId: string) => Promise<unknown>,
): Promise<void> {
  await loadRunHistory(sessionId)
}

export function useRunHistoryLoader({
  enabled,
  sessionId,
  loadRunHistory,
  setUiError,
}: RunHistoryLoaderOptions): void {
  useEffect(() => {
    if (!enabled || !sessionId) return
    void loadRunHistoryPanel(sessionId, loadRunHistory).catch(error => {
      setUiError(formatUiError(error, '运行历史加载失败。'))
    })
  }, [enabled, loadRunHistory, sessionId, setUiError])
}

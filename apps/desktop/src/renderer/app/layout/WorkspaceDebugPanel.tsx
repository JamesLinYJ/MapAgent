// +-------------------------------------------------------------------------
//
//   地理智能平台 - 调试页面宿主
//
//   文件:       WorkspaceDebugPanel.tsx
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { lazy, Suspense } from 'react'
import type { DebugPageProps } from '../../features/debug/DebugPage'

const DebugPage = lazy(() => import('../../features/debug/DebugPage').then((module) => ({ default: module.DebugPage })))

export function WorkspaceDebugPanel(props: DebugPageProps) {
  return (
    <Suspense fallback={<div className="dc-route-loading">正在加载调试工作台…</div>}>
      <DebugPage {...props} />
    </Suspense>
  )
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台工具面板
//
//   文件:       WorkspaceToolPanel.tsx
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { lazy, Suspense } from 'react'
import type { ToolManagementPageProps } from '../../features/tools/ToolManagementPage'

const ToolManagementPage = lazy(() => import('../../features/tools/ToolManagementPage').then((module) => ({ default: module.ToolManagementPage })))

export function WorkspaceToolPanel(props: ToolManagementPageProps) {
  return (
    <div className="tool-management-host min-w-0">
      <Suspense fallback={<div className="dc-route-loading">正在加载工具管理…</div>}>
        <ToolManagementPage {...props} />
      </Suspense>
    </div>
  )
}

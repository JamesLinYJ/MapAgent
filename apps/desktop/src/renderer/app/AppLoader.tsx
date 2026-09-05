// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面应用渐进加载器
//
//   文件:       AppLoader.tsx
//
//   日期:       2026年06月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { lazy, Suspense } from 'react'
import { StartupScreen } from './StartupScreen'

const DesktopWorkspaceApplication = lazy(() => import('./DesktopWorkspaceApplication'))

export function AppLoader() {
  return (
    <Suspense fallback={<BootScreen />}>
      <DesktopWorkspaceApplication />
    </Suspense>
  )
}

export function BootScreen() {
  return (
    <StartupScreen
      stage="应用加载"
      title="正在准备工作台"
      description="正在加载工作区、地图引擎和本机运行环境，完成后会直接进入。"
      busy
      footer="启动过程只加载必要组件；地图和分析工具将在就绪后按需启用。"
    />
  )
}

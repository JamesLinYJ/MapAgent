// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron Renderer 入口
//
//   文件:       main.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-07-29):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 产品入口迁入 Electron；普通浏览器不挂载 GIS 工作台。
// --------------------------------------------------------------------------

// 模块职责
//
// 作为桌面 Renderer 挂载入口，装配查询缓存和全局样式资源。

import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { PRODUCT_DESKTOP_NAME } from '@geo-agent-platform/shared-types/product-identity'
import './index.css'
import { BootScreen } from './app/AppLoader'
import { ErrorBoundary } from './shared/components/ErrorBoundary'

// Renderer 入口只挂载一次且没有可热刷新的导出；异步运行壳本身位于独立模块。
// eslint-disable-next-line react-refresh/only-export-components
const DesktopApplicationRuntime = lazy(() => import('./app/DesktopApplicationRuntime'))

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('桌面 Renderer 缺少根挂载节点。')

if (!window.platformDesktop) {
  rootElement.textContent = `${PRODUCT_DESKTOP_NAME}只能通过 Electron 桌面应用启动。`
  rootElement.setAttribute('role', 'alert')
} else {
  // Main/Preload 是桌面平台信息的唯一来源；样式层据此避开原生窗口控制区。
  document.documentElement.dataset.desktopPlatform = window.platformDesktop.platform
  createRoot(rootElement).render(
    <ErrorBoundary>
      <Suspense fallback={<BootScreen />}>
        <DesktopApplicationRuntime />
      </Suspense>
    </ErrorBoundary>,
  )
}

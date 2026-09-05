// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面应用运行壳
//
//   文件:       DesktopApplicationRuntime.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { AppLoader } from './AppLoader'
import { DesktopBackendMonitor } from './DesktopBackendMonitor'
import { DesktopEventRouterProvider } from './events/DesktopEventRouterProvider'
import { ProductSetupGate } from './ProductSetupGate'

/**
 * 把后台监督、日志和完整工作区留在异步运行壳中，入口只负责立即呈现稳定启动画面。
 */
export default function DesktopApplicationRuntime() {
  return (
    <DesktopEventRouterProvider>
      <ProductSetupGate>
        <DesktopBackendMonitor>
          <AppLoader />
        </DesktopBackendMonitor>
      </ProductSetupGate>
    </DesktopEventRouterProvider>
  )
}

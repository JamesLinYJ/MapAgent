// +-------------------------------------------------------------------------
//
//   地理智能平台 - Renderer 桌面桥全局类型
//
//   文件:       desktop.d.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { DesktopBridge } from '../../contracts/desktopBridge.js'

declare global {
  interface Window {
    readonly platformDesktop?: DesktopBridge
  }
}

export {}

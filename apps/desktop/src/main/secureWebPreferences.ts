// +-------------------------------------------------------------------------
//
//   地理智能平台 - 安全窗口首选项
//
//   文件:       secureWebPreferences.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { WebPreferences } from 'electron'

interface SecureWebPreferencesOptions {
  preload?: string
  devTools?: boolean
  javascript?: boolean
  spellcheck?: boolean
}

/** 所有桌面窗口的权限基线；调用方只能选择非权限能力，不能覆盖隔离边界。 */
export function secureWebPreferences(
  options: SecureWebPreferencesOptions = {},
): WebPreferences {
  return {
    ...(options.preload ? { preload: options.preload } : {}),
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
    devTools: options.devTools ?? false,
    javascript: options.javascript ?? true,
    spellcheck: options.spellcheck ?? false,
  }
}

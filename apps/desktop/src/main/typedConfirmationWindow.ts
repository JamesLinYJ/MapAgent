// +-------------------------------------------------------------------------
//
//   地理智能平台 - Desktop 高风险文字确认窗口
//
//   文件:       typedConfirmationWindow.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { secureWebPreferences } from './secureWebPreferences.js'

import type { DesktopShutdownConfirmation } from './desktopShutdownCoordinator.js'

interface ConfirmationNavigation {
  kind: 'cancel' | 'submit'
  value: string | null
}

/**
 * Electron 没有原生文字输入对话框。这个模态窗口不使用 preload、Node、脚本
 * 或网络，只允许两个带随机 nonce 的表单导航；Main 仍会再次核对输入值。
 */
export class DesktopTypedConfirmationWindow implements DesktopShutdownConfirmation {
  async request(
    parent: BrowserWindow | null,
    input: {
      title: string
      message: string
      detail: string
      expectedText: string
    },
  ): Promise<string | null> {
    const nonce = randomUUID()
    const window = new BrowserWindow({
      width: 560,
      height: 430,
      show: false,
      modal: Boolean(parent),
      ...(parent ? { parent } : {}),
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      resizable: false,
      title: input.title,
      backgroundColor: '#f7f9fc',
      webPreferences: secureWebPreferences(),
    })
    window.removeMenu()
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    return new Promise<string | null>((resolve, reject) => {
      let settled = false
      const finish = (value: string | null): void => {
        if (settled) return
        settled = true
        resolve(value)
        if (!window.isDestroyed()) window.destroy()
      }
      window.webContents.on('will-navigate', (event, targetUrl) => {
        event.preventDefault()
        const navigation = parseConfirmationNavigation(targetUrl, nonce)
        if (!navigation) return
        finish(navigation.kind === 'submit' ? navigation.value : null)
      })
      window.once('closed', () => finish(null))
      window.once('ready-to-show', () => window.show())
      void window.loadURL(confirmationDocumentUrl(input, nonce)).catch(error => {
        if (!settled) {
          settled = true
          reject(error)
          if (!window.isDestroyed()) window.destroy()
        }
      })
    })
  }
}

export function parseConfirmationNavigation(
  targetUrl: string,
  nonce: string,
): ConfirmationNavigation | null {
  let url: URL
  try {
    url = new URL(targetUrl)
  } catch {
    return null
  }
  if (
    url.protocol !== 'geo-agent-platform-confirm:'
    || url.pathname !== `/${nonce}`
    || (url.hostname !== 'submit' && url.hostname !== 'cancel')
  ) {
    return null
  }
  return url.hostname === 'submit'
    ? { kind: 'submit', value: url.searchParams.get('confirmation') }
    : { kind: 'cancel', value: null }
}

export function confirmationDocumentUrl(
  input: {
    title: string
    message: string
    detail: string
    expectedText: string
  },
  nonce: string,
): string {
  const expected = escapeHtml(input.expectedText)
  const document = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action geo-agent-platform-confirm:">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <style>
    :root { color-scheme: light; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
    body { margin: 0; padding: 28px; background: #f7f9fc; color: #182334; }
    main { border: 1px solid #d9e0ea; border-radius: 14px; background: white; padding: 24px; box-shadow: 0 18px 48px #18314f1f; }
    h1 { margin: 0 0 14px; color: #a32121; font-size: 21px; }
    p { margin: 10px 0; line-height: 1.65; }
    .detail { color: #536176; font-size: 14px; }
    label { display: block; margin-top: 20px; font-weight: 650; }
    input { box-sizing: border-box; width: 100%; margin-top: 8px; border: 1px solid #a9b5c7; border-radius: 8px; padding: 10px 12px; font-size: 15px; }
    .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
    button { border: 1px solid #a9b5c7; border-radius: 8px; background: white; padding: 9px 16px; font-weight: 650; }
    .danger { border-color: #a32121; background: #a32121; color: white; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(input.title)}</h1>
    <p>${escapeHtml(input.message)}</p>
    <p class="detail">${escapeHtml(input.detail)}</p>
    <form action="geo-agent-platform-confirm://submit/${escapeHtml(nonce)}" method="get">
      <label>请输入“${expected}”确认
        <input name="confirmation" type="text" required autocomplete="off" pattern="${expected}" autofocus>
      </label>
      <div class="actions">
        <button class="danger" type="submit">停止全部并退出</button>
      </div>
    </form>
    <form action="geo-agent-platform-confirm://cancel/${escapeHtml(nonce)}" method="get">
      <div class="actions"><button type="submit">取消</button></div>
    </form>
  </main>
</body>
</html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(document)}`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面启动失败文档
//
//   文件:       startupFailureDocument.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  PRODUCT_CODENAME,
  PRODUCT_DESKTOP_NAME,
} from '@geo-agent-platform/shared-types/product-identity'

export function buildStartupFailureDocument(error: unknown): string {
  const message = escapeHtml(safeStartupMessage(error))
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(PRODUCT_CODENAME)} 启动失败</title>
  <style>
    :root { color-scheme: light; font-family: "Segoe UI Variable", "Microsoft YaHei UI", sans-serif; }
    * { box-sizing: border-box; }
    body { display: grid; min-width: 640px; min-height: 420px; margin: 0; place-items: center; color: #142a31; background: radial-gradient(circle at 20% 12%, rgb(48 163 179 / 16%), transparent 34%), linear-gradient(145deg, #e9f2f4, #f8fafb 52%, #edf4f5); }
    main { display: grid; width: min(430px, calc(100vw - 56px)); min-height: 330px; justify-items: center; padding: 32px 34px 28px; border: 1px solid rgb(184 202 208 / 82%); border-radius: 20px; background: linear-gradient(150deg, rgb(255 255 255 / 96%), rgb(250 253 253 / 88%)); box-shadow: inset 0 1px 0 rgb(255 255 255 / 92%), 0 26px 70px rgb(30 67 79 / 16%); text-align: center; }
    .brand { display: grid; width: 38px; height: 38px; place-items: center; border-radius: 11px; color: #fff; background: linear-gradient(145deg, #17343d, #1f7d89); box-shadow: 0 10px 22px rgb(17 91 103 / 20%); font-weight: 800; }
    strong { margin-top: 8px; font-size: 14px; }
    .mark { position: relative; width: 74px; height: 74px; margin-top: 30px; border-radius: 50%; background: #fff0f0; box-shadow: inset 0 0 0 1px rgb(185 59 59 / 18%); }
    .mark::before, .mark::after { position: absolute; inset: 9px 34px; border-radius: 999px; background: #b93b3b; content: ''; transform: rotate(45deg); }
    .mark::after { transform: rotate(-45deg); }
    h1 { margin: 24px 0 0; font-size: 25px; font-weight: 720; letter-spacing: -.035em; }
    .error { width: 100%; margin: 18px 0 0; padding: 10px 12px; border: 1px solid #e4b6b6; border-radius: 8px; color: #8f3030; background: #fff5f5; font: 11px/1.55 Consolas, "Microsoft YaHei UI", monospace; overflow-wrap: anywhere; text-align: left; }
  </style>
</head>
<body>
  <main>
    <span class="brand" aria-hidden="true">G</span>
    <strong>${escapeHtml(PRODUCT_DESKTOP_NAME)}</strong>
    <span class="mark" aria-hidden="true"></span>
    <h1>工作台尚未就绪</h1>
    <div class="error" role="alert">${message}</div>
  </main>
</body>
</html>`
}

export function safeStartupMessage(error: unknown): string {
  const raw = error instanceof Error && error.message.trim()
    ? error.message
    : '桌面主进程遇到未知启动错误。'
  return raw
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/(authorization|password|secret|token)\s*[=:]\s*[^\s,;]+/giu, '$1=[REDACTED]')
    .trim()
    .slice(0, 800)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

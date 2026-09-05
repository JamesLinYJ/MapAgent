// +-------------------------------------------------------------------------
//
//   地理智能平台 - HTTP 未命中路由边界
//
//   文件:       httpNotFound.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { NotFoundHandler } from 'hono'

/**
 * 未注册的 HTTP 路径统一返回稳定的 404 JSON；退役能力不得通过 fallback
 * 文案或静态页面伪装成仍可访问的产品入口。
 */
export const platformNotFoundHandler: NotFoundHandler = c => (
  c.json({ detail: 'Not found' }, 404)
)

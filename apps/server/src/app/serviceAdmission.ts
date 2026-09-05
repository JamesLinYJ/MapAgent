// +-------------------------------------------------------------------------
//
//   地理智能平台 - 服务接入状态
//
//   文件:       serviceAdmission.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { Context, MiddlewareHandler, Next } from 'hono'

export type ServiceAdmissionStatus = 'accepting' | 'shutting_down'

/** HTTP 与 WebSocket 共用的单一接入事实源；它只控制新工作，不取消已接受的任务。 */
export class ServiceAdmission {
  private status: ServiceAdmissionStatus = 'accepting'

  beginShutdown(): boolean {
    if (this.status === 'shutting_down') return false
    this.status = 'shutting_down'
    return true
  }

  isAccepting(): boolean {
    return this.status === 'accepting'
  }

  currentStatus(): ServiceAdmissionStatus {
    return this.status
  }
}

export function serviceAdmissionMiddleware(admission: ServiceAdmission): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (
      admission.isAccepting()
      || c.req.path === '/health'
      || c.req.path === '/health/live'
      || c.req.path === '/metrics'
    ) {
      await next()
      return
    }
    return c.json({
      detail: '服务正在关闭，已停止接收新请求。',
      code: 'service_shutting_down',
      retryable: true,
    }, 503)
  }
}

export function shuttingDownHealth(admission: ServiceAdmission): {
  status: 'shutting_down'
  checks: { admission: { ok: false; detail: string } }
} | null {
  if (admission.isAccepting()) return null
  return {
    status: 'shutting_down',
    checks: {
      admission: {
        ok: false,
        detail: '服务正在关闭，已停止接收新工作。',
      },
    },
  }
}

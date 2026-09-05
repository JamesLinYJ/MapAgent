// +-------------------------------------------------------------------------
//
//   地理智能平台 - 服务接入状态测试
//
//   文件:       serviceAdmission.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  ServiceAdmission,
  serviceAdmissionMiddleware,
  shuttingDownHealth,
} from './serviceAdmission.js'

describe('service admission', () => {
  it('becomes unready immediately and rejects new work idempotently', async () => {
    const admission = new ServiceAdmission()
    const app = new Hono()
    app.use('*', serviceAdmissionMiddleware(admission))
    app.get('/health', c => {
      const shutdown = shuttingDownHealth(admission)
      return shutdown ? c.json(shutdown, 503) : c.json({ status: 'ok' })
    })
    app.post('/api/v1/work', c => c.json({ accepted: true }))

    await expect(app.request('/health')).resolves.toMatchObject({ status: 200 })
    expect(admission.beginShutdown()).toBe(true)
    expect(admission.beginShutdown()).toBe(false)

    const health = await app.request('/health')
    const work = await app.request('/api/v1/work', { method: 'POST' })
    expect(health.status).toBe(503)
    await expect(health.json()).resolves.toMatchObject({ status: 'shutting_down' })
    expect(work.status).toBe(503)
    await expect(work.json()).resolves.toMatchObject({
      code: 'service_shutting_down',
      retryable: true,
    })
  })
})

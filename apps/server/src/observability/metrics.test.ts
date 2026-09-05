// +-------------------------------------------------------------------------
//
//   地理智能平台 - Prometheus 指标标签测试
//
//   文件:       metrics.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  httpRequestDurationMs,
  httpRequestsTotal,
  observeHttpMetrics,
} from './metrics.js'

describe('HTTP metrics route labels', () => {
  beforeEach(() => {
    httpRequestsTotal.reset()
    httpRequestDurationMs.reset()
  })

  it('uses one matched route template for many resource ids', async () => {
    const app = new Hono()
    app.use('*', observeHttpMetrics)
    app.get('/api/v1/results/:artifactId/metadata', c => c.json({
      artifactId: c.req.param('artifactId'),
    }))

    for (let index = 0; index < 50; index += 1) {
      await app.request(`/api/v1/results/artifact_${index}/metadata`)
    }

    const values = (await httpRequestsTotal.get()).values
    expect(values).toHaveLength(1)
    expect(values[0]?.labels).toMatchObject({
      method: 'GET',
      route: '/api/v1/results/:artifactId/metadata',
      status: '200',
    })
    expect(values[0]?.value).toBe(50)
  })

  it('collapses arbitrary not-found paths into one unmatched label', async () => {
    const app = new Hono()
    app.use('*', observeHttpMetrics)

    for (let index = 0; index < 20; index += 1) {
      await app.request(`/not-found/${index}`)
    }

    const values = (await httpRequestsTotal.get()).values
    expect(values).toHaveLength(1)
    expect(values[0]?.labels).toMatchObject({
      method: 'GET',
      route: 'unmatched',
      status: '404',
    })
    expect(values[0]?.value).toBe(20)
  })
})

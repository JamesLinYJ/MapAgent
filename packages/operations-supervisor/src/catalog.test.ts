// +-------------------------------------------------------------------------
//
//   地理智能平台 - 固定服务拓扑测试
//
//   文件:       catalog.test.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { SERVICE_CATALOG, SERVICE_ORDER, transitiveDependencies, transitiveDependents } from './catalog.js'

describe('fixed service catalog', () => {
  it('exposes only the three audited service identifiers', () => {
    expect(SERVICE_ORDER).toEqual(['infra', 'worker', 'api'])
    expect(Object.keys(SERVICE_CATALOG).sort()).toEqual([...SERVICE_ORDER].sort())
  })

  it('starts dependencies forward and resolves dependents for reverse shutdown', () => {
    expect(transitiveDependencies('api')).toEqual(['infra', 'worker'])
    expect(transitiveDependents('infra')).toEqual(['worker', 'api'])
    expect(transitiveDependents('worker')).toEqual(['api'])
  })

  it('allows the complete native infrastructure probe to finish without false timeouts', () => {
    expect(SERVICE_CATALOG.infra.health).toMatchObject({
      kind: 'exec',
      timeoutMs: 30_000,
      periodMs: 10_000,
    })
    expect(SERVICE_CATALOG.infra.portEnvironments).toEqual({
      development: ['POSTGIS_PORT'],
      production: ['POSTGIS_PORT'],
    })
    expect(SERVICE_CATALOG.infra.shutdown?.development).toEqual({
      windows: {
        file: 'node',
        args: ['packages/operations-supervisor/dist/nativeInfrastructure.js', '--stop'],
      },
      linux: {
        file: 'node',
        args: ['packages/operations-supervisor/dist/nativeInfrastructure.js', '--stop'],
      },
    })
    expect(SERVICE_CATALOG.infra.description).toBe('原生 PostgreSQL/PostGIS 数据库')
  })

  it('does not admit commands, paths or environment values through the public catalog key', () => {
    for (const serviceId of SERVICE_ORDER) {
      expect(SERVICE_CATALOG[serviceId].serviceId).toBe(serviceId)
      expect(SERVICE_CATALOG[serviceId].dependencies.every(value => SERVICE_ORDER.includes(value))).toBe(true)
    }
  })
})

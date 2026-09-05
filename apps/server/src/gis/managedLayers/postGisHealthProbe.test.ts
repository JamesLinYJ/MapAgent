// +-------------------------------------------------------------------------
//
//   地理智能平台 - PostGIS 健康检查测试
//
//   文件:       postGisHealthProbe.test.ts
//
//   日期:       2026年07月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import type { Database } from '../../db/connection.js'
import { PostGisHealthProbe } from './postGisHealthProbe.js'

describe('PostGisHealthProbe.status', () => {
  it('requires a PostGIS version row instead of accepting a plain database ping', async () => {
    const probe = new PostGisHealthProbe(fakeDb([]))

    await expect(probe.status()).resolves.toEqual({
      available: false,
      error: 'PostGIS 扩展未返回版本信息',
    })
  })

  it('reports available when the PostGIS extension responds with a version', async () => {
    const probe = new PostGisHealthProbe(fakeDb([{ version: '3.5.0' }]))

    await expect(probe.status()).resolves.toEqual({ available: true, error: null })
  })

  it('keeps database details out of the public health status', async () => {
    const probe = new PostGisHealthProbe(
      failingDb(new Error('function postgis_version() does not exist')),
    )

    await expect(probe.status()).resolves.toEqual({
      available: false,
      error: 'PostGIS 扩展不可用',
    })
  })
})

function fakeDb(rows: Record<string, unknown>[]): Database {
  return {
    execute: async () => ({ rows }),
  } as unknown as Database
}

function failingDb(error: Error): Database {
  return {
    execute: async () => {
      throw error
    },
  } as unknown as Database
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - Linux RPM 本机 Provider 配置迁移测试
//
//   文件:       packagedLocalRuntime.test.ts
//
//   日期:       2026年08月20日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  resolvePackagedToolProviders,
  systemctlProcessEnvironment,
} from './packagedLocalRuntime.js'

const legacyDefault = [
  'geo-platform-chart',
  'geo-platform-geocode',
  'geo-platform-plan',
  'geo-platform-spatial',
  'geo-platform-meteorology',
  'geo-platform-public-weather',
  'geo-platform-memory',
  'geo-platform-media',
  'geo-platform-scheduled-wake-up',
].join(',')

describe('packaged local runtime tool providers', () => {
  it('does not read or pass inherited credentials to systemctl', () => {
    let reads = 0
    const source = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/tester',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    } as NodeJS.ProcessEnv
    for (const name of ['OPENAI_API_KEY', 'PACKAGE_TOKEN', 'CSC_LINK']) {
      Object.defineProperty(source, name, {
        enumerable: true,
        get: () => {
          reads += 1
          return 'must-not-be-read'
        },
      })
    }

    expect(systemctlProcessEnvironment(source)).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/tester',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    })
    expect(reads).toBe(0)
  })

  it('does not enable a credential-dependent provider on a fresh installation', () => {
    expect(resolvePackagedToolProviders()).not.toContain('geo-platform-media')
  })

  it('migrates only the exact legacy default when Azure Speech is not configured', () => {
    const migrated = resolvePackagedToolProviders(new Map([
      ['ENABLED_TOOL_PROVIDERS', legacyDefault],
    ]))

    expect(migrated).not.toContain('geo-platform-media')
  })

  it('preserves explicit provider choices and configured legacy media support', () => {
    const custom = 'geo-platform-chart,geo-platform-media'
    expect(resolvePackagedToolProviders(new Map([
      ['ENABLED_TOOL_PROVIDERS', custom],
    ]))).toBe(custom)
    expect(resolvePackagedToolProviders(new Map([
      ['ENABLED_TOOL_PROVIDERS', legacyDefault],
      ['AZURE_SPEECH_KEY', 'configured-in-test'],
    ]))).toBe(legacyDefault)
  })
})

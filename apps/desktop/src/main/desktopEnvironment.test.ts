// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 非敏感环境投影测试
//
//   文件:       desktopEnvironment.test.ts
//
//   日期:       2026年08月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import { projectDesktopEnvironment } from './desktopEnvironment.js'

describe('projectDesktopEnvironment', () => {
  it('只投影桌面启动字段，不读取或转发模型、签名和登录凭据', () => {
    const projected = projectDesktopEnvironment({
      API_PORT: '18000',
      RUNTIME_ROOT: '/runtime',
      OPENAI_API_KEY: 'provider-secret',
      BETTER_AUTH_SECRET: 'login-secret',
      MACOS_SIGNING_IDENTITY: 'signing-identity',
      APPLE_API_KEY: '/private/signing-key.p8',
      COOKIE: 'session-cookie',
    })

    expect(projected).toEqual({
      API_PORT: '18000',
      RUNTIME_ROOT: '/runtime',
    })
  })
})

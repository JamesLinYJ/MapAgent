// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron 开发环境装配测试
//
//   文件:       electronViteEnvironment.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  resolveDesktopRendererServerOptions,
} from '../../electron.vite.config.js'
import { projectDesktopEnvironment } from './desktopEnvironment.js'

describe('desktop Vite environment', () => {
  it('lets Vite choose an available development port when the default is occupied', () => {
    expect(resolveDesktopRendererServerOptions({})).toEqual({
      host: '127.0.0.1',
      port: 5173,
      strictPort: false,
    })
  })

  it('keeps an explicitly configured Renderer port strict', () => {
    expect(resolveDesktopRendererServerOptions({
      DESKTOP_RENDERER_PORT: '55173',
    })).toEqual({
      host: '127.0.0.1',
      port: 55173,
      strictPort: true,
    })
  })

  it('uses only desktop Main settings and never copies provider or server secrets', () => {
    const projected = projectDesktopEnvironment({
      RUNTIME_ROOT: 'C:\\PlatformFixture\\runtime',
      DEEPSEEK_API_KEY: 'must-not-enter-desktop-build',
      BETTER_AUTH_SECRET: 'must-not-enter-desktop-build',
    })

    expect(projected).toEqual({
      RUNTIME_ROOT: 'C:\\PlatformFixture\\runtime',
    })
  })
})

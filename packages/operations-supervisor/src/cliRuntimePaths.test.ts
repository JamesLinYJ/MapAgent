// +-------------------------------------------------------------------------
//
//   地理智能平台 - 监督器命令行路径投影测试
//
//   文件:       cliRuntimePaths.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveOperationsCliPathInput } from './cliRuntimePaths.js'

describe('resolveOperationsCliPathInput', () => {
  it('uses deployment environment paths when flags are absent', () => {
    const result = resolveOperationsCliPathInput({
      arguments: {},
      environment: {
        GEO_AGENT_PLATFORM_ROOT: path.resolve('deploy-root'),
        RUNTIME_ROOT: path.resolve('deploy-runtime'),
        GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE: path.resolve('secrets', 'supervisor.token'),
        GEO_AGENT_PLATFORM_LOCAL_ROOT_SECRET_FILE: path.resolve('secrets', 'local-root.secret'),
      },
      defaultProjectRoot: path.resolve('fallback-root'),
      profile: 'production',
    })

    expect(result).toEqual({
      projectRoot: path.resolve('deploy-root'),
      runtimeRoot: path.resolve('deploy-runtime'),
      tokenFile: path.resolve('secrets', 'supervisor.token'),
      rootSecretFile: path.resolve('secrets', 'local-root.secret'),
      profile: 'production',
    })
  })

  it('gives explicit flags precedence over deployment environment', () => {
    const result = resolveOperationsCliPathInput({
      arguments: {
        root: path.resolve('flag-root'),
        runtimeRoot: path.resolve('flag-runtime'),
        tokenFile: path.resolve('flag-token'),
      },
      environment: {
        GEO_AGENT_PLATFORM_ROOT: path.resolve('env-root'),
        RUNTIME_ROOT: path.resolve('env-runtime'),
        GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE: path.resolve('env-token'),
      },
      defaultProjectRoot: path.resolve('fallback-root'),
      profile: 'development',
    })

    expect(result.projectRoot).toBe(path.resolve('flag-root'))
    expect(result.runtimeRoot).toBe(path.resolve('flag-runtime'))
    expect(result.tokenFile).toBe(path.resolve('flag-token'))
  })
})

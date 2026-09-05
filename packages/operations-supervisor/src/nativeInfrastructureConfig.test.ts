// +-------------------------------------------------------------------------
//
//   地理智能平台 - 原生基础设施配置测试
//
//   文件:       nativeInfrastructureConfig.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  nativeInfrastructureProcessEnvironment,
  postgresServerArguments,
  postgisAvailabilityArguments,
  postgisHealthArguments,
} from './nativeInfrastructure.js'
import { resolveNativeInfrastructureConfig } from './nativeInfrastructureConfig.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('native infrastructure configuration', () => {
  it('resolves only explicit native executables and a loopback private database', () => {
    const fixture = createFixture()
    const result = resolveNativeInfrastructureConfig({
      profile: 'development',
      projectRoot: fixture.projectRoot,
      runtimeRoot: fixture.runtimeRoot,
      platform: process.platform,
      environment: fixture.environment,
    })

    expect(result.database.port).toBe(55432)
    expect(result.database.name).toBe('geo_agent')
    expect(result.database.binaries.postgres).toBe(path.join(fixture.postgresBin, executable('postgres')))
    expect(result.database.binaries.pgCtl).toBe(path.join(fixture.postgresBin, executable('pg_ctl')))
    expect(result.database.dataDirectory).toBe(path.join(fixture.runtimeRoot, 'native', 'postgresql'))
  })

  it('prefers the runtime-owned portable PostgreSQL before PATH and system installs', () => {
    const fixture = createFixture()
    const portableBin = path.join(
      fixture.runtimeRoot,
      'native',
      'postgresql-portable',
      'bin',
    )
    fs.mkdirSync(portableBin, { recursive: true })
    for (const name of ['postgres', 'initdb', 'pg_ctl', 'pg_isready', 'psql', 'createdb']) {
      fs.writeFileSync(path.join(portableBin, executable(name)), '')
    }
    const environment = {
      ...fixture.environment,
      POSTGRES_BIN_DIR: undefined,
      PATH: '',
      ProgramFiles: '',
      PROGRAMFILES: '',
      ProgramW6432: '',
      PROGRAMW6432: '',
    }

    const result = resolveNativeInfrastructureConfig({
      profile: 'development',
      projectRoot: fixture.projectRoot,
      runtimeRoot: fixture.runtimeRoot,
      platform: process.platform,
      environment,
    })

    expect(result.database.binaries.postgres)
      .toBe(path.join(portableBin, executable('postgres')))
  })

  it('rejects remote databases and mismatched ports', () => {
    const fixture = createFixture()
    expect(() => resolveNativeInfrastructureConfig({
      profile: 'development',
      projectRoot: fixture.projectRoot,
      runtimeRoot: fixture.runtimeRoot,
      platform: process.platform,
      environment: {
        ...fixture.environment,
        DATABASE_URL: 'postgresql://geo_agent:secret@example.com:55432/geo_agent',
      },
    })).toThrow('不得指向远程主机')

    expect(() => resolveNativeInfrastructureConfig({
      profile: 'development',
      projectRoot: fixture.projectRoot,
      runtimeRoot: fixture.runtimeRoot,
      platform: process.platform,
      environment: {
        ...fixture.environment,
        DATABASE_URL: 'postgresql://geo_agent:secret@127.0.0.1:5432/geo_agent',
      },
    })).toThrow('必须与 POSTGIS_PORT 完全一致')
  })

  it('never accepts empty database passwords or injected SQL identifiers', () => {
    const fixture = createFixture()
    for (const databaseUrl of [
      'postgresql://geo_agent@127.0.0.1:55432/geo_agent',
      'postgresql://geo-agent:secret@127.0.0.1:55432/geo_agent',
      'postgresql://geo_agent:secret@127.0.0.1:55432/geo-agent',
    ]) {
      expect(() => resolveNativeInfrastructureConfig({
        profile: 'production',
        projectRoot: fixture.projectRoot,
        runtimeRoot: fixture.runtimeRoot,
        platform: process.platform,
        environment: { ...fixture.environment, DATABASE_URL: databaseUrl },
      })).toThrow()
    }
  })

  it('proves PostGIS and baseline schema readiness instead of trusting pg_isready', () => {
    const fixture = createFixture()
    const config = resolveNativeInfrastructureConfig({
      profile: 'development',
      projectRoot: fixture.projectRoot,
      runtimeRoot: fixture.runtimeRoot,
      platform: process.platform,
      environment: fixture.environment,
    })

    const arguments_ = postgisHealthArguments(config)
    expect(arguments_).toEqual(expect.arrayContaining([
      '-d',
      'geo_agent',
      '-X',
      '-qAt',
      'ON_ERROR_STOP=1',
    ]))
    expect(arguments_.at(-1)).toContain('SELECT postgis_full_version()')
    expect(arguments_.at(-1)).toContain('platform_sessions')
    expect(arguments_.at(-1)).toContain('platform_layer_features')
    expect(arguments_.at(-1)).toContain('platform_agent_step_contexts')
  })

  it('discovers PostGIS through the running server without requiring pg_config', () => {
    const fixture = createFixture()
    const config = resolveNativeInfrastructureConfig({
      profile: 'production',
      projectRoot: fixture.projectRoot,
      runtimeRoot: fixture.runtimeRoot,
      platform: process.platform,
      environment: fixture.environment,
    })

    expect(postgisAvailabilityArguments(config)).toEqual(expect.arrayContaining([
      '-d',
      'postgres',
      '-X',
      '-qAt',
      'ON_ERROR_STOP=1',
    ]))
    expect(postgisAvailabilityArguments(config).at(-1)).toContain('pg_available_extensions')
    expect(config.database.binaries).not.toHaveProperty('pgConfig')
  })

  it('starts the user-owned database without a privileged system socket', () => {
    const fixture = createFixture()
    const config = resolveNativeInfrastructureConfig({
      profile: 'production',
      projectRoot: fixture.projectRoot,
      runtimeRoot: fixture.runtimeRoot,
      platform: process.platform,
      environment: fixture.environment,
    })

    const arguments_ = postgresServerArguments(config)
    expect(arguments_).toEqual(expect.arrayContaining([
      '-h',
      '127.0.0.1',
      '-c',
      'unix_socket_directories=',
      'logging_collector=off',
    ]))
    expect(arguments_.join(' ')).not.toContain('/var/run/postgresql')
  })

  it('passes only native database inputs and never reads inherited credentials', () => {
    const fixture = createFixture()
    let reads = 0
    for (const name of ['OPENAI_API_KEY', 'UNRELATED_TOKEN', 'CSC_LINK']) {
      Object.defineProperty(fixture.environment, name, {
        enumerable: true,
        get: () => {
          reads += 1
          return 'must-not-be-read'
        },
      })
    }
    const config = resolveNativeInfrastructureConfig({
      profile: 'production',
      projectRoot: fixture.projectRoot,
      runtimeRoot: fixture.runtimeRoot,
      platform: process.platform,
      environment: fixture.environment,
    })

    const environment = nativeInfrastructureProcessEnvironment(config)

    expect(environment).toMatchObject({
      PGPASSWORD: 'secret',
      PGHOST: '127.0.0.1',
      PGPORT: '55432',
      PGUSER: 'geo_agent',
      PGDATABASE: 'geo_agent',
    })
    expect(environment).not.toHaveProperty('OPENAI_API_KEY')
    expect(environment).not.toHaveProperty('UNRELATED_TOKEN')
    expect(environment).not.toHaveProperty('CSC_LINK')
    expect(environment).not.toHaveProperty('DATABASE_URL')
    expect(environment).not.toHaveProperty('POSTGIS_PORT')
    expect(reads).toBe(0)
  })
})

function createFixture(): {
  projectRoot: string
  runtimeRoot: string
  postgresBin: string
  environment: NodeJS.ProcessEnv
} {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-agent-platform-native-infra-'))
  temporaryDirectories.push(projectRoot)
  const runtimeRoot = path.join(projectRoot, 'runtime')
  const postgresBin = path.join(projectRoot, 'postgres', 'bin')
  fs.mkdirSync(postgresBin, { recursive: true })
  for (const name of ['postgres', 'initdb', 'pg_ctl', 'pg_isready', 'psql', 'createdb']) {
    fs.writeFileSync(path.join(postgresBin, executable(name)), '')
  }
  return {
    projectRoot,
    runtimeRoot,
    postgresBin,
    environment: {
      DATABASE_URL: 'postgresql://geo_agent:secret@127.0.0.1:55432/geo_agent',
      POSTGIS_PORT: '55432',
      POSTGRES_BIN_DIR: postgresBin,
    },
  }
}

function executable(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}

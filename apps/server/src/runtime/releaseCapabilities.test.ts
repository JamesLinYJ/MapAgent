// +-------------------------------------------------------------------------
//
//   地理智能平台 - 服务发布能力清单测试
//
//   文件:       releaseCapabilities.test.ts
//
//   日期:       2026年08月04日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildRuntimeCapabilities, resolveReleaseId } from './releaseCapabilities.js'

const serverPackageVersion = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string }

describe('runtime release capabilities', () => {
  it('uses an explicit release id when a service artifact provides one', () => {
    expect(resolveReleaseId({ GEO_AGENT_PLATFORM_RELEASE_ID: 'release-2026.08.04' })).toBe('release-2026.08.04')
  })

  it('reads the release id from the deployment manifest', () => {
    const deploymentRoot = mkdtempSync(path.join(tmpdir(), 'geo-release-manifest-'))
    try {
      writeFileSync(path.join(deploymentRoot, 'runtime-service-manifest.json'), JSON.stringify({
        schemaVersion: 1,
        kind: 'geo-agent-runtime-service',
        releaseId: 'geo-agent-platform@0.1.0+runtime-service',
      }), 'utf8')

      expect(resolveReleaseId({ GEO_AGENT_PLATFORM_ROOT: deploymentRoot }))
        .toBe('geo-agent-platform@0.1.0+runtime-service')
    } finally {
      rmSync(deploymentRoot, { recursive: true, force: true })
    }
  })

  it('uses the workspace id only when the deployment manifest is absent', () => {
    const deploymentRoot = mkdtempSync(path.join(tmpdir(), 'geo-release-manifest-'))
    try {
      expect(resolveReleaseId({ GEO_AGENT_PLATFORM_ROOT: deploymentRoot }))
        .toBe(`geo-agent-platform@${serverPackageVersion.version}+workspace`)

      writeFileSync(path.join(deploymentRoot, 'runtime-service-manifest.json'), '{invalid', 'utf8')
      expect(() => resolveReleaseId({ GEO_AGENT_PLATFORM_ROOT: deploymentRoot })).toThrow()

      writeFileSync(path.join(deploymentRoot, 'runtime-service-manifest.json'), JSON.stringify({
        schemaVersion: 1,
        kind: 'geo-agent-runtime-service',
        releaseId: '   ',
      }), 'utf8')
      expect(() => resolveReleaseId({ GEO_AGENT_PLATFORM_ROOT: deploymentRoot }))
        .toThrow(/releaseId/u)
    } finally {
      rmSync(deploymentRoot, { recursive: true, force: true })
    }
  })

  it('rejects an explicitly configured empty release id', () => {
    expect(() => resolveReleaseId({ GEO_AGENT_PLATFORM_RELEASE_ID: '   ' }))
      .toThrow(/GEO_AGENT_PLATFORM_RELEASE_ID/u)
  })

  it('publishes a schema-validated capability handshake', () => {
    const capabilities = buildRuntimeCapabilities({
      workerContractDigest: `sha256:${'a'.repeat(64)}`,
      environment: { GEO_AGENT_PLATFORM_RELEASE_ID: 'test-release' },
    })
    expect(capabilities).toMatchObject({
      releaseId: 'test-release',
      apiProtocolVersion: 1,
      minDesktopProtocol: 1,
      maxDesktopProtocol: 1,
      workerContractDigest: `sha256:${'a'.repeat(64)}`,
    })
    expect(() => buildRuntimeCapabilities({
      workerContractDigest: 'not-a-digest',
      environment: { GEO_AGENT_PLATFORM_RELEASE_ID: 'test-release' },
    })).toThrow()
  })
})

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面导出清单测试
//
//   文件:       exportManifest.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { desktopExportRequestSchema } from '../contracts/desktopIpc.js'
import { buildDesktopExportManifest } from './exportManifest.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('desktop export manifest', () => {
  it('hashes nested artifact files and never exposes absolute paths', async () => {
    const staging = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-export-manifest-'))
    temporaryDirectories.push(staging)
    const artifactDirectory = path.join(staging, 'artifacts')
    await mkdir(artifactDirectory)
    const content = Buffer.from('杭州短时强降水')
    const artifactPath = path.join(artifactDirectory, 'artifact_1-risk.geojson')
    await writeFile(artifactPath, content)

    const manifest = await buildDesktopExportManifest(desktopExportRequestSchema.parse({
      workspaceId: 'workspace_1',
      sessionId: 'session_1',
      threadId: 'thread_1',
      title: '风险区划',
      formats: ['zip'],
      artifactIds: ['artifact_1'],
    }), staging, [artifactPath])

    expect(manifest.files).toEqual([{
      name: 'artifacts/artifact_1-risk.geojson',
      sizeBytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    }])
    expect(JSON.stringify(manifest)).not.toContain(staging)
  })

  it('rejects files outside the controlled staging directory', async () => {
    const staging = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-export-staging-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-export-outside-'))
    temporaryDirectories.push(staging, outside)
    const outsideFile = path.join(outside, 'secret.txt')
    await writeFile(outsideFile, 'secret')

    await expect(buildDesktopExportManifest(desktopExportRequestSchema.parse({
      workspaceId: 'workspace_1',
      sessionId: 'session_1',
      threadId: 'thread_1',
      title: '风险区划',
      formats: ['zip'],
      artifactIds: [],
    }), staging, [outsideFile])).rejects.toThrow('暂存目录之外')
  })
})

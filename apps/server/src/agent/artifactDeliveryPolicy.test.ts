// +-------------------------------------------------------------------------
//
//   地理智能平台 - Agent Artifact 交付授权策略测试
//
//   文件:       artifactDeliveryPolicy.test.ts
//
//   日期:       2026年07月23日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import type { AnalysisRun, ArtifactRef } from '../schemas/types.js'
import { createTestPersistenceFacade } from '../../test-support/persistenceFacadeHarness.js'
import { assertArtifactDeliveryIsVisible } from './artifactDeliveryPolicy.js'

describe('Artifact delivery authorization', () => {
  it('accepts an available Artifact from an earlier run in the same thread', async () => {
    const fixture = await createFixture()
    try {
      const previous = await fixture.store.createRun(
        fixture.session.id,
        '生成区划图',
        { threadId: fixture.thread.id },
      )
      const artifact = await persistArtifactFile(fixture.root, fixture.store, previous, 'artifact_previous_map')
      const current = await fixture.store.createRun(
        fixture.session.id,
        '继续并交付上一轮区划图',
        { threadId: fixture.thread.id },
      )

      const visible = await fixture.store.listArtifactsVisibleToRun(current.id, {
        artifactIds: [artifact.artifactId],
      })

      expect(visible).toEqual([
        expect.objectContaining({
          artifactId: artifact.artifactId,
          runId: previous.id,
          availability: 'available',
          sandboxPath: `artifacts/${previous.id}/${artifact.artifactId}.png`,
        }),
      ])
      await expect(assertArtifactDeliveryIsVisible(
        fixture.store,
        current.id,
        [artifact.artifactId],
      )).resolves.toBeUndefined()
    } finally {
      await removeFixture(fixture.root)
    }
  })

  it('rejects Artifact IDs from another thread or workspace without revealing their ownership', async () => {
    const fixture = await createFixture()
    try {
      const current = await fixture.store.createRun(
        fixture.session.id,
        '交付当前线程结果',
        { threadId: fixture.thread.id },
      )
      const otherThread = await fixture.store.createThread(fixture.session.id, '其它线程')
      const otherThreadRun = await fixture.store.createRun(
        fixture.session.id,
        '其它线程结果',
        { threadId: otherThread.id },
      )
      const otherThreadArtifact = await persistArtifactFile(
        fixture.root,
        fixture.store,
        otherThreadRun,
        'artifact_other_thread',
      )

      const otherSession = await fixture.store.createSession({
        workspaceId: 'workspace_other',
        userId: 'user_other',
      })
      const otherWorkspaceThread = await fixture.store.createThread(otherSession.id, '其它工作区线程')
      const otherWorkspaceRun = await fixture.store.createRun(
        otherSession.id,
        '其它工作区结果',
        { threadId: otherWorkspaceThread.id },
      )
      const otherWorkspaceArtifact = await persistArtifactFile(
        fixture.root,
        fixture.store,
        otherWorkspaceRun,
        'artifact_other_workspace',
      )

      await expect(assertArtifactDeliveryIsVisible(
        fixture.store,
        current.id,
        [otherThreadArtifact.artifactId, otherWorkspaceArtifact.artifactId],
      )).rejects.toThrow('当前线程不可用或未授权')
    } finally {
      await removeFixture(fixture.root)
    }
  })

  it('rejects a same-thread Artifact whose persisted content is missing', async () => {
    const fixture = await createFixture()
    try {
      const previous = await fixture.store.createRun(
        fixture.session.id,
        '登记结果',
        { threadId: fixture.thread.id },
      )
      const artifact = artifactFor(previous, 'artifact_missing_content')
      await fixture.store.persistArtifact(artifact)
      const current = await fixture.store.createRun(
        fixture.session.id,
        '继续交付结果',
        { threadId: fixture.thread.id },
      )

      await expect(assertArtifactDeliveryIsVisible(
        fixture.store,
        current.id,
        [artifact.artifactId],
      )).rejects.toThrow('Artifact 内容不可核验')
    } finally {
      await removeFixture(fixture.root)
    }
  })

  it('does not expose an Artifact created by a later run in the same thread', async () => {
    const fixture = await createFixture()
    try {
      const current = await fixture.store.createRun(
        fixture.session.id,
        '先开始当前分析',
        { threadId: fixture.thread.id },
      )
      await new Promise(resolve => setTimeout(resolve, 5))
      const later = await fixture.store.createRun(
        fixture.session.id,
        '并发产生后续结果',
        { threadId: fixture.thread.id },
      )
      const laterArtifact = await persistArtifactFile(
        fixture.root,
        fixture.store,
        later,
        'artifact_later_run',
      )

      await expect(assertArtifactDeliveryIsVisible(
        fixture.store,
        current.id,
        [laterArtifact.artifactId],
      )).rejects.toThrow('当前线程不可用或未授权')
    } finally {
      await removeFixture(fixture.root)
    }
  })

  it('rejects an Artifact path that escapes the runtime root before persistence', async () => {
    const fixture = await createFixture()
    try {
      const previous = await fixture.store.createRun(
        fixture.session.id,
        '登记非法路径结果',
        { threadId: fixture.thread.id },
      )
      const artifact = {
        ...artifactFor(previous, 'artifact_outside_root'),
        metadata: { relativePath: '../outside.png' },
      }
      await expect(fixture.store.persistArtifact(artifact)).rejects.toThrow('relativePath 越出运行目录')
    } finally {
      await removeFixture(fixture.root)
    }
  })
})

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'geo-agent-platform-artifact-authorization-'))
  const store = createTestPersistenceFacade(root)
  await store.initialize()
  const session = await store.createSession({
    workspaceId: 'workspace_main',
    userId: 'user_main',
  })
  const thread = await store.createThread(session.id, '主线程')
  return { root, store, session, thread }
}

async function persistArtifactFile(
  root: string,
  store: ReturnType<typeof createTestPersistenceFacade>,
  run: AnalysisRun,
  artifactId: string,
): Promise<ArtifactRef> {
  const artifact = artifactFor(run, artifactId)
  const relativePath = artifact.metadata.relativePath
  if (typeof relativePath !== 'string') throw new Error('测试 Artifact 缺少 relativePath')
  const absolutePath = path.resolve(root, relativePath)
  await mkdir(path.dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, Uint8Array.from([137, 80, 78, 71]))
  await store.persistArtifact(artifact)
  return artifact
}

function artifactFor(run: AnalysisRun, artifactId: string): ArtifactRef {
  return {
    artifactId,
    runId: run.id,
    artifactType: 'raster_png',
    name: `${artifactId}.png`,
    uri: `/api/v1/results/${artifactId}/file`,
    display: {
      surfaces: ['download'],
      primarySurface: 'download',
      map: null,
    },
    metadata: {
      relativePath: `artifacts/${run.id}/${artifactId}.png`,
    },
    isIntermediate: false,
  }
}

async function removeFixture(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

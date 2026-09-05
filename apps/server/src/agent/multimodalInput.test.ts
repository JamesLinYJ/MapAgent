import { describe, expect, it, vi } from 'vitest'

import type { AnalysisRun, ModelCapabilitySnapshot } from '../schemas/types.js'
import { authorizedAttachmentSummaries, buildInitialAgentInput } from './multimodalInput.js'

describe('multimodal initial input', () => {
  it('gives a text-only adapter authorized references without reading or encoding bytes', async () => {
    const run = imageRun()
    const readAuthorized = vi.fn()
    const result = await buildInitialAgentInput({
      getRun: () => run,
      fileLifecycle: { list: vi.fn(), readAuthorized },
    }, run.id, run.userQuery, modelCapabilities(['text']))

    expect(result).toEqual(expect.stringContaining('attachment:file_1'))
    expect(JSON.stringify(result)).not.toContain('data:image')
    expect(JSON.stringify(result)).not.toContain('base64')
    expect(readAuthorized).not.toHaveBeenCalled()
  })

  it('reads authorized bytes server-side only for an image-capable adapter', async () => {
    const run = imageRun()
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    const readAuthorized = vi.fn().mockResolvedValue({
      entry: {
        id: 'file_1',
        name: 'map.png',
        mediaType: 'image/png',
      },
      bytes,
    })
    const result = await buildInitialAgentInput({
      getRun: () => run,
      fileLifecycle: { list: vi.fn(), readAuthorized },
    }, run.id, run.userQuery, modelCapabilities(['text', 'image']))

    expect(readAuthorized).toHaveBeenCalledWith('file_1', 'thread_1', 20 * 1024 * 1024)
    expect(result).toEqual([expect.objectContaining({
      role: 'user',
      content: expect.arrayContaining([
        expect.objectContaining({ type: 'input_text' }),
        expect.objectContaining({
          type: 'input_image',
          image: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
        }),
      ]),
    })])
  })

  it('projects attachment metadata without ever projecting binary image data', () => {
    const summaries = authorizedAttachmentSummaries(imageRun())
    expect(summaries).toEqual([expect.objectContaining({
      fileId: 'file_1',
      kind: 'map_screenshot',
      trust: 'untrusted_user_content',
    })])
    expect(JSON.stringify(summaries)).not.toContain('data:image')
    expect(JSON.stringify(summaries)).not.toContain('base64')
  })
})

function imageRun(): AnalysisRun {
  return {
    id: 'run_1',
    threadId: 'thread_1',
    sessionId: 'session_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'private',
    userQuery: '解释地图截图',
    modelProvider: 'vision',
    modelName: 'vision-model',
    status: 'queued',
    createdAt: '2026-08-08T04:00:00.000Z',
    updatedAt: '2026-08-08T04:00:00.000Z',
    conversationPath: null,
    runtimeConfigSnapshot: null,
    state: {
      contextReferences: [{
        referenceId: 'attachment:file_1',
        kind: 'map_screenshot',
        label: 'map.png',
        description: '地图截图',
        sourceRunId: null,
        artifactId: null,
        collectionRef: null,
        layerKey: null,
        confidence: 1,
        usableAs: ['authorized_attachment'],
        metadata: {
          fileId: 'file_1',
          mediaType: 'image/png',
          attachmentKind: 'map_screenshot',
          mapContext: {
            capturedAt: '2026-08-08T04:00:00.000Z',
            viewport: { bounds: [119, 29, 121, 31], center: [120, 30], zoom: 8, bearing: 0, pitch: 20 },
            crs: 'OGC:CRS84',
            renderProjection: 'EPSG:3857',
            renderState: { status: 'idle', tilesLoaded: true },
            renderedLayers: [],
            timeRange: null,
          },
          authorizedThreadId: 'thread_1',
          trust: 'untrusted_user_content',
        },
      }],
    } as AnalysisRun['state'],
  }
}

function modelCapabilities(modalities: ModelCapabilitySnapshot['modalities']): ModelCapabilitySnapshot {
  return {
    modelId: 'vision-model',
    contextWindowTokens: 128_000,
    capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
    modalities,
  }
}

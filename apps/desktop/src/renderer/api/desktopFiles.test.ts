// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面原生文件选择门面测试
//
//   文件:       desktopFiles.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopBridge } from '../../contracts/desktopBridge'
import {
  selectDesktopAutomationDraft,
  selectDesktopLayerFile,
  selectDesktopUploadFiles,
  releaseDesktopFileHandle,
  stageDesktopImageBlob,
} from './desktopFiles'

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('desktop native file picker facade', () => {
  it('requests native file and folder selection without accepting Renderer paths', async () => {
    const select = vi.fn().mockResolvedValue([])
    installBridge({ select, stageImage: vi.fn(), release: vi.fn(), readText: vi.fn() })

    await selectDesktopUploadFiles('files')
    await selectDesktopUploadFiles('folder')
    await selectDesktopLayerFile()

    expect(select).toHaveBeenNthCalledWith(1, {
      kind: 'files',
      multiple: true,
      filters: [],
    })
    expect(select).toHaveBeenNthCalledWith(2, {
      kind: 'folder',
      multiple: false,
      filters: [],
    })
    expect(select).toHaveBeenNthCalledWith(3, {
      kind: 'files',
      multiple: false,
      filters: [{
        name: 'GeoJSON 图层',
        extensions: ['geojson', 'json'],
      }],
    })
    expect(JSON.stringify(select.mock.calls)).not.toMatch(/[A-Z]:\\/u)
  })

  it('reads an automation draft only through its one-time opaque handle', async () => {
    const file = {
      handleId: crypto.randomUUID(),
      name: 'rainfall.automation.json',
      sizeBytes: 128,
      mediaType: 'application/json',
      relativePath: 'rainfall.automation.json',
      modifiedAtMs: 100,
    }
    const select = vi.fn().mockResolvedValue([file])
    const readText = vi.fn().mockResolvedValue({
      name: file.name,
      text: '{"name":"rainfall"}',
    })
    installBridge({ select, stageImage: vi.fn(), release: vi.fn(), readText })

    await expect(selectDesktopAutomationDraft()).resolves.toEqual({
      file,
      text: '{"name":"rainfall"}',
    })
    expect(readText).toHaveBeenCalledWith({
      handleId: file.handleId,
      expectedName: file.name,
      purpose: 'automation-draft-import',
    })
  })

  it('stages pasted image bytes through Main without creating Base64 or a path', async () => {
    const handle = {
      handleId: crypto.randomUUID(),
      name: 'pasted-image.png',
      sizeBytes: 8,
      mediaType: 'image/png',
      relativePath: 'pasted-image.png',
      modifiedAtMs: 100,
    }
    const stageImage = vi.fn().mockResolvedValue(handle)
    const release = vi.fn().mockResolvedValue(undefined)
    installBridge({ select: vi.fn(), stageImage, release, readText: vi.fn() })
    const blob = new Blob([
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ], { type: 'image/png' })

    await expect(stageDesktopImageBlob(blob, 'clipboard.png')).resolves.toEqual(handle)
    const request = stageImage.mock.calls[0]?.[0] as Record<string, unknown>
    expect(request).toMatchObject({ name: 'clipboard.png', mediaType: 'image/png' })
    expect(request.bytes).toBeInstanceOf(ArrayBuffer)
    expect(JSON.stringify(request)).not.toContain('base64')
    expect(request).not.toHaveProperty('path')

    await releaseDesktopFileHandle(handle.handleId)
    expect(release).toHaveBeenCalledWith({ handleId: handle.handleId })
  })
})

function installBridge(files: DesktopBridge['files']): void {
  const bridge = { files } as unknown as DesktopBridge
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { platformDesktop: bridge },
  })
}

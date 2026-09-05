// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区资源加载协调器测试
//
//   文件:       useWorkspaceResourceLoader.test.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import { loadWorkspaceResources } from './useWorkspaceResourceLoader'

describe('workspace resource loader', () => {
  it('loads basemaps and thread-scoped layers through their resource owners', async () => {
    const loadBasemaps = vi.fn().mockResolvedValue(undefined)
    const refreshLayers = vi.fn().mockResolvedValue(undefined)

    await loadWorkspaceResources('session-1', 'thread-1', loadBasemaps, refreshLayers)

    expect(loadBasemaps).toHaveBeenCalledOnce()
    expect(refreshLayers).toHaveBeenCalledWith('session-1', 'thread-1')
  })

  it('propagates a resource-owner failure instead of reporting a successful load', async () => {
    const failure = new Error('图层读取失败')
    await expect(loadWorkspaceResources(
      'session-1',
      'thread-1',
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockRejectedValue(failure),
    )).rejects.toBe(failure)
  })
})

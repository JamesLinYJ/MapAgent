// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面 Artifact 受控下载适配器测试
//
//   文件:       desktopArtifactDownload.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestDesktopDownload, requestDesktopOpen } = vi.hoisted(() => ({
  requestDesktopDownload: vi.fn(),
  requestDesktopOpen: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  requestDesktopDownload,
  requestDesktopOpen,
}))

import {
  requestArtifactDownload,
  requestArtifactGeoJsonDownload,
  requestArtifactOpen,
} from './desktopArtifactDownload'

describe('desktop Artifact download boundary', () => {
  beforeEach(() => {
    requestDesktopDownload.mockReset()
    requestDesktopOpen.mockReset()
    requestDesktopDownload.mockResolvedValue({
      canceled: false,
      displayName: '已保存文件.geojson',
    })
    requestDesktopOpen.mockResolvedValue({
      canceled: false,
      displayName: '已打开文件.png',
    })
  })

  it('delegates an Artifact URI and suggested name to the Main-owned save boundary', async () => {
    await requestArtifactDownload({
      artifactId: 'artifact_1',
      artifactType: 'geojson',
      name: '杭州风险区划',
      uri: '/api/v1/results/artifact_1/file',
    })

    expect(requestDesktopDownload).toHaveBeenCalledWith(
      '/api/v1/results/artifact_1/file',
      '杭州风险区划.geojson',
    )
  })

  it('builds a fixed GeoJSON resource route instead of an external URL', async () => {
    await requestArtifactGeoJsonDownload({
      artifactId: 'artifact-map_1',
      name: '风险区划.geojson',
    })

    expect(requestDesktopDownload).toHaveBeenCalledWith(
      '/api/v1/results/artifact-map_1/geojson',
      '风险区划.geojson',
    )
  })

  it('fails before IPC when an Artifact has no server resource URI', async () => {
    expect(() => requestArtifactDownload({
      artifactId: 'artifact_1',
      artifactType: 'docx',
      name: '报告',
      uri: '  ',
    })).toThrow('没有可用的下载资源')
    expect(requestDesktopDownload).not.toHaveBeenCalled()
  })

  it('opens PNG and CSV artifacts with extension-aware names through Main', async () => {
    await requestArtifactOpen({
      artifactId: 'artifact_chart',
      artifactType: 'chart_png',
      name: '短时强降水风险区划图',
      uri: '/api/v1/results/artifact_chart/file',
    })
    await requestArtifactOpen({
      artifactId: 'artifact_table',
      artifactType: 'table',
      name: '各区县风险分级',
      uri: '/api/v1/results/artifact_table/file',
    })

    expect(requestDesktopOpen).toHaveBeenNthCalledWith(
      1,
      '/api/v1/results/artifact_chart/file',
      '短时强降水风险区划图.png',
    )
    expect(requestDesktopOpen).toHaveBeenNthCalledWith(
      2,
      '/api/v1/results/artifact_table/file',
      '各区县风险分级.csv',
    )
  })

  it('opens GeoJSON from the fixed authorized result route', async () => {
    await requestArtifactOpen({
      artifactId: 'artifact_geojson',
      artifactType: 'geojson',
      name: '风险区划图层',
      uri: '/untrusted-or-stale-uri',
    })

    expect(requestDesktopOpen).toHaveBeenCalledWith(
      '/api/v1/results/artifact_geojson/geojson',
      '风险区划图层.geojson',
    )
  })
})

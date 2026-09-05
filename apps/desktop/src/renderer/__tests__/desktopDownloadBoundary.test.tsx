// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面 Renderer 下载边界守卫
//
//   文件:       desktopDownloadBoundary.test.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ToolMiniAppResult } from '../features/tools/ToolMiniApp'

describe('desktop Renderer download boundary', () => {
  it('renders Tool Mini-App deliveries as native-save buttons, never external links', () => {
    const html = renderToStaticMarkup(
      <ToolMiniAppResult
        toolName="compare_radar_mosaic_reference"
        result={{ summary: '对比完成' }}
        artifacts={[{
          artifactId: 'artifact_1',
          artifactType: 'docx',
          name: '雷达对比报告.docx',
          uri: '/api/v1/results/artifact_1/file',
          metadata: { displaySurfaces: ['download'] },
        }]}
      />,
    )

    expect(html).toContain('<button')
    expect(html).toContain('雷达对比报告.docx')
    expect(html).not.toContain('target="_blank"')
    expect(html).not.toContain('href=')
  })

  it('keeps all migrated delivery surfaces on the shared Main download adapter', async () => {
    const rendererRoot = path.resolve(process.cwd(), 'src', 'renderer')
    const sources = await Promise.all([
      'features/debug/DebugPage.tsx',
      'features/tools/ToolMiniApp.tsx',
      'features/tools/automationStudio/AutomationStudio.tsx',
    ].map(relativePath => readFile(path.join(rendererRoot, relativePath), 'utf8')))

    for (const source of sources) {
      expect(source).not.toContain('target="_blank"')
      expect(source).not.toMatch(/<a[\s\S]{0,240}artifact/iu)
    }
    expect(sources[0]).toContain('requestArtifactGeoJsonDownload')
    expect(sources[0]).not.toContain('apiBaseUrl')
    expect(sources[1]).toContain('requestArtifactDownload')
    expect(sources[2]).toContain('requestArtifactDownload')
  })
})

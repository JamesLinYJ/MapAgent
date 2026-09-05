// +-------------------------------------------------------------------------
//
//   地理智能平台 - 原生文件选择入口组件测试
//
//   文件:       nativeFilePickerComponents.test.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { DetailSourcesPanel } from '../features/artifacts/DetailSourcesPanel'
import { AddView } from '../features/layers/LayerManagerViews'

describe('native file picker product entries', () => {
  it('renders the file manager as a native-picker button without a DOM file input', () => {
    const html = renderToStaticMarkup(
      <DetailSourcesPanel allFiles={[]} onUploadFile={vi.fn()} />,
    )
    expect(html).toContain('<button')
    expect(html).toContain('上传文件')
    expect(html).toContain('系统文件选择器')
    expect(html).not.toContain('type="file"')
  })

  it('renders managed layer import as a native-picker button', () => {
    const html = renderToStaticMarkup(
      <AddView onImportManagedLayer={vi.fn()} />,
    )
    expect(html).toContain('<button')
    expect(html).toContain('选择 GeoJSON 文件')
    expect(html).not.toContain('type="file"')
  })
})

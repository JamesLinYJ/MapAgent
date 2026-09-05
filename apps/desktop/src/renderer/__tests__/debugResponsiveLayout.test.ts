// +-------------------------------------------------------------------------
//
//   地理智能平台 - 配置与诊断响应式布局守卫
//
//   文件:       debugResponsiveLayout.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('configuration and diagnostics responsive layout', () => {
  it('按文档画布实际宽度重排，不依赖整个 Electron 窗口宽度', async () => {
    const source = await readFile(
      path.resolve(process.cwd(), 'src', 'renderer', 'app', 'styles', 'tools-debug.css'),
      'utf8',
    )

    expect(source).toContain('container: debug-workspace / inline-size;')
    expect(source).toContain('@container debug-workspace (min-width: 760px) and (max-width: 1180px)')
    expect(source).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));')
    expect(source).toContain('@container debug-workspace (max-width: 759px)')
    expect(source).toContain('grid-template-columns: minmax(0, 1fr);')
  })

  it('配置字段可收缩，宽表和诊断载荷保留横向滚动', async () => {
    const source = await readFile(
      path.resolve(process.cwd(), 'src', 'renderer', 'app', 'styles', 'tools-debug.css'),
      'utf8',
    )

    expect(source).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));')
    expect(source).toContain(':where(.debug-pre, .usage-run-table)')
    expect(source).toContain('overflow-x: auto;')
    expect(source).toContain('overflow-wrap: anywhere;')
  })

  it('摘要卡按文档画布宽度自动换列，不使用窗口断点强塞六列', async () => {
    const source = await readFile(
      path.resolve(process.cwd(), 'src', 'renderer', 'app', 'styles', 'tools-debug.css'),
      'utf8',
    )

    expect(source).toContain(
      'grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr));',
    )
    expect(source).not.toContain('grid-template-columns: repeat(6,')
  })
})

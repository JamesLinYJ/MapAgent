// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图容器尺寸跟踪契约测试
//
//   文件:       mapResizeContract.test.ts
//
//   日期:       2026年08月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseSync, Visitor } from 'oxc-parser'
import type { NewExpression } from 'oxc-parser'
import { describe, expect, it } from 'vitest'

describe('map canvas resize contract', () => {
  it('delegates live panel resizing to MapLibre without a competing resize observer', async () => {
    const source = await readFile(
      path.resolve('src/renderer/features/map/MapCanvas.tsx'),
      'utf8',
    )
    const parsed = parseSync('MapCanvas.tsx', source)
    expect(parsed.errors).toEqual([])
    const resizeObservers: NewExpression[] = []
    let tracksContainerResize = false

    new Visitor({
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'ResizeObserver') {
          resizeObservers.push(node)
        }
      },
      Property(node) {
        if (
          node.key.type === 'Identifier'
          && node.key.name === 'trackResize'
          && node.value.type === 'Literal'
          && node.value.value === true
        ) {
          tracksContainerResize = true
        }
      },
    }).visit(parsed.program)

    expect(tracksContainerResize).toBe(true)
    expect(resizeObservers).toHaveLength(1)
    const observerSource = source.slice(resizeObservers[0]?.start, resizeObservers[0]?.end)
    expect(observerSource).toContain('createMap()')
    expect(observerSource).not.toContain('map.resize()')
  })
})

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图工作台状态格式测试
//
//   文件:       mapWorkbenchBridge.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest'

import {
  formatMapCoordinates,
  formatMapScale,
  scaleDenominatorForWebMercator,
} from './mapWorkbenchBridge'

describe('map workbench status', () => {
  it('calculates a finite Web Mercator scale from the real zoom and latitude', () => {
    const equator = scaleDenominatorForWebMercator(10, 0)
    const hangzhou = scaleDenominatorForWebMercator(10, 30.2741)
    expect(equator).toBeGreaterThan(hangzhou)
    expect(hangzhou).toBeGreaterThan(200_000)
  })

  it('formats unavailable and real map status without fake zero values', () => {
    expect(formatMapScale(null)).toBe('比例尺 —')
    expect(formatMapScale(1_234_567)).toBe('比例尺 1:1,234,567')
    expect(formatMapCoordinates(null, null)).toBe('坐标 —')
    expect(formatMapCoordinates(120.1551, 30.2741))
      .toBe('120.1551° E  30.2741° N')
  })
})

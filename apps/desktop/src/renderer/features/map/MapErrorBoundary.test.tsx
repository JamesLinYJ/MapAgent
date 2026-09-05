// +-------------------------------------------------------------------------
//
//   地理智能平台 - 地图错误边界测试
//
//   文件:       MapErrorBoundary.test.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ErrorInfo } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { reportClientDiagnostic } from '../../shared/utils/clientDiagnostics'
import { MapErrorBoundary } from './MapErrorBoundary'

vi.mock('../../shared/utils/clientDiagnostics', () => ({
  reportClientDiagnostic: vi.fn(),
}))

describe('MapErrorBoundary', () => {
  it('reports caught map failures through the shared Renderer diagnostic boundary', () => {
    const error = new Error('地图模块加载失败。')
    const info: ErrorInfo = { componentStack: '\n at MapPanel' }
    const boundary = new MapErrorBoundary({ children: null })

    boundary.componentDidCatch(error, info)

    expect(vi.mocked(reportClientDiagnostic)).toHaveBeenCalledWith('error', {
      scope: 'MapErrorBoundary',
      error,
      detail: info,
    })
  })
})

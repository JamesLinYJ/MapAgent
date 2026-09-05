// +-------------------------------------------------------------------------
//
//   地理智能平台 - Renderer 诊断日志边界测试
//
//   文件:       rendererDiagnosticReporter.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest'

import { reportRendererDiagnostic } from './rendererDiagnosticReporter.js'

describe('reportRendererDiagnostic', () => {
  it('routes validated warnings and errors to the existing Main logger', () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    }

    reportRendererDiagnostic(logger, {
      level: 'warn',
      scope: 'workspace-bootstrap',
      message: '后端连接暂时不可用。',
      detail: null,
    })
    reportRendererDiagnostic(logger, {
      level: 'error',
      scope: 'MapErrorBoundary',
      message: '地图模块加载失败。',
      detail: '{"componentStack":"MapPanel"}',
    })

    expect(logger.warn).toHaveBeenCalledWith('renderer_diagnostic', {
      rendererScope: 'workspace-bootstrap',
      rendererMessage: '后端连接暂时不可用。',
    })
    expect(logger.error).toHaveBeenCalledWith('renderer_diagnostic', undefined, {
      rendererScope: 'MapErrorBoundary',
      rendererMessage: '地图模块加载失败。',
      rendererDetail: '{"componentStack":"MapPanel"}',
    })
  })

  it('rejects free-form fields and oversized diagnostic frames', () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    }

    expect(() => reportRendererDiagnostic(logger, {
      level: 'error',
      scope: 'renderer',
      message: '失败',
      detail: null,
      path: 'C:\\private\\file.txt',
    })).toThrow()
    expect(() => reportRendererDiagnostic(logger, {
      level: 'error',
      scope: 'renderer',
      message: 'x'.repeat(2_001),
      detail: null,
    })).toThrow()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })
})

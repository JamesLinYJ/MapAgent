// +-------------------------------------------------------------------------
//
//   地理智能平台 - Renderer 诊断日志测试
//
//   文件:       clientDiagnostics.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest'

import { reportClientDiagnostic } from './clientDiagnostics'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('reportClientDiagnostic', () => {
  it('sends only sanitized, bounded fields through the diagnostic bridge', async () => {
    const report = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      platformDesktop: {
        diagnostics: { report },
      },
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    reportClientDiagnostic('error', {
      scope: 'MapErrorBoundary',
      error: new Error('无法加载 C:\\Users\\James\\private\\map.ts'),
      detail: {
        componentStack: 'at MapPanel (/home/james/geo-agent-platform/MapPanel.tsx:12:3)',
        customMount: 'at Loader (/data/geo-agent-platform/Loader.ts:9:2)',
        apiRoute: '/api/v1/layers',
        documentation: 'https://docs.example.com/maps/errors',
        accessToken: 'never-forward-this',
      },
    })

    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce())
    const [diagnostic] = report.mock.calls[0] ?? []
    expect(diagnostic).toMatchObject({
      level: 'error',
      scope: 'MapErrorBoundary',
    })
    expect(JSON.stringify(diagnostic)).toContain('[LOCAL_PATH]')
    expect(JSON.stringify(diagnostic)).not.toContain('C:\\Users\\James')
    expect(JSON.stringify(diagnostic)).not.toContain('/home/james')
    expect(JSON.stringify(diagnostic)).not.toContain('/data/geo-agent-platform')
    expect(JSON.stringify(diagnostic)).not.toContain('never-forward-this')
    expect(JSON.stringify(diagnostic)).toContain('/api/v1/layers')
    expect(JSON.stringify(diagnostic)).toContain('https://docs.example.com/maps/errors')
  })

  it('keeps console diagnostics working when the preload bridge is unavailable', () => {
    vi.stubGlobal('window', {})
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(() => reportClientDiagnostic('warn', {
      scope: 'workspace-bootstrap',
      error: '后端暂时不可用。',
    })).not.toThrow()
    expect(warning).toHaveBeenCalled()
  })
})

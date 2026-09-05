// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面日志分页传输边界测试
//
//   文件:       desktopLogPageTransport.test.ts
//
//   日期:       2026年08月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { OperationsLogEntry, OperationsLogPage } from '@geo-agent-platform/shared-types/operations'
import { describe, expect, it } from 'vitest'

import { DESKTOP_CONTROL_FRAME_MAX_BYTES } from '../contracts/desktopIpc.js'
import { fitDesktopLogPage } from './desktopLogPageTransport.js'

describe('fitDesktopLogPage', () => {
  it('keeps the newest records in an initial snapshot within the physical IPC budget', () => {
    const page = largePage()
    const fitted = fitDesktopLogPage(page, null)

    expect(serializedBytes(fitted)).toBeLessThanOrEqual(DESKTOP_CONTROL_FRAME_MAX_BYTES)
    expect(fitted.entries.length).toBeLessThan(page.entries.length)
    expect(fitted.entries.at(-1)?.sequence).toBe(page.entries.at(-1)?.sequence)
    expect(fitted.hasMore).toBe(true)
  })

  it('keeps the oldest unread sequence in a cursor page so the next page has no gap', () => {
    const page = largePage(500)
    const fitted = fitDesktopLogPage(page, 500)

    expect(serializedBytes(fitted)).toBeLessThanOrEqual(DESKTOP_CONTROL_FRAME_MAX_BYTES)
    expect(fitted.entries[0]?.sequence).toBe(501)
    expect(fitted.nextCursor).toBe(fitted.entries.at(-1)?.sequence)
    expect(fitted.hasMore).toBe(true)
  })
})

function largePage(offset = 0): OperationsLogPage {
  const entries = Array.from({ length: 300 }, (_, index) => logEntry(offset + index + 1))
  return {
    entries,
    nextCursor: entries.at(-1)?.sequence ?? null,
    hasMore: false,
  }
}

function logEntry(sequence: number): OperationsLogEntry {
  return {
    sequence,
    serviceId: 'api',
    component: 'server',
    processId: 42,
    stream: 'stdout',
    level: 'info',
    event: 'request.http.completed',
    category: 'request',
    retention: 'operational',
    correlation: { requestId: `request_${sequence}` },
    message: `请求汇总 ${sequence} ${'运行信息'.repeat(120)}`,
    errorStack: null,
    attributes: { durationMs: sequence },
    createdAt: '2026-08-03T00:00:00.000Z',
  }
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面系统日志记录契约测试
//
//   文件:       desktopLogRecords.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { OperationsLogQuery } from '@geo-agent-platform/shared-types/operations'
import { describe, expect, it } from 'vitest'

import {
  parseDesktopFileLogRecord,
  projectDesktopLogLines,
  serializeDesktopFileLogRecord,
} from './desktopLogRecords.js'

const baseQuery: OperationsLogQuery = {
  services: ['infra', 'worker', 'api'],
  levels: [],
  streams: [],
  categories: [],
  events: [],
  retentions: [],
  correlationId: '',
  search: '',
  includeSupervisor: true,
  afterSequence: null,
  tail: 2_000,
}

describe('desktop system log records', () => {
  it('projects valid JSONL records and ignores malformed or legacy lines', () => {
    const lines = [
      'legacy text line',
      serializeDesktopFileLogRecord({
        version: 2,
        createdAt: '2026-07-29T09:00:00.000Z',
        level: 'error',
        event: 'system.supervisor.unavailable',
        category: 'system',
        retention: 'operational',
        correlation: {},
        scope: 'desktop',
        processId: 42,
        message: 'Supervisor 不可用',
        errorStack: null,
        attributes: {},
      }),
    ]

    expect(projectDesktopLogLines(lines, baseQuery)).toEqual([
      expect.objectContaining({
        sequence: 1_500_000_001,
        serviceId: null,
        component: 'desktop',
        processId: 42,
        level: 'error',
        message: 'Supervisor 不可用',
      }),
    ])
  })

  it('applies supervisor, level, stream, search and tail filters', () => {
    const lines = ['info', 'error'].map((message, index) => serializeDesktopFileLogRecord({
      version: 2,
      createdAt: `2026-07-29T09:00:0${index}.000Z`,
      level: index === 0 ? 'info' : 'error',
      event: `system.test.${message}`,
      category: 'system',
      retention: 'operational',
      correlation: {},
      scope: 'desktop',
      processId: 42,
      message,
      errorStack: null,
      attributes: {},
    }))

    expect(projectDesktopLogLines(lines, {
      ...baseQuery,
      levels: ['error'],
      streams: ['supervisor'],
      search: 'ERROR',
      tail: 1,
    })).toHaveLength(1)
    expect(projectDesktopLogLines(lines, {
      ...baseQuery,
      includeSupervisor: false,
    })).toEqual([])
  })

  it('round-trips the complete structured contract without coercing fields into message text', () => {
    const record = {
      version: 2 as const,
      createdAt: '2026-07-29T09:00:00.000Z',
      level: 'info' as const,
      event: 'lifecycle.desktop.ready',
      category: 'lifecycle' as const,
      retention: 'operational' as const,
      correlation: { requestId: 'request_1' },
      scope: 'desktop',
      processId: 42,
      message: '桌面主进程已就绪。',
      errorStack: null,
      attributes: { profile: 'development' },
    }

    expect(parseDesktopFileLogRecord(JSON.parse(serializeDesktopFileLogRecord(record)))).toEqual(record)
  })
})

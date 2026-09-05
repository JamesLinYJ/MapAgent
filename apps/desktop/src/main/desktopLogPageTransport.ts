// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面日志分页传输边界
//
//   文件:       desktopLogPageTransport.ts
//
//   日期:       2026年08月03日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { OperationsLogPage } from '@geo-agent-platform/shared-types/operations'

import { DESKTOP_CONTROL_FRAME_MAX_BYTES } from '../contracts/desktopIpc.js'

/**
 * Electron 的日志查询使用独立 IPC，但仍遵守统一的单帧上限。首次快照保留
 * 最新记录；带游标的续接页保留最早未读记录，避免裁页造成 sequence 缺口。
 */
export function fitDesktopLogPage(
  page: OperationsLogPage,
  afterSequence: number | null,
): OperationsLogPage {
  const candidate = (entryCount: number): OperationsLogPage => {
    const entries = afterSequence === null
      ? page.entries.slice(page.entries.length - entryCount)
      : page.entries.slice(0, entryCount)
    return {
      entries,
      nextCursor: entries.at(-1)?.sequence ?? afterSequence,
      hasMore: page.hasMore || entries.length < page.entries.length,
    }
  }

  let lower = 0
  let upper = page.entries.length
  while (lower < upper) {
    const entryCount = Math.ceil((lower + upper) / 2)
    if (serializedBytes(candidate(entryCount)) <= DESKTOP_CONTROL_FRAME_MAX_BYTES) {
      lower = entryCount
    } else {
      upper = entryCount - 1
    }
  }
  return candidate(lower)
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

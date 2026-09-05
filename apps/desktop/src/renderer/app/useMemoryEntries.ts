// +-------------------------------------------------------------------------
//
//   地理智能平台 - 记忆面板数据投影
//
//   文件:       useMemoryEntries.ts
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 管理工具页展示的记忆索引列表。这里仅投影 memory:list
// 响应，不把记忆正文注入聊天上下文，也不创建新的运行时事实源。

import { useCallback, useEffect, useState } from 'react'
import type { MemoryFileRecord } from '@geo-agent-platform/shared-types'

import { listMemories } from '../api/client'
import type { MemoryEntry } from '../features/memory/types'
import { reportNonBlockingError } from './bootstrap'

export function useMemoryEntries(memoryEnabled: boolean) {
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([])

  const refreshMemoryEntries = useCallback(async () => {
    const response = await loadMemoryEntries()
    setMemoryEntries(response.entries)
    return response
  }, [])

  useEffect(() => {
    if (!memoryEnabled) return
    let cancelled = false
    void loadMemoryEntries()
      .then((response) => {
        if (!cancelled) setMemoryEntries(response.entries)
      })
      .catch((error) => reportNonBlockingError('refreshMemoryEntries', error))
    return () => { cancelled = true }
  }, [memoryEnabled])

  return { memoryEntries: memoryEnabled ? memoryEntries : [], refreshMemoryEntries }
}

async function loadMemoryEntries() {
  const response = await listMemories()
  return {
    ...response,
    entries: response.records.map(memoryRecordToEntry),
  }
}

function memoryRecordToEntry(record: MemoryFileRecord): MemoryEntry {
  const updatedAt = Number.isFinite(record.mtimeMs) ? record.mtimeMs : Date.now()
  return {
    scope: record.scope === 'team' ? 'team' : 'private',
    relativePath: record.relativePath,
    name: record.name || record.relativePath,
    description: record.description || record.relativePath,
    type: record.type ?? 'project',
    age: formatRelativeAge(updatedAt),
  }
}

function formatRelativeAge(mtimeMs: number): string {
  const delta = Math.max(0, Date.now() - mtimeMs)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  return new Date(mtimeMs).toLocaleDateString('zh-CN')
}

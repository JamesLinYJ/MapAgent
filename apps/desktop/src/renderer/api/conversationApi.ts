// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话与线程 API
//
//   文件:       conversationApi.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
type AgentThreadRecord,
type CompactionRecord,
type ContextAssemblyReport,
type RunSummaryPage,
type SessionRecord,
type ThreadDetailSnapshot,
type ThreadHistoryPage,
type ThreadMemoryDocument,
} from '@geo-agent-platform/shared-types'
import {
desktopWorkspaceBootstrapSnapshotSchema,
type DesktopWorkspaceBootstrapSnapshot,
} from '../../contracts/desktopIpc'
import { requestControl } from './transport'

export async function bootstrapWorkspace(
  sessionId?: string,
  workspaceId?: string,
): Promise<DesktopWorkspaceBootstrapSnapshot> {
  return desktopWorkspaceBootstrapSnapshotSchema.parse(
    await requestControl('workspace:bootstrap', { sessionId, workspaceId }),
  )
}

export function getSession(sessionId: string): Promise<SessionRecord> {
  return requestControl('session:get', { sessionId })
}

export function listSessionThreads(sessionId: string): Promise<AgentThreadRecord[]> {
  return requestControl('thread:list', { sessionId })
}

export function createThread(sessionId: string, title?: string): Promise<AgentThreadRecord> {
  return requestControl('thread:create', { sessionId, title })
}

export function getThread(threadId: string): Promise<ThreadDetailSnapshot> {
  return requestControl('thread:get', { threadId })
}

export function updateThread(threadId: string, title: string): Promise<AgentThreadRecord> {
  return requestControl('thread:update', { threadId, title })
}

export function deleteThread(threadId: string) {
  return requestControl('thread:delete', { threadId })
}

export function listRunSummaries(
  sessionId: string,
  options: { threadId?: string | null; cursor?: string | null; limit?: number } = {},
): Promise<RunSummaryPage> {
  return requestControl('run:list', { sessionId, ...options })
}

export function getThreadHistory(
  threadId: string,
  cursor?: string | null,
  limit = 100,
): Promise<ThreadHistoryPage> {
  return requestControl('thread:history', { threadId, cursor, limit })
}

export function forkThread(threadId: string, entryId: string, title?: string): Promise<AgentThreadRecord> {
  return requestControl('thread:fork', { threadId, entryId, title })
}

export function compactThread(threadId: string): Promise<CompactionRecord | null> {
  return requestControl('thread:compact', { threadId })
}

export function getThreadContext(threadId: string): Promise<ContextAssemblyReport> {
  return requestControl('thread:context', { threadId })
}

export function getThreadMemory(threadId: string): Promise<ThreadMemoryDocument> {
  return requestControl('thread:memory:get', { threadId })
}

export function updateThreadMemory(
  threadId: string,
  content: string,
  expectedVersion: number,
): Promise<ThreadMemoryDocument> {
  return requestControl('thread:memory:update', { threadId, content, expectedVersion })
}

export function rebuildThreadMemory(threadId: string): Promise<ThreadMemoryDocument> {
  return requestControl('thread:memory:rebuild', { threadId })
}

export function listTrashedThreads(sessionId: string) {
  return requestControl('thread:trash:list', { sessionId })
}

export function restoreThread(threadId: string): Promise<AgentThreadRecord> {
  return requestControl('thread:trash:restore', { threadId })
}

export function purgeThread(threadId: string) {
  return requestControl('thread:trash:purge', { threadId })
}

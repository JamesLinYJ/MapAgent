// +-------------------------------------------------------------------------
//
//   地理智能平台 - 会话状态 Store 测试
//
//   文件:       sessionStore.test.ts
//
//   日期:       2026年07月13日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { beforeEach, describe, expect, it } from 'vitest'
import {
  analysisRunSchema,
  type AnalysisRun,
  type ConversationItem,
} from '@geo-agent-platform/shared-types'
import type { DesktopWorkspaceBootstrapSnapshot } from '../../contracts/desktopIpc'

import { useSessionStore } from '../app/stores/sessionStore'

describe('sessionStore', () => {
  beforeEach(() => {
    useSessionStore.getState().resetSessionState()
  })

  it('以一次原子更新吸收 workspace bootstrap', () => {
    const bootstrap = snapshot()
    useSessionStore.getState().applyBootstrap(bootstrap)

    const state = useSessionStore.getState()
    expect(state.session?.id).toBe('session_1')
    expect(state.sessionThreads.map(thread => thread.id)).toEqual(['thread_1'])
  })

  it('游标和加载态共用一个事实源', () => {
    useSessionStore.getState().setRunHistoryState('cursor_1', true)
    expect(useSessionStore.getState().runHistoryCursor).toBe('cursor_1')
    expect(useSessionStore.getState().isRunHistoryLoading).toBe(true)

    useSessionStore.getState().setRunHistoryLoading(false)
    expect(useSessionStore.getState().isRunHistoryLoading).toBe(false)
  })

  it('函数式更新不会覆盖并发追加的 thread run', () => {
    useSessionStore.getState().setThreadRuns(current => [...current, run('run_1')])
    useSessionStore.getState().setThreadRuns(current => [...current, run('run_2')])

    expect(useSessionStore.getState().threadRuns.map(item => item.id)).toEqual(['run_1', 'run_2'])
  })

  it('异步历史刷新不能把旧 thread 的消息写进当前 thread', () => {
    const store = useSessionStore.getState()
    store.setActiveThreadId('thread_a')
    store.setCanonicalThreadItems('thread_a', [conversationItem('entry_a', 'thread_a')])
    store.setActiveThreadId('thread_b')
    store.setCanonicalThreadItems('thread_b', [conversationItem('entry_b', 'thread_b')])
    store.setCanonicalThreadItems('thread_a', [conversationItem('stale_a', 'thread_a')])

    const state = useSessionStore.getState()
    expect(state.canonicalThreadId).toBe('thread_b')
    expect(state.canonicalThreadItems.map(item => item.itemId)).toEqual(['entry_b'])
  })
})

function snapshot(): DesktopWorkspaceBootstrapSnapshot {
  const now = '2026-07-10T00:00:00.000Z'
  return {
    auth: {
      user: {
        userId: 'user_1',
        subject: 'user_1',
        email: 'user@example.com',
        displayName: '测试用户',
        status: 'active',
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      },
      defaultWorkspace: {
        workspaceId: 'workspace_1',
        name: '测试工作区',
        description: '',
        status: 'active',
        createdByUserId: 'user_1',
        createdAt: now,
        updatedAt: now,
      },
      memberships: [],
      platformRoles: [],
      permissions: [],
      requestProtection: 'main_managed',
    },
    session: {
      id: 'session_1',
      workspaceId: 'workspace_1',
      createdByUserId: 'user_1',
      visibility: 'workspace',
      createdAt: now,
      status: 'active',
      latestThreadId: 'thread_1',
      latestRunId: null,
      latestUploadedLayerKey: null,
      latestMeteorologicalDatasetId: null,
    },
    threads: [{
      id: 'thread_1',
      sessionId: 'session_1',
      workspaceId: 'workspace_1',
      createdByUserId: 'user_1',
      visibility: 'workspace',
      title: '测试',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      latestRunId: null,
      latestUserQuery: null,
      latestAssistantSummary: null,
      latestRunStatus: null,
      latestArtifactId: null,
      latestArtifactName: null,
      historyPreview: null,
      runCount: 0,
      conversationPath: null,
    }],
    providers: [],
    tools: [],
  }
}

function run(id: string): AnalysisRun {
  const now = '2026-07-10T00:00:00.000Z'
  return analysisRunSchema.parse({
    id,
    threadId: 'thread_1',
    sessionId: 'session_1',
    workspaceId: 'workspace_1',
    createdByUserId: 'user_1',
    visibility: 'workspace',
    userQuery: '测试',
    modelProvider: null,
    modelName: null,
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    state: {
      sessionId: 'session_1',
      threadId: 'thread_1',
      userQuery: '测试',
    },
  })
}

function conversationItem(itemId: string, threadId: string): ConversationItem {
  return {
    itemId,
    itemType: 'message',
    runId: `run_${threadId}`,
    threadId,
    turnId: null,
    callId: null,
    role: 'user',
    body: itemId,
    name: null,
    arguments: null,
    output: null,
    isError: false,
    phase: null,
    status: 'completed',
    metadata: {},
    timestamp: '2026-07-10T00:00:00.000Z',
  }
}

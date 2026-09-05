// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区 URL 指针
//
//   文件:       workspacePointer.ts
//
//   日期:       2026年06月25日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

export interface WorkspacePointer {
  activeWorkspaceId?: string
  activeSessionId?: string
  activeRunId?: string
  activeThreadId?: string
  sessionSource?: 'route' | 'query'
}

const WORKSPACE_POINTER_KEY_PREFIX = 'workspace.pointer.v2.'

// URL 指针只用于当前桌面窗口恢复，不是运行历史事实源或外部分享契约。
//
// session/thread/run 的结构化事实来自 PostgreSQL；大对象和诊断载荷通过受控接口读取。
export function readWorkspacePointer(search = window.location.search): WorkspacePointer {
  const params = new URLSearchParams(search)
  const routeSessionId = readSessionIdFromPath(window.location.pathname)
  const querySessionId = normalizeParam(params.get('session'))
  const activeSessionId = routeSessionId ?? querySessionId
  const persisted = activeSessionId ? readPersistedPointer(activeSessionId) : {}
  return {
    activeWorkspaceId: normalizeParam(params.get('workspace')),
    activeSessionId,
    activeRunId: normalizeParam(params.get('run')) ?? persisted.activeRunId,
    activeThreadId: normalizeParam(params.get('thread')) ?? persisted.activeThreadId,
    sessionSource: routeSessionId
      ? 'route'
      : querySessionId
        ? 'query'
        : undefined,
  }
}

export function syncCleanWorkspaceUrl(sessionId: string, runId?: string, threadId?: string) {
  persistPointer(sessionId, { activeRunId: runId, activeThreadId: threadId })
  const url = new URL(window.location.href)
  url.searchParams.set('session', sessionId)
  if (runId) url.searchParams.set('run', runId)
  else url.searchParams.delete('run')
  if (threadId) url.searchParams.set('thread', threadId)
  else url.searchParams.delete('thread')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

function readPersistedPointer(sessionId: string): WorkspacePointer {
  try {
    const raw = window.localStorage.getItem(pointerStorageKey(sessionId))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<WorkspacePointer>
    return {
      activeRunId: normalizeStoredParam(parsed.activeRunId),
      activeThreadId: normalizeStoredParam(parsed.activeThreadId),
    }
  } catch {
    return {}
  }
}

function persistPointer(sessionId: string, pointer: WorkspacePointer) {
  try {
    window.localStorage.setItem(pointerStorageKey(sessionId), JSON.stringify(pointer))
  } catch {
    // 浏览器禁用本地存储时，工作台仍保持当前内存态；刷新后回到默认会话。
  }
}

function pointerStorageKey(sessionId: string): string {
  return `${WORKSPACE_POINTER_KEY_PREFIX}${encodeURIComponent(sessionId)}`
}

function normalizeParam(value: string | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function normalizeStoredParam(value: unknown): string | undefined {
  return typeof value === 'string' ? normalizeParam(value) : undefined
}

function readSessionIdFromPath(pathname: string): string | undefined {
  const match = /^\/session\/([^/?#]+)/u.exec(pathname)
  if (!match?.[1]) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(match[1])
  } catch (error) {
    throw new Error('会话链接包含无效的 URL 编码。', { cause: error })
  }
  const sessionId = normalizeParam(decoded)
  if (!sessionId) throw new Error('会话链接缺少有效的会话 ID。')
  return sessionId
}

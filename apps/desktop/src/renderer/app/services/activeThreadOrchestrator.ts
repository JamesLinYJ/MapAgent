// +-------------------------------------------------------------------------
//
//   地理智能平台 - 活跃线程编排服务
//
//   文件:       activeThreadOrchestrator.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

export interface ActiveThreadRecord {
  id: string
}

export interface ActiveThreadContext {
  currentThreadId?: string | null
  sessionId?: string | null
  title: string
}

export interface ActiveThreadPort<TThread extends ActiveThreadRecord> {
  createThread: (sessionId: string, title: string) => Promise<TThread>
  activateThread: (thread: TThread) => void
  addThreadToHistory: (thread: TThread) => void
  syncLocation: (sessionId: string, threadId: string) => void
}

/**
 * 统一建立需要持久化资源的活动线程。领域模块只声明线程标题，
 * 不直接操作会话 store、URL 或线程历史。
 */
export async function ensureActiveThread<TThread extends ActiveThreadRecord>(
  context: ActiveThreadContext,
  port: ActiveThreadPort<TThread>,
): Promise<string> {
  if (context.currentThreadId) return context.currentThreadId
  if (!context.sessionId) throw new Error('当前会话还没有初始化，不能创建工作线程。')

  const title = context.title.trim()
  if (!title) throw new Error('工作线程标题不能为空。')

  const thread = await port.createThread(context.sessionId, title)
  port.activateThread(thread)
  port.addThreadToHistory(thread)
  port.syncLocation(context.sessionId, thread.id)
  return thread.id
}
// +-------------------------------------------------------------------------
//
//   地理智能平台 - 活跃线程编排服务
//
//   文件:       activeThreadOrchestrator.ts
// --------------------------------------------------------------------------

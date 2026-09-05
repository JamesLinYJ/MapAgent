// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面工作区窗口位置
//
//   文件:       workspaceWindowLocation.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { DesktopWorkspaceWindowDescriptor } from '../contracts/desktopIpc.js'

/**
 * 启动窗口没有业务工作区指针；绑定真实工作区后才向 Renderer 传递恢复参数。
 */
export function buildWorkspaceWindowQuery(
  workspace: DesktopWorkspaceWindowDescriptor | null,
): string {
  if (!workspace) return ''
  const query = new URLSearchParams({ workspace: workspace.workspaceId })
  if (workspace.sessionId) query.set('session', workspace.sessionId)
  if (workspace.threadId) query.set('thread', workspace.threadId)
  return `?${query.toString()}`
}

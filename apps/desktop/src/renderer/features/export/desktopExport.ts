// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面成果导出投影
//
//   文件:       desktopExport.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type {
  DesktopExportRequest,
  DesktopExportResult,
} from '../../../contracts/desktopIpc.js'

export interface WorkspaceExportInput {
  workspaceId: string
  sessionId: string
  threadId: string
  title: string
  formats: DesktopExportRequest['formats']
  artifactIds: readonly string[]
}

export async function exportWorkspaceResult(input: WorkspaceExportInput): Promise<DesktopExportResult> {
  const bridge = window.platformDesktop
  if (!bridge) throw new Error('成果导出只允许在平台桌面应用中使用。')
  return bridge.export.create({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    threadId: input.threadId,
    title: input.title,
    formats: input.formats,
    artifactIds: [...input.artifactIds],
  })
}

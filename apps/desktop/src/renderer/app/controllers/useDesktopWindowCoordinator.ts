// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面窗口协调器
//
//   文件:       useDesktopWindowCoordinator.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react'
import type {
  AnalysisRun,
  PlatformWorkspace,
  SessionRecord,
} from '@geo-agent-platform/shared-types'

import { requireDesktopBridge } from '../../api/transport'
import { reportNonBlockingError } from '../bootstrap'
import { subscribeDesktopDocument } from '../desktopNavigation'
import type { DesktopDocument } from '../layout/WorkspaceLayout'

type WorkspaceIdentity = Pick<PlatformWorkspace, 'workspaceId' | 'name'>
interface SessionIdentity {
  id: SessionRecord['id']
  workspaceId: string
}

interface DesktopWindowCoordinatorOptions {
  runStatus?: AnalysisRun['status']
  session?: SessionIdentity
  threadId?: string
  defaultWorkspace?: WorkspaceIdentity | null
  visibleWorkspaces?: WorkspaceIdentity[]
}

export function taskbarProgressForRun(status?: AnalysisRun['status']) {
  if (status === 'queued' || status === 'running') {
    return { state: 'indeterminate' as const, value: null }
  }
  if (
    status === 'waiting_approval'
    || status === 'clarification_needed'
    || status === 'requires_action'
  ) {
    return { state: 'paused' as const, value: 1 }
  }
  if (status === 'failed' || status === 'interrupted') {
    return { state: 'error' as const, value: 1 }
  }
  return { state: 'none' as const, value: null }
}

export function resolveWorkspaceBinding(
  session: SessionIdentity,
  threadId: string | undefined,
  defaultWorkspace?: WorkspaceIdentity | null,
) {
  return {
    workspaceId: session.workspaceId,
    workspaceName: defaultWorkspace?.workspaceId === session.workspaceId
      ? defaultWorkspace.name
      : `工作区 ${session.workspaceId.slice(0, 12)}`,
    sessionId: session.id,
    threadId: threadId ?? null,
  }
}

export function resolveWorkspaceOpenTarget(
  workspaceId: string,
  visibleWorkspaces: WorkspaceIdentity[],
) {
  const workspace = visibleWorkspaces.find(item => item.workspaceId === workspaceId)
  if (!workspace) {
    throw new Error(`工作区 '${workspaceId}' 不在当前账号的可见工作区列表中。`)
  }
  return {
    workspaceId: workspace.workspaceId,
    workspaceName: workspace.name,
    sessionId: null,
    threadId: null,
  }
}

export function useDesktopWindowCoordinator({
  runStatus,
  session,
  threadId,
  defaultWorkspace,
  visibleWorkspaces = [],
}: DesktopWindowCoordinatorOptions) {
  const sessionId = session?.id
  const sessionWorkspaceId = session?.workspaceId
  const defaultWorkspaceId = defaultWorkspace?.workspaceId
  const defaultWorkspaceName = defaultWorkspace?.name

  useEffect(() => {
    void requireDesktopBridge().window.command({
      action: 'set-taskbar-progress',
      progress: taskbarProgressForRun(runStatus),
    }).catch(error => {
      reportNonBlockingError('taskbarProgress', error)
    })
  }, [runStatus])

  useEffect(() => () => {
    void requireDesktopBridge().window.command({
      action: 'set-taskbar-progress',
      progress: { state: 'none', value: null },
    }).catch(error => {
      reportNonBlockingError('taskbarProgressCleanup', error)
    })
  }, [])

  useEffect(() => {
    if (!sessionId || !sessionWorkspaceId) return
    void requireDesktopBridge().window.command({
      action: 'bind-workspace',
      workspace: resolveWorkspaceBinding(
        { id: sessionId, workspaceId: sessionWorkspaceId },
        threadId,
        defaultWorkspaceId && defaultWorkspaceName
          ? { workspaceId: defaultWorkspaceId, name: defaultWorkspaceName }
          : null,
      ),
    }).catch(error => {
      reportNonBlockingError('workspaceBinding', error)
    })
  }, [
    defaultWorkspaceId,
    defaultWorkspaceName,
    sessionId,
    sessionWorkspaceId,
    threadId,
  ])

  const openWorkspace = useCallback(async (workspaceId: string) => {
    await requireDesktopBridge().window.command({
      action: 'open-workspace',
      workspace: resolveWorkspaceOpenTarget(workspaceId, visibleWorkspaces),
    })
  }, [visibleWorkspaces])

  return { openWorkspace }
}

export function useDesktopDocumentCoordinator() {
  const [activeDesktopDocument, setActiveDesktopDocument] = useState<DesktopDocument>('map')
  useEffect(() => subscribeDesktopDocument(setActiveDesktopDocument), [])
  return {
    activeDesktopDocument,
    setActiveDesktopDocument,
  }
}

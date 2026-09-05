// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区导出协调器
//
//   文件:       useWorkspaceExportCoordinator.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { useCallback, useState } from 'react'
import type { ArtifactRef, SessionRecord } from '@geo-agent-platform/shared-types'

import { requestDesktopDownload } from '../../api/client'
import { exportWorkspaceResult } from '../../features/export/desktopExport'
import type { ExportWizardSelection } from '../../features/export/ExportWizard'
import { formatUiError } from '../bootstrap'
import type { DesktopDocument } from '../layout/WorkspaceLayout'
import { useProductIdentity } from '../ProductIdentityContext'

interface ExportScopeInput {
  session?: Pick<SessionRecord, 'id' | 'workspaceId'>
  defaultWorkspaceId?: string
  threadId?: string
}

interface WorkspaceExportCoordinatorOptions extends ExportScopeInput {
  threadTitle?: string
  selectedArtifact?: ArtifactRef
  activateMap: () => void
  setActiveDesktopDocument: (document: DesktopDocument) => void
  setUiError: (message: string | undefined) => void
}

export function resolveExportScope({
  session,
  defaultWorkspaceId,
  threadId,
}: ExportScopeInput) {
  const workspaceId = session?.workspaceId ?? defaultWorkspaceId
  if (!workspaceId || !session?.id || !threadId) {
    throw new Error('当前工作区或对话尚未就绪，无法导出成果。')
  }
  return {
    workspaceId,
    sessionId: session.id,
    threadId,
  }
}

export function useWorkspaceExportCoordinator({
  session,
  defaultWorkspaceId,
  threadId,
  threadTitle,
  selectedArtifact,
  activateMap,
  setActiveDesktopDocument,
  setUiError,
}: WorkspaceExportCoordinatorOptions) {
  const { productName } = useProductIdentity()
  const [exportWizardOpen, setExportWizardOpen] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)

  const openExportWizard = useCallback(() => {
    try {
      resolveExportScope({ session, defaultWorkspaceId, threadId })
      setExportWizardOpen(true)
    } catch (error) {
      setUiError(formatUiError(error, '当前工作区或对话尚未就绪，无法导出成果。'))
    }
  }, [defaultWorkspaceId, session, setUiError, threadId])

  const closeExportWizard = useCallback(() => {
    if (!exportBusy) setExportWizardOpen(false)
  }, [exportBusy])

  const confirmExport = useCallback(async (selection: ExportWizardSelection) => {
    let scope
    try {
      scope = resolveExportScope({ session, defaultWorkspaceId, threadId })
    } catch (error) {
      setUiError(formatUiError(error, '当前工作区或对话尚未就绪，无法导出成果。'))
      return
    }
    setExportBusy(true)
    try {
      setActiveDesktopDocument('map')
      activateMap()
      await waitForDesktopPaint()
      const result = await exportWorkspaceResult({
        ...scope,
        title: threadTitle || `${productName} 分析成果`,
        formats: selection.formats,
        artifactIds: selection.artifactIds,
      })
      if (!result.canceled) setExportWizardOpen(false)
    } catch (error) {
      setUiError(formatUiError(error, '成果导出失败。'))
    } finally {
      setExportBusy(false)
    }
  }, [
    activateMap,
    defaultWorkspaceId,
    productName,
    session,
    setActiveDesktopDocument,
    setUiError,
    threadId,
    threadTitle,
  ])

  const downloadArtifact = useCallback(async () => {
    if (!selectedArtifact) {
      setUiError('请先选择需要下载的结果。')
      return
    }
    const isGeoJson = selectedArtifact.artifactType === 'geojson'
    try {
      await requestDesktopDownload(
        `/api/v1/results/${encodeURIComponent(selectedArtifact.artifactId)}/${isGeoJson ? 'geojson' : 'file'}`,
        `${selectedArtifact.name}.${isGeoJson ? 'geojson' : 'bin'}`,
      )
    } catch (error) {
      setUiError(formatUiError(error, '结果文件下载失败。'))
    }
  }, [selectedArtifact, setUiError])

  return {
    closeExportWizard,
    confirmExport,
    downloadArtifact,
    exportBusy,
    exportWizardOpen,
    openExportWizard,
  }
}

function waitForDesktopPaint(): Promise<void> {
  return new Promise(resolve => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve())
    })
  })
}

// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话面板对话框状态
//
//   文件:       useDialogState.ts
//
//   日期:       2026年07月07日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { useCallback, useRef, useState } from 'react'
import type { AgentThreadRecord } from '@geo-agent-platform/shared-types'

type TaskDialog = { mode: 'rename'; task: AgentThreadRecord } | { mode: 'delete'; task: AgentThreadRecord } | null

export interface DialogState {
  dialog: TaskDialog
  titleDraft: string
  triggerRef: React.MutableRefObject<HTMLElement | null>
  openRename: (task: AgentThreadRecord) => void
  openDelete: (task: AgentThreadRecord) => void
  closeDialog: () => void
  submitRename: (onRename: (id: string, title: string) => void) => void
  submitDelete: (onDelete: (id: string) => void) => void
  setTitleDraft: (value: string) => void
}

export function useDialogState(): DialogState {
  const [dialog, setDialog] = useState<TaskDialog>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const triggerRef = useRef<HTMLElement | null>(null)

  const saveFocus = useCallback(() => {
    triggerRef.current = document.activeElement as HTMLElement | null
  }, [])

  const restoreFocus = useCallback(() => {
    triggerRef.current?.focus()
    triggerRef.current = null
  }, [])

  const openRename = useCallback((task: AgentThreadRecord) => {
    saveFocus()
    setTitleDraft(task.title || '')
    setDialog({ mode: 'rename', task })
  }, [saveFocus])

  const openDelete = useCallback((task: AgentThreadRecord) => {
    saveFocus()
    setDialog({ mode: 'delete', task })
  }, [saveFocus])

  const closeDialog = useCallback(() => {
    setDialog(null)
    restoreFocus()
  }, [restoreFocus])

  const submitRename = useCallback((onRename: (id: string, title: string) => void) => {
    if (dialog?.mode === 'rename' && titleDraft.trim() && titleDraft.trim() !== dialog.task.title) {
      onRename(dialog.task.id, titleDraft.trim())
    }
    closeDialog()
  }, [dialog, titleDraft, closeDialog])

  const submitDelete = useCallback((onDelete: (id: string) => void) => {
    if (dialog?.mode === 'delete') {
      onDelete(dialog.task.id)
    }
    closeDialog()
  }, [dialog, closeDialog])

  return {
    dialog,
    titleDraft,
    triggerRef,
    openRename,
    openDelete,
    closeDialog,
    submitRename,
    submitDelete,
    setTitleDraft,
  }
}

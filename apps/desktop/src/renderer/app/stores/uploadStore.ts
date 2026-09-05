// +-------------------------------------------------------------------------
//
//   地理智能平台 - 上传状态 Store
//
//   文件:       uploadStore.ts
//   日期:       2026年07月16日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { create } from 'zustand'
import type { FileEntry } from '../../api/client'
import type { UploadReference } from '../types'

interface UploadState {
  uploadedLayerName?: string
  references: UploadReference[]
  files: FileEntry[]
  isFileSubmitting: boolean
  setUploadedLayerName: (uploadedLayerName?: string) => void
  setReferences: (updater: (current: UploadReference[]) => UploadReference[]) => void
  setFiles: (files: FileEntry[]) => void
  setIsFileSubmitting: (isFileSubmitting: boolean) => void
  clear: () => void
}

export const useUploadStore = create<UploadState>(set => ({
  uploadedLayerName: undefined,
  references: [],
  files: [],
  isFileSubmitting: false,
  setUploadedLayerName: uploadedLayerName => set({ uploadedLayerName }),
  setReferences: updater => set(state => ({ references: updater(state.references) })),
  setFiles: files => set({ files }),
  setIsFileSubmitting: isFileSubmitting => set({ isFileSubmitting }),
  clear: () => set({ uploadedLayerName: undefined, references: [], files: [] }),
}))

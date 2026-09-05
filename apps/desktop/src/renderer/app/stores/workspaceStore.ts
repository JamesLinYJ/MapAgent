// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作区导航状态 Store
//
//   文件:       workspaceStore.ts
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { create } from 'zustand'
import type { PanelMode, PrimaryNav, SidebarItemId, WorkspaceMode } from '../types'

interface WorkspaceState {
  activeNav: PrimaryNav
  panelMode: PanelMode
  activeSidebarItem: SidebarItemId
  workspaceMode: WorkspaceMode
  setActiveNav: (activeNav: PrimaryNav) => void
  setPanelMode: (panelMode: PanelMode) => void
  setActiveSidebarItem: (activeSidebarItem: SidebarItemId) => void
  setWorkspaceMode: (workspaceMode: WorkspaceMode) => void
  resetWorkspaceNavigation: () => void
}

const initialWorkspaceState = {
  activeNav: 'analysis' as PrimaryNav,
  panelMode: 'summary' as PanelMode,
  activeSidebarItem: 'assistant' as SidebarItemId,
  workspaceMode: 'meteorology' as WorkspaceMode,
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  ...initialWorkspaceState,
  setActiveNav: activeNav => set({ activeNav }),
  setPanelMode: panelMode => set({ panelMode }),
  setActiveSidebarItem: activeSidebarItem => set({ activeSidebarItem }),
  setWorkspaceMode: workspaceMode => set({ workspaceMode }),
  resetWorkspaceNavigation: () => set(initialWorkspaceState),
}))

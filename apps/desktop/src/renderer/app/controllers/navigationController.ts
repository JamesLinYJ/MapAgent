// +-------------------------------------------------------------------------
//
//   地理智能平台 - 视图导航控制器
//
//   文件:       navigationController.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { useCallback, useState } from 'react'
import { SAMPLES } from '../../shared/constants'
import {
  readWorkspacePointer,
  syncCleanWorkspaceUrl,
} from '../../shared/workspacePointer'
import type { PrimaryNav, SidebarItemId, WorkspaceMode } from '../types'
import { useWorkspaceStore } from '../stores/workspaceStore'

// 导航控制器持有用户编辑态和页面视图选择。
//
// URL 只在恢复 thread/run 时编码，普通导航不会制造业务状态。
export function useNavigationController() {
  const [query, setQuery] = useState('')
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const activeNav = useWorkspaceStore(state => state.activeNav)
  const panelMode = useWorkspaceStore(state => state.panelMode)
  const activeSidebarItem = useWorkspaceStore(state => state.activeSidebarItem)
  const workspaceMode = useWorkspaceStore(state => state.workspaceMode)
  const setActiveNav = useWorkspaceStore(state => state.setActiveNav)
  const setPanelMode = useWorkspaceStore(state => state.setPanelMode)
  const setActiveSidebarItem = useWorkspaceStore(state => state.setActiveSidebarItem)
  const setWorkspaceMode = useWorkspaceStore(state => state.setWorkspaceMode)

  const focusQueryInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      const input = document.getElementById('analysis-query-input')
      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        input.focus()
        input.select()
      }
    })
  }, [])

  const focusInspectorTop = useCallback(() => {
    window.requestAnimationFrame(() => {
      const stack = document.getElementById('workbench-inspector-stack')
      if (stack instanceof HTMLElement) stack.scrollTo({ top: 0, behavior: 'smooth' })
    })
  }, [])

  const openInspector = useCallback(() => setInspectorOpen(true), [])
  const openWorkflowInspector = useCallback(() => {
    setInspectorOpen(true)
    focusInspectorTop()
  }, [focusInspectorTop])
  const toggleInspector = useCallback(() => {
    setInspectorOpen((open) => {
      if (!open) focusInspectorTop()
      return !open
    })
  }, [focusInspectorTop])

  const showSources = useCallback(() => {
    openInspector()
    setActiveNav('layers')
    setPanelMode('layerManager')
    setActiveSidebarItem('sources')
  }, [openInspector, setActiveNav, setActiveSidebarItem, setPanelMode])

  const changeWorkspaceMode = useCallback((mode: WorkspaceMode) => {
    setWorkspaceMode(mode)
  }, [setWorkspaceMode])

  const changePrimaryNav = useCallback((nav: PrimaryNav) => {
    setActiveNav(nav)
    if (nav === 'analysis') {
      setPanelMode('summary')
      setActiveSidebarItem('assistant')
      focusQueryInput()
      return
    }
    if (nav === 'layers') {
      showSources()
      return
    }
    if (nav === 'history') {
      openInspector()
      setPanelMode('history')
      setActiveSidebarItem('assistant')
      return
    }
    if (nav === 'tools') {
      setPanelMode('tools')
      setActiveSidebarItem('tools')
      return
    }
    setPanelMode('compute')
    setActiveSidebarItem('assistant')
  }, [focusQueryInput, openInspector, setActiveNav, setActiveSidebarItem, setPanelMode, showSources])

  const selectSample = useCallback((value: string) => {
    setQuery(value)
    setActiveNav('analysis')
    setPanelMode('summary')
    setActiveSidebarItem('assistant')
    focusQueryInput()
  }, [focusQueryInput, setActiveNav, setActiveSidebarItem, setPanelMode])

  const useNextTemplate = useCallback(() => {
    const currentIndex = SAMPLES.findIndex(item => item === query)
    const nextSample = SAMPLES[(currentIndex + 1 + SAMPLES.length) % SAMPLES.length]
    if (!nextSample) throw new Error('示例问题目录不能为空。')
    selectSample(nextSample)
  }, [query, selectSample])

  const selectSidebarItem = useCallback((itemId: SidebarItemId) => {
    setActiveSidebarItem(itemId)
    if (itemId === 'assistant') {
      changePrimaryNav('analysis')
      return
    }
    if (itemId === 'query') {
      setActiveNav('compute')
      setPanelMode('compute')
      return
    }
    if (itemId === 'sources') {
      showSources()
      setPanelMode('sources')
      return
    }
    if (itemId === 'tools') {
      changePrimaryNav('tools')
      return
    }
    openInspector()
    setActiveNav('analysis')
    setPanelMode(itemId === 'config' ? 'config' : 'export')
  }, [changePrimaryNav, openInspector, setActiveNav, setActiveSidebarItem, setPanelMode, showSources])

  return {
    activeNav,
    activeSidebarItem,
    changeWorkspaceMode,
    changePrimaryNav,
    focusQueryInput,
    inspectorOpen,
    openInspector,
    openWorkflowInspector,
    panelMode,
    query,
    readWorkspacePointer,
    selectSample,
    selectSidebarItem,
    setActiveNav,
    setActiveSidebarItem,
    setPanelMode,
    setQuery,
    showSources,
    syncUrl: syncCleanWorkspaceUrl,
    toggleInspector,
    useNextTemplate,
    workspaceMode,
  }
}

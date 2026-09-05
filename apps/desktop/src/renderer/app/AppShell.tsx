// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面工作台应用壳
//
//   文件:       AppShell.tsx
//
//   日期:       2026年04月14日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-07-29):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 迁移为 Electron 桌面文档工作台装配层。
// --------------------------------------------------------------------------

// 模块职责
//
// 负责装配桌面文档、工作区布局和领域控制器的 UI。

import { Suspense,useCallback,useDeferredValue,useMemo } from 'react'
import { domAnimation,LazyMotion,MotionConfig } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'

import {
cancelSubAgent,
followUpSubAgent,
getSubAgent,
getThreadTokenUsageSummary,
listAdminWorkspaces,
listProviders,
} from '../api/client'
import {
WorkspaceRestrictedDocument,
} from './layout/WorkspaceRestrictedPanels'
import {
AccountCenterPage,
LegalPolicyPage,
ModelSettingsPage,
WorkspaceRouteHost,
} from './layout/WorkspaceRouteHost'
import { useWorkspaceMapActivation } from './layout/useWorkspaceMapActivation'
import { WorkspaceShell } from './layout/WorkspaceShell'
import {
formatUiError,
} from './bootstrap'
import { useConversationTimelineProjection } from '../features/runs/useConversationTimelineProjection'
import type { RunSelectionToken } from '../features/runs/useRunState'
import { requestArtifactOpen } from '../features/artifacts/desktopArtifactDownload'
import {
useConnectionController,
useNavigationController,
useWorkspaceResources,
useRunController,
useSessionThreadController,
useToolingController,
} from './controllers'
import type {
SidebarItemId,
} from './types'
import { useMemoryEntries } from './useMemoryEntries'
import { useWorkspaceBootstrap } from './useWorkspaceBootstrap'
import {
buildAgentTodoItems,
buildDataReferences,
buildProgressItems,
extractActiveMcpServers,
extractActiveSkills,
extractCompactionLevel,
extractDenialCounts,
extractRunStats,
extractTokenBudget,
formatModelRunStatus,
} from './derivedState'
import { useWorkspaceRunProjection } from './controllers/useWorkspaceRunProjection'
import { useThreadLifecycleActions } from './controllers/useThreadLifecycleActions'
import { useRunLifecycleActions } from './controllers/useRunLifecycleActions'
import { useToolExecutionAction } from './controllers/useToolExecutionAction'
import {
useDesktopDocumentCoordinator,
useDesktopWindowCoordinator,
} from './controllers/useDesktopWindowCoordinator'
import { useWorkspaceExportCoordinator } from './controllers/useWorkspaceExportCoordinator'
import { useWorkspaceResourceLoader } from './controllers/useWorkspaceResourceLoader'
import { useRunHistoryLoader } from './controllers/useRunHistoryLoader'
import { useWorkspaceAuthenticationCoordinator } from './controllers/useWorkspaceAuthenticationCoordinator'
import { shouldLoadToolingDiagnostics } from './controllers/toolingController'
import { useBackendAvailabilityStore } from './stores/backendAvailabilityStore'
import {
deriveDesktopWorkspaceAccess,
shouldShowManagedDesktopStartup,
shouldShowDesktopLogin,
} from './workspaceAccess'
import {
type WorkspaceInspectorDetailsInput,
} from './workspaceInspectorDetails'
import { useProductIdentity } from './ProductIdentityContext'
import { AutoAuthScreen } from './auth/AutoAuthScreen'
import { ServiceConfigurationOnboarding } from '../features/settings/ServiceConfigurationOnboarding'
import { modelRouteUnavailableReason } from '../shared/providerCapabilities'

function useVoidCallback<Args extends unknown[]>(fn: (...args: Args) => Promise<void>): (...args: Args) => void {
  return useCallback((...args: Args) => { void fn(...args) }, [fn])
}

function AppShell() {
  // 主应用壳
  //
  // 装配会话、运行、资源、工具和导航控制器的页面状态。
  // 网络语义和实时订阅分别由控制器与 useRunState 所有。
  const desktopPathname = '/'
  const { productName } = useProductIdentity()
  const {
    activeDesktopDocument,
    setActiveDesktopDocument,
  } = useDesktopDocumentCoordinator()
  const {
    activateMap,
    isMapActivated,
    mapFocusRequest,
    requestMapFocus,
  } = useWorkspaceMapActivation(desktopPathname)

  const {
    run, agentState, intent, agentWorkflow,
    events, artifacts, isSubmitting, uiError,
    placeResolution,
    clearRun,
    items,
    abortRunSelection: abortRawRunSelection,
    beginRunSelection: beginRawRunSelection,
    captureRunSelection: captureRawRunSelection,
    hydrateRun,
    refreshActiveRun,
    isRunSelectionCurrent: isRawRunSelectionCurrent,
    acceptRun,
    startRun,
    stopSubmitting,
    setError: setUiError,
    cancelRun,
    respondDecision,
    steerRun,
    startAnalysis,
    startThreadRun,
  } = useRunController()
  const {
    activeThreadId,
    applyWorkspaceBootstrap,
    canonicalThreadItems,
    clearCanonicalThreadItems,
    ensureActiveThread: ensureSessionActiveThread,
    getThread,
    getThreadHistory,
    forkFromMessage,
    hasMoreRunHistory,
    isRunHistoryLoading,
    loadRunHistory,
    loadWorkspaceBootstrap,
    purgeTrashedThread,
    refreshTrash,
    refreshCanonicalThreadHistory,
    refreshSessionHistory,
    removeThread,
    renameThread,
    restoreTrashedThread,
    session,
    sessionRuns,
    sessionThreads,
    setActiveThreadId,
    setCanonicalThreadItems,
    setSession,
    setThreadRuns,
    threadRuns,
    trashedThreads,
  } = useSessionThreadController()
  const deferredEvents = useDeferredValue(events)
  const deferredItems = useDeferredValue(items)
  // 当前 run 快照只负责实时变化；完整 thread transcript 由 canonical history 投影补齐。
  const threadConversationItems = useConversationTimelineProjection(canonicalThreadItems, deferredItems)
  const {
    applyProviders,
    changeProvider: handleProviderChange,
    model,
    provider,
    providers,
    setModel,
    setProvider,
  } = useConnectionController()
  const currentThreadId = run?.threadId ?? agentState?.threadId ?? activeThreadId
  const {
    changeWorkspaceMode,
    focusQueryInput,
    openWorkflowInspector,
    panelMode,
    query,
    readWorkspacePointer,
    selectSample: handleSampleSelect,
    selectSidebarItem: handleSidebarItemClick,
    setActiveNav,
    setActiveSidebarItem,
    setPanelMode,
    setQuery,
    showSources,
    syncUrl,
    useNextTemplate: handleUseTemplate,
    workspaceMode,
  } = useNavigationController()
  const {
    applyToolDescriptors,
    availableTools,
    backgroundTasks,
    isRuntimeConfigSubmitting,
    isSkillSearching,
    isToolCatalogSubmitting,
    isToolSubmitting,
    isAutomationSubmitting,
    promoteTask: handlePromoteBackgroundTask,
    removeCatalogEntry: handleDeleteToolCatalogEntry,
    removeScheduledTask: handleDeleteScheduledTask,
    runtimeConfig,
    skillCatalog,
    skillSearchResults,
    searchSkillCatalog: handleSearchSkillCatalog,
    runTool,
    runAutomation: handleStartAutomation,
    saveCatalogEntry: handleUpsertToolCatalogEntry,
    saveRuntimeConfig: handleSaveRuntimeConfig,
    saveScheduledTask: handleSaveScheduledTask,
    setIsToolSubmitting,
    setToolRunResult,
    stopBackgroundTask: handleCancelBackgroundTask,
    stopAutomation: handleCancelAutomation,
    systemComponents,
    scheduledTasks,
    toolCatalogEntries,
    toolRunResult,
    tokenUsageSummary,
    automationDefinitions,
    automationDiagnostics,
    automationValidation,
    automationRuns,
    validateAutomationDraft: handleValidateAutomation,
    createAutomationDraft: handleCreateAutomation,
    updateAutomationDraft: handleUpdateAutomation,
    publishAutomationDraft: handlePublishAutomation,
    disableAutomationDefinition: handleDisableAutomation,
    respondToAutomationApproval: handleRespondAutomationApproval,
  } = useToolingController({
    loadDiagnostics: shouldLoadToolingDiagnostics(location.pathname, panelMode),
    setUiError,
  })
  const ensureActiveThread = useCallback(
    (title: string) => ensureSessionActiveThread(currentThreadId, syncUrl, title),
    [currentThreadId, ensureSessionActiveThread, syncUrl],
  )

  const {
    allFiles,
    artifactData,
    artifactMetadata,
    basemaps,
    changeArtifactOpacity: handleArtifactOpacityChange,
    clearArtifacts,
    clearUploads,
    exportLayer: handleExportLayer,
    importLayer: handleImportManagedLayer,
    layerManager,
    layers,
    loadBasemaps,
    mapScene,
    mapLayers,
    refreshLayers,
    removeFile: handleDeleteAnyFile,
    removeLayer: handleDeleteLayer,
    replaceLayer: handleReplaceManagedLayer,
    selectedArtifactId,
    selectedBasemap,
    selectedBasemapKey,
    setSelectedArtifactId,
    toggleArtifactVisibility: handleToggleArtifactVisibility,
    toggleLayerStatus: handleToggleLayerStatus,
    uploadedLayerName,
    uploadFile: handleUploadAnyFile,
    uploadComposerAttachment: handleUploadComposerAttachment,
    uploadFiles: handleUploadFiles,
    uploadReferences,
  } = useWorkspaceResources({
    artifacts,
    currentThreadId,
    ensureActiveThread,
    layerPreferenceKey: `${currentThreadId ?? 'no-thread'}:${run?.id ?? 'no-run'}`,
    onSessionRecord: setSession,
    onShowSources: showSources,
    runStatus: run?.status,
    session,
    setUiError,
  })

  const selectedArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.artifactId === selectedArtifactId),
    [artifacts, selectedArtifactId],
  )
  const selectedProvider = providers.find((item) => item.provider === provider)
  const providerLabel = selectedProvider?.displayName ?? provider
  const routeUnavailableReason = modelRouteUnavailableReason(selectedProvider, model)
  const currentThreadTitle = sessionThreads.find((item) => item.id === currentThreadId)?.title
  const progressItems = buildProgressItems({
    runStatus: run?.status,
    intent,
    agentWorkflow,
    artifacts,
    events: deferredEvents,
  })
  const compactionLevel = useMemo(() => extractCompactionLevel(deferredEvents), [deferredEvents])
  const tokenBudget = useMemo(() => extractTokenBudget(events), [events])
  const activeSkills = useMemo(() => extractActiveSkills(deferredEvents, agentState), [agentState, deferredEvents])
  const activeMcpServers = useMemo(() => extractActiveMcpServers(deferredEvents, agentState), [agentState, deferredEvents])
  const runStats = useMemo(() => extractRunStats(events), [events])
  const denialCounts = useMemo(() => extractDenialCounts(agentState), [agentState])
  const threadUsageRevision = useMemo(() => {
    const stats = run?.state.runtimeStats
    return [
      run?.id ?? '',
      stats?.modelInputTokens ?? 0,
      stats?.modelOutputTokens ?? 0,
      stats?.modelTotalTokens ?? 0,
      stats?.modelCacheHitInputTokens ?? 0,
      stats?.modelCacheMeasuredInputTokens ?? 0,
      stats?.modelUsageResponseCount ?? 0,
    ].join(':')
  }, [run?.id, run?.state.runtimeStats])
  const threadUsageQuery = useQuery({
    queryKey: ['thread-token-usage', currentThreadId, threadUsageRevision],
    queryFn: () => {
      if (!currentThreadId) throw new Error('当前对话缺少标识')
      return getThreadTokenUsageSummary(currentThreadId)
    },
    enabled: Boolean(session && currentThreadId),
    staleTime: 0,
    gcTime: 60_000,
    retry: 1,
  })

  const progressTasks = useMemo(
    () => buildAgentTodoItems(agentState, agentWorkflow),
    [agentState, agentWorkflow],
  )

  const dataReferences = useMemo(
    () => buildDataReferences({ layers, uploadReferences, files: allFiles, artifacts, threadRuns, currentThreadId }),
    [allFiles, artifacts, currentThreadId, layers, threadRuns, uploadReferences],
  )

  const handleSelectConversationArtifact = useCallback((artifactId: string) => {
    setSelectedArtifactId(artifactId)
    const artifact = artifacts.find(item => item.artifactId === artifactId)
    if (!artifact) {
      setUiError('当前历史记录中找不到该结果文件，请重新打开这条运行。')
      return
    }
    void requestArtifactOpen(artifact).catch(error => {
      setUiError(formatUiError(error, `无法打开“${artifact.name}”。`))
    })
  }, [artifacts, setSelectedArtifactId, setUiError])

  const handleLayerZoomTo = useCallback((mapLayerId: string) => {
    const target = mapScene.layers.find(layer => layer.manifest.mapLayerId === mapLayerId)
    if (target?.manifest.artifactId) setSelectedArtifactId(target.manifest.artifactId)
    requestMapFocus(mapLayerId)
  }, [mapScene.layers, requestMapFocus, setSelectedArtifactId])

  const {
    abortRunSelection,
    beginRunSelection,
    captureRunSelection,
    clearActiveRunState,
    hydrateRunState,
    isRunSelectionCurrent,
  } = useWorkspaceRunProjection({
    abortRunSelection: abortRawRunSelection,
    beginRunSelection: beginRawRunSelection,
    captureRunSelection: captureRawRunSelection,
    clearArtifacts,
    clearCanonicalThreadItems,
    clearRun,
    hydrateRun,
    isRunSelectionCurrent: isRawRunSelectionCurrent,
    setActiveThreadId,
    setModel,
    setProvider,
    setSelectedArtifactId,
    setThreadRuns,
    setToolRunResult,
    syncUrl,
  })

  const refreshAfterSubAgentControl = useCallback(async (
    runId: string,
    selection: RunSelectionToken | null,
  ): Promise<void> => {
    if (!selection || !isRunSelectionCurrent(selection)) return
    try {
      const hydration = await refreshActiveRun(runId, selection)
      if (hydration.status === 'superseded') return
    } catch (error) {
      if (!isRunSelectionCurrent(selection)) return
      setUiError(formatUiError(error, '协作智能体状态刷新失败，请稍后重试。'))
    }
  }, [isRunSelectionCurrent, refreshActiveRun, setUiError])

  const handleGetSubAgent = useCallback(
    (runId: string, agentId: string) => getSubAgent(runId, agentId),
    [],
  )
  const handleFollowUpSubAgent = useCallback(async (
    runId: string,
    agentId: string,
    content: string,
  ) => {
    const selection = captureRunSelection(runId)
    const agent = await followUpSubAgent(runId, agentId, content, crypto.randomUUID())
    await refreshAfterSubAgentControl(runId, selection)
    return agent
  }, [captureRunSelection, refreshAfterSubAgentControl])
  const handleCancelSubAgent = useCallback(async (
    runId: string,
    agentId: string,
    reason?: string,
  ) => {
    const selection = captureRunSelection(runId)
    const agent = await cancelSubAgent(runId, agentId, crypto.randomUUID(), reason)
    await refreshAfterSubAgentControl(runId, selection)
    return agent
  }, [captureRunSelection, refreshAfterSubAgentControl])

  const { authMe, authStatus, authMode, clearAuth, retryAuth } = useWorkspaceBootstrap({
    abortRunSelection,
    applyProviders,
    applyTools: applyToolDescriptors,
    applyWorkspaceBootstrap,
    beginRunSelection,
    clearActiveRunState,
    getThreadHistory,
    hydrateRunState,
    isRunSelectionCurrent,
    loadWorkspaceBootstrap,
    readWorkspacePointer,
    setActiveThreadId,
    setCanonicalThreadItems,
    setUiError,
    syncUrl,
    disabled: false,
    syncWorkspaceUrl: true,
  })
  const backendOnlineRevision = useBackendAvailabilityStore(state => state.onlineRevision)
  const backendAvailability = useBackendAvailabilityStore(state => state.availability)
  const backendError = useBackendAvailabilityStore(state => state.errorMessage)
  const workspaceAccess = useMemo(() => deriveDesktopWorkspaceAccess({
    authMode,
    authStatus,
    backendAvailability,
    backendError,
    authenticationError: uiError,
    hasAuthenticatedIdentity: Boolean(authMe),
    platformRoles: authMe?.platformRoles,
  }), [
    authMe,
    authMode,
    authStatus,
    backendAvailability,
    backendError,
    uiError,
  ])
  const { handleLogout } = useWorkspaceAuthenticationCoordinator({
    hasAuthenticatedIdentity: Boolean(authMe),
    authMode,
    authStatus,
    backendOnlineRevision,
    clearAuth,
    retryAuth,
    setUiError,
  })
  const visibleWorkspacesQuery = useQuery({
    queryKey: ['desktop', 'visible-workspaces', authMe?.user.userId],
    queryFn: listAdminWorkspaces,
    enabled: workspaceAccess.backendActionsEnabled,
    staleTime: 60_000,
  })
  const { openWorkspace: openDesktopWorkspace } = useDesktopWindowCoordinator({
    runStatus: run?.status,
    session: session?.workspaceId
      ? { id: session.id, workspaceId: session.workspaceId }
      : undefined,
    threadId: currentThreadId,
    defaultWorkspace: authMe?.defaultWorkspace,
    visibleWorkspaces: visibleWorkspacesQuery.data,
  })
  const {
    closeExportWizard,
    confirmExport: handleConfirmExport,
    downloadArtifact: handleDownloadArtifact,
    exportBusy,
    exportWizardOpen,
    openExportWizard: handleExportResults,
  } = useWorkspaceExportCoordinator({
    session,
    defaultWorkspaceId: authMe?.defaultWorkspace?.workspaceId,
    threadId: currentThreadId,
    threadTitle: currentThreadTitle,
    selectedArtifact,
    activateMap,
    setActiveDesktopDocument,
    setUiError,
  })
  const { memoryEntries, refreshMemoryEntries } = useMemoryEntries(
    workspaceAccess.backendActionsEnabled && runtimeConfig?.context.memoryEnabled !== false,
  )

  useRunHistoryLoader({
    enabled: workspaceAccess.backendActionsEnabled && panelMode === 'history',
    sessionId: session?.id,
    loadRunHistory,
    setUiError,
  })

  const panelNeedsWorkspaceResources = panelMode === 'layers' || panelMode === 'sources' || panelMode === 'layerManager'
  const shouldLoadWorkspaceResources = isMapActivated || panelNeedsWorkspaceResources
  useWorkspaceResourceLoader({
    enabled: workspaceAccess.backendActionsEnabled && shouldLoadWorkspaceResources,
    sessionId: session?.id,
    threadId: currentThreadId,
    loadBasemaps,
    refreshLayers,
  })

  const { handleInterruptRun, handleRespondDecision, handleSubmit } = useRunLifecycleActions({
    abortRunSelection,
    beginRunSelection,
    captureRunSelection,
    session,
    currentThreadId,
    query,
    items,
    providers,
    provider,
    model,
    run,
    acceptRun,
    cancelRun,
    clearArtifacts,
    clearCanonicalThreadItems,
    hydrateRunState,
    isRunSelectionCurrent,
    refreshCanonicalThreadHistory,
    refreshSessionHistory,
    respondDecision,
    steerRun,
    setActiveNav,
    setActiveThreadId,
    setActiveSidebarItem,
    setCanonicalThreadItems,
    setModel,
    setPanelMode,
    setProvider,
    setQuery,
    setThreadRuns,
    setToolRunResult,
    setUiError,
    startAnalysis,
    startRun,
    startThreadRun,
    stopSubmitting,
    syncUrl,
  })

  const {
    handleDeleteThread,
    handleForkMessage,
    handleLoadMoreHistory,
    handleNewConversation,
    handlePurgeThread,
    handleRefreshMemories,
    handleRefreshTrash,
    handleRenameThread,
    handleRestoreThread,
    handleSelectThread,
  } = useThreadLifecycleActions({
    abortRunSelection,
    beginRunSelection,
    session,
    currentThreadId,
    clearActiveRunState,
    clearUploads,
    focusQueryInput,
    forkFromMessage,
    getThread,
    getThreadHistory,
    hasMoreRunHistory,
    hydrateRunState,
    isRunSelectionCurrent,
    isRunHistoryLoading,
    loadRunHistory,
    purgeTrashedThread,
    refreshMemoryEntries,
    refreshTrash,
    removeThread,
    renameThread,
    restoreTrashedThread,
    setActiveNav,
    setActiveSidebarItem,
    setActiveThreadId,
    setCanonicalThreadItems,
    setPanelMode,
    setQuery,
    setThreadRuns,
    setUiError,
    syncUrl,
  })

  const onRespondDecisionAction = useVoidCallback(handleRespondDecision)
  const onSelectTaskAction = useVoidCallback(handleSelectThread)
  const onRenameTaskAction = useVoidCallback(handleRenameThread)
  const onDeleteTaskAction = useVoidCallback(handleDeleteThread)
  const onForkMessageAction = useVoidCallback(handleForkMessage)
  const onRefreshMemoriesAction = useVoidCallback(handleRefreshMemories)
  const onRefreshTrashAction = useVoidCallback(handleRefreshTrash)
  const onRestoreThreadAction = useVoidCallback(handleRestoreThread)
  const onPurgeThreadAction = useVoidCallback(handlePurgeThread)
  const handleRunTool = useToolExecutionAction({
    abortRunSelection,
    beginRunSelection,
    sessionId: session?.id,
    threadId: currentThreadId,
    runId: run?.id,
    hydrateRunState,
    isRunSelectionCurrent,
    runTool,
    setIsToolSubmitting,
    setToolRunResult,
    setUiError,
    syncUrl,
  })
  const handleOpenWorkspace = useCallback((workspaceId: string) => {
    void openDesktopWorkspace(workspaceId).catch(error => {
      setUiError(formatUiError(error, '工作区窗口打开失败。'))
    })
  }, [openDesktopWorkspace, setUiError])

  const remoteUnavailableReason = workspaceAccess.unavailableReason
    ?? '远程服务当前不可用。地图与本地布局仍可使用。'
  const showInteractiveLogin = shouldShowDesktopLogin({
    authMode,
    authStatus,
    backendAvailability,
    hasAuthenticatedIdentity: Boolean(authMe),
  })
  const showManagedStartup = shouldShowManagedDesktopStartup({
    authMode,
    authStatus,
    backendAvailability,
    hasAuthenticatedIdentity: Boolean(authMe),
  })

  const handleSelectHistoryRun = useCallback((runId: string) => {
    const selection = beginRunSelection()
    void hydrateRunState(runId, selection).then(hydration => {
      if (hydration.status === 'superseded') return
    }).catch(error => {
      if (!isRunSelectionCurrent(selection)) return
      setUiError(formatUiError(error, '历史运行加载失败，请稍后重试。'))
    })
    setPanelMode('history')
    setActiveNav('history')
  }, [
    beginRunSelection,
    hydrateRunState,
    isRunSelectionCurrent,
    setActiveNav,
    setPanelMode,
    setUiError,
  ])

  const inspectorDetails: WorkspaceInspectorDetailsInput = {
    runStatus: run?.status,
    panelMode,
    agentState,
    items: deferredItems,
    artifacts,
    artifactData,
    mapLayers,
    layers,
    selectedArtifactId,
    onSelectArtifact: setSelectedArtifactId,
    onDownloadArtifact: () => { void handleDownloadArtifact() },
    onExportResults: handleExportResults,
    onToggleArtifactVisibility: handleToggleArtifactVisibility,
    onChangeArtifactOpacity: handleArtifactOpacityChange,
    currentRunId: run?.id,
    events: deferredEvents,
    sessionRuns,
    hasMoreHistory: hasMoreRunHistory,
    isHistoryLoading: isRunHistoryLoading,
    progressItems,
    onSelectHistoryRun: handleSelectHistoryRun,
    onLoadMoreHistory: handleLoadMoreHistory,
    allFiles,
    onUploadFile: handleUploadAnyFile,
    onDeleteFile: handleDeleteAnyFile,
    provider,
    model,
    providers,
    systemComponents,
    onProviderChange: handleProviderChange,
    onModelChange: setModel,
    isToolSubmitting,
    layerManager,
    onLayerZoomTo: handleLayerZoomTo,
    onExportLayer: handleExportLayer,
    onImportManagedLayer: handleImportManagedLayer,
    onReplaceManagedLayer: handleReplaceManagedLayer,
    onToggleReferenceLayerStatus: handleToggleLayerStatus,
    onDeleteReferenceLayer: handleDeleteLayer,
    refreshReferenceLayers: refreshLayers,
    sessionId: session?.id,
    threadId: currentThreadId,
    setPanelMode,
  }

  if (showManagedStartup) {
    return (
      <AutoAuthScreen
        isChecking={authStatus === 'checking'}
        errorMessage={authStatus === 'error' ? uiError : undefined}
        onRetry={retryAuth}
      />
    )
  }

  return (
    <Suspense fallback={<div className="dc-route-loading">正在加载页面…</div>}>
      <LazyMotion features={domAnimation}>
        <MotionConfig reducedMotion="user">
          <WorkspaceRouteHost
            settings={(
              <ModelSettingsPage
                authMode={authMode}
                canAccessAccount={workspaceAccess.canAccessAccount}
                provider={provider}
                model={model}
                providers={providers}
                onProviderChange={handleProviderChange}
                onModelChange={setModel}
                onOpenAccount={() => setActiveDesktopDocument('account')}
                canManageProviders={workspaceAccess.canManageRuntimeConfiguration}
                onProviderCatalogChanged={applyProviders}
              />
            )}
            account={authMe && workspaceAccess.canAccessAccount
              ? <AccountCenterPage authMe={authMe} onLogout={handleLogout} />
              : <WorkspaceRestrictedDocument title="账号中心" reason={remoteUnavailableReason} />}
            canAccessDiagnostics={workspaceAccess.canAccessDiagnostics}
            canAccessSecurity={workspaceAccess.canAccessSecurity}
            terms={<LegalPolicyPage kind="terms" />}
            privacy={<LegalPolicyPage kind="privacy" />}
            renderWorkspace={(Workspace, desktopDocuments) => (
              <WorkspaceShell
                Workspace={Workspace}
                desktopDocuments={desktopDocuments}
                activeDesktopDocument={activeDesktopDocument}
                onDesktopDocumentChange={setActiveDesktopDocument}
                layout={{
                  onSidebarItemClick: itemId => handleSidebarItemClick(itemId as SidebarItemId),
                  dataReferenceCount: dataReferences.length,
                  selectedBasemapName: selectedBasemap.name,
                  uploadedLayerName,
                  providerLabel,
                  modelLabel: model || '未选择',
                  modelRouteAvailable: routeUnavailableReason === null,
                  modelStatusLabel: routeUnavailableReason ?? formatModelRunStatus(run?.status),
                  artifactCount: artifacts.length,
                  selectedArtifactName: selectedArtifact?.name,
                  currentThreadId,
                  workspaceLayoutKey: session?.workspaceId
                    ?? authMe?.defaultWorkspace?.workspaceId
                    ?? 'unbound-workspace',
                  sessionThreads,
                  onNewTask: handleNewConversation,
                  onSelectThread: onSelectTaskAction,
                  workspaceMode,
                  onWorkspaceModeChange: changeWorkspaceMode,
                  onContentsModeChange: mode => {
                    layerManager.setActiveView(mode === 'sources' ? 'sources' : 'drawOrder')
                  },
                  onExportResults: handleExportResults,
                  backendActionDisabledReason: workspaceAccess.unavailableReason,
                  canAccessAccount: workspaceAccess.canAccessAccount,
                  canAccessDiagnostics: workspaceAccess.canAccessDiagnostics,
                  canAccessSecurity: workspaceAccess.canAccessSecurity,
                }}
                topBar={{
                  authMe,
                  workspaces: visibleWorkspacesQuery.data ?? [],
                  activeWorkspaceId: session?.workspaceId ?? authMe?.defaultWorkspace?.workspaceId ?? null,
                  managedLocalIdentity: authMode === 'local_auto',
                  onLogout: authMode === 'interactive' ? handleLogout : undefined,
                  unavailableReason: workspaceAccess.unavailableReason,
                  onOpenDocument: setActiveDesktopDocument,
                  onOpenWorkspace: handleOpenWorkspace,
                }}
                access={{
                  backendActionsEnabled: workspaceAccess.backendActionsEnabled,
                  unavailableReason: remoteUnavailableReason,
                  showInteractiveLogin,
                }}
                panels={{
                  tools: {
                    tools: availableTools,
                    artifacts,
                    layers,
                    valueRefs: agentState?.toolValueRefs ?? [],
                    runtimeConfig,
                    skillCatalog,
                    skillSearchResults,
                    isSkillSearching,
                    memories: memoryEntries,
                    activeSkills,
                    activeMcpServers,
                    toolRunResult,
                    toolCatalogEntries,
                    systemComponents,
                    tokenUsageSummary,
                    automationDefinitions,
                    automationDiagnostics,
                    automationValidation,
                    scheduledTasks,
                    automationRuns,
                    backgroundTasks,
                    isToolSubmitting,
                    isAutomationSubmitting,
                    isToolCatalogSubmitting,
                    isRuntimeConfigSubmitting,
                    canManageRuntimeConfiguration: workspaceAccess.canManageRuntimeConfiguration,
                    onRunTool: (tool, args) => {
                      void handleRunTool(tool, args)
                    },
                    onUpsertToolCatalogEntry: (tool, payload, sortOrder) => {
                      void handleUpsertToolCatalogEntry(tool, payload, sortOrder)
                    },
                    onDeleteToolCatalogEntry: tool => {
                      void handleDeleteToolCatalogEntry(tool)
                    },
                    onSaveRuntimeConfig: nextConfig => {
                      void handleSaveRuntimeConfig(nextConfig)
                    },
                    onSearchSkills: handleSearchSkillCatalog,
                    onStartAutomation: payload => {
                      void handleStartAutomation(payload)
                    },
                    onValidateAutomation: handleValidateAutomation,
                    onCreateAutomation: handleCreateAutomation,
                    onUpdateAutomation: handleUpdateAutomation,
                    onPublishAutomation: handlePublishAutomation,
                    onDisableAutomation: handleDisableAutomation,
                    onRespondAutomationApproval: handleRespondAutomationApproval,
                    onCancelAutomation: automationRunId => {
                      void handleCancelAutomation(automationRunId)
                    },
                    onOpenAutomationRun: (sessionId, runId, threadId) => {
                      const selection = beginRunSelection()
                      void hydrateRunState(runId, selection).then(hydration => {
                        if (hydration.status === 'superseded' || !isRunSelectionCurrent(selection)) return
                        const loadedRun = hydration.run
                        if (loadedRun.sessionId !== sessionId || (threadId && loadedRun.threadId !== threadId)) {
                          throw new Error('Automation 交付运行归属与持久化导航目标不一致。')
                        }
                        setActiveNav('analysis')
                        setPanelMode('summary')
                        setActiveSidebarItem('assistant')
                      }).catch(error => {
                        if (!isRunSelectionCurrent(selection)) return
                        setUiError(formatUiError(error, 'Automation 交付运行加载失败，请稍后重试。'))
                      })
                    },
                    onSaveScheduledTask: payload => {
                      void handleSaveScheduledTask(payload)
                    },
                    onDeleteScheduledTask: taskId => {
                      void handleDeleteScheduledTask(taskId)
                    },
                    onCancelBackgroundTask: taskId => {
                      void handleCancelBackgroundTask(taskId)
                    },
                    onPromoteBackgroundTask: taskId => {
                      void handlePromoteBackgroundTask(taskId).then(task => {
                        if (!task) return
                        const sessionId = typeof task.metadata.sessionId === 'string' ? task.metadata.sessionId : null
                        const threadId = typeof task.metadata.threadId === 'string' ? task.metadata.threadId : null
                        if (sessionId && task.runId) syncUrl(sessionId, task.runId, threadId ?? undefined)
                      })
                    },
                    onRefreshMemories: onRefreshMemoriesAction,
                  },
                  conversation: {
                    artifactCount: artifacts.length,
                    artifacts,
                    runStatus: run?.status,
                    providerLabel,
                    submissionDisabledReason: routeUnavailableReason ?? undefined,
                    query,
                    currentRunId: run?.id,
                    currentThreadId,
                    currentThreadTitle,
                    runCreatedAt: run?.createdAt,
                    isSubmitting,
                    conversationReady: Boolean(session),
                    errorMessage: uiError,
                    uploadedLayerName,
                    uploadReferences,
                    decisions: agentState?.decisions ?? [],
                    sessionThreads,
                    items: threadConversationItems,
                    runtimeConfig,
                    availableTools,
                    onQueryChange: setQuery,
                    onSubmit: handleSubmit,
                    onInterrupt: handleInterruptRun,
                    onNewConversation: handleNewConversation,
                    onFillSample: handleSampleSelect,
                    onRespondDecision: onRespondDecisionAction,
                    onUseTemplate: handleUseTemplate,
                    onUploadFiles: files => {
                      void handleUploadFiles(files)
                    },
                    onAttachImage: handleUploadComposerAttachment,
                    onSelectArtifact: handleSelectConversationArtifact,
                    onSelectTask: onSelectTaskAction,
                    onRenameTask: onRenameTaskAction,
                    onDeleteTask: onDeleteTaskAction,
                    onForkMessage: onForkMessageAction,
                    onOpenWorkflow: openWorkflowInspector,
                    dataReferences,
                    trashedThreads,
                    onLoadTrash: onRefreshTrashAction,
                    onRestoreThread: onRestoreThreadAction,
                    onPurgeThread: onPurgeThreadAction,
                    tokenBudget,
                    activeSkills,
                    activeMcpServers,
                    compactionLevel,
                    runStats,
                    threadUsage: threadUsageQuery.data?.totals,
                    threadUsageLoading: threadUsageQuery.isFetching,
                    threadUsageUnavailable: threadUsageQuery.isError,
                    denialCounts,
                    goal: agentState?.goal ?? null,
                    agentWorkflow,
                    tasks: progressTasks,
                  },
                  map: {
                    artifactCount: artifacts.length,
                    basemaps,
                    mapScene,
                    isMapActivated,
                    runStatus: run?.status,
                    selectedBasemapKey,
                    selectedArtifactId,
                    selectedArtifactName: selectedArtifact?.name,
                    focusRequest: mapFocusRequest,
                    onSelectArtifact: setSelectedArtifactId,
                    placeResolution,
                    agentState,
                    onActivateMap: activateMap,
                  },
                  workflow: {
                    agentState,
                    runId: run?.id,
                    onGetSubAgent: handleGetSubAgent,
                    onFollowUpSubAgent: handleFollowUpSubAgent,
                    onCancelSubAgent: handleCancelSubAgent,
                  },
                  inspector: {
                    details: inspectorDetails,
                    progress: {
                      runStatus: run?.status,
                      progressItems,
                      tasks: progressTasks,
                      events: deferredEvents,
                      artifactCount: artifacts.length,
                      onOpenHistory: () => setPanelMode('history'),
                    },
                    basemapName: selectedBasemap.name,
                  },
                }}
                exportWizard={exportWizardOpen ? {
                  open: true,
                  title: currentThreadTitle || `${productName} 分析成果`,
                  artifacts,
                  defaultArtifactId: selectedArtifact?.artifactId ?? artifacts.at(-1)?.artifactId,
                  busy: exportBusy,
                } : null}
                onCloseExportWizard={closeExportWizard}
                onConfirmExport={handleConfirmExport}
                onAuthenticated={retryAuth}
              />
            )}
            renderDebug={(Debug) => (
              <Debug
                query={query}
                isSubmitting={isSubmitting}
                isToolSubmitting={isToolSubmitting}
                uploadedLayerName={uploadedLayerName}
                errorMessage={uiError}
                runStatus={run?.status}
                currentRunId={run?.id}
                currentSessionId={session?.id}
                provider={provider}
                model={model}
                providers={providers}
                currentRun={run}
                sessionRuns={sessionRuns}
                layers={layers}
                events={deferredEvents}
                items={deferredItems}
                intent={intent}
                agentWorkflow={agentWorkflow}
                agentState={agentState}
                artifacts={artifacts}
                artifactMetadata={artifactMetadata}
                selectedArtifactId={selectedArtifactId}
                toolRunResult={toolRunResult}
                toolCatalogEntries={toolCatalogEntries}
                runtimeConfig={runtimeConfig}
                systemComponents={systemComponents}
                tools={availableTools}
                isToolCatalogSubmitting={isToolCatalogSubmitting}
                onQueryChange={setQuery}
                onProviderChange={handleProviderChange}
                onModelChange={setModel}
                onSubmit={() => {
                  void handleSubmit()
                }}
                onUpload={(file) => {
                  void handleUploadFiles([file])
                }}
                onSelectArtifact={setSelectedArtifactId}
                onRunTool={(tool, args) => {
                  void handleRunTool(tool, args)
                }}
                onUpsertToolCatalogEntry={(tool, payload, sortOrder) => {
                  void handleUpsertToolCatalogEntry(tool, payload, sortOrder)
                }}
                onDeleteToolCatalogEntry={(tool) => {
                  void handleDeleteToolCatalogEntry(tool)
                }}
                onSaveRuntimeConfig={(nextConfig) => {
                  void handleSaveRuntimeConfig(nextConfig)
                }}
              />
            )}
          />
          <ServiceConfigurationOnboarding
            providers={providers}
            canManageProviders={workspaceAccess.canManageRuntimeConfiguration}
            onSaved={async result => {
              const nextProviders = await listProviders()
              applyProviders(nextProviders)
              handleProviderChange(result.provider.providerId)
              setModel(result.provider.defaultModel)
            }}
          />
        </MotionConfig>
      </LazyMotion>
    </Suspense>
  )
}

export default AppShell

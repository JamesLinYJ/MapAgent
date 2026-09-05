// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具与运行时配置控制器
//
//   文件:       toolingController.ts
//
//   日期:       2026年06月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { startTransition, useCallback, useEffect, useState } from 'react'
import type {
  AgentRuntimeConfig,
  BackgroundTaskInfo,
  ScheduledTask,
  SkillCatalogSnapshot,
  SkillMatchResult,
  RuntimeConfigDocument,
  SystemComponentsStatus,
  TokenUsageSummary,
  ToolDescriptor,
  AutomationDefinition,
  AutomationRunRecord,
  AutomationValidationResult,
} from '@geo-agent-platform/shared-types'
import {
  cancelBackgroundTask,
  cancelAutomation,
  createAutomation,
  createScheduledTask,
  type ScheduledTaskCreatePayload,
  type ScheduledTaskUpdatePayload,
  deleteToolCatalogEntry,
  getRuntimeConfig,
  getTokenUsageSummary,
  listBackgroundTasks,
  listScheduledTasks,
  listSkills,
  listToolCatalogEntries,
  listTools,
  listAutomations,
  promoteBackgroundTask,
  runTool,
  searchSkills,
  startAutomation,
  type StartAutomationPayload,
  updateScheduledTask,
  updateRuntimeConfig,
  upsertToolCatalogEntry,
  deleteScheduledTask,
  disableAutomation,
  publishAutomation,
  respondAutomationApproval,
  updateAutomation,
  validateAutomation,
  type AutomationDraftPayload,
  type AutomationUpdatePayload,
} from '../../api/client'
import { PlatformTransportError } from '../../api/errors'
import { getSystemComponents } from '../../api/client'
import { formatUiError } from '../bootstrap'
import { useAuthStore } from '../stores/authStore'

interface ToolingControllerOptions {
  loadDiagnostics: boolean
  setUiError: (error?: string) => void
}

export function shouldLoadToolingDiagnostics(pathname: string, panelMode: string): boolean {
  return pathname === '/debug'
    || panelMode === 'compute'
    || panelMode === 'config'
    || panelMode === 'tools'
}

// 工具控制器持有工具目录、运行时配置和调试状态。
//
// 各事实源独立吸收，单个持久化组件失败不会清空已经成功加载的工具描述。
export function useToolingController({ loadDiagnostics, setUiError }: ToolingControllerOptions) {
  const enabled = useAuthStore(state => state.status === 'authenticated')
  const [availableTools, setAvailableTools] = useState<ToolDescriptor[]>([])
  const [toolCatalogEntries, setToolCatalogEntries] = useState<Array<Record<string, unknown>>>([])
  const [automationDefinitions, setAutomationDefinitions] = useState<AutomationDefinition[]>([])
  const [automationDiagnostics, setAutomationDiagnostics] = useState<Array<Record<string, unknown>>>([])
  const [automationValidation, setAutomationValidation] = useState<Record<string, AutomationValidationResult>>({})
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([])
  const [automationRuns, setAutomationRuns] = useState<AutomationRunRecord[]>([])
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskInfo[]>([])
  const [tokenUsageSummary, setTokenUsageSummary] = useState<TokenUsageSummary>()
  const [runtimeConfigDocument, setRuntimeConfigDocument] = useState<RuntimeConfigDocument>()
  const runtimeConfig = runtimeConfigDocument?.config
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogSnapshot>()
  const [skillSearchResults, setSkillSearchResults] = useState<SkillMatchResult[]>([])
  const [systemComponents, setSystemComponents] = useState<SystemComponentsStatus>()
  const [toolRunResult, setToolRunResult] = useState<Record<string, unknown> | null>(null)
  const [isToolSubmitting, setIsToolSubmitting] = useState(false)
  const [isAutomationSubmitting, setIsAutomationSubmitting] = useState(false)
  const [isToolCatalogSubmitting, setIsToolCatalogSubmitting] = useState(false)
  const [isRuntimeConfigSubmitting, setIsRuntimeConfigSubmitting] = useState(false)
  const [isSkillSearching, setIsSkillSearching] = useState(false)

  const refreshAutomationState = useCallback(async () => {
    const [automations, scheduled, background] = await Promise.all([
      listAutomations(),
      listScheduledTasks(),
      listBackgroundTasks(),
    ])
    setAutomationDefinitions(automations.definitions)
    setAutomationDiagnostics(automations.diagnostics)
    setAutomationValidation(automations.validation)
    setScheduledTasks(scheduled.tasks)
    setAutomationRuns(scheduled.automationRuns)
    setBackgroundTasks(background.tasks)
  }, [])

  const refreshToolDescriptors = useCallback(async () => {
    setAvailableTools(await listTools())
  }, [])

  const applyToolDescriptors = useCallback((tools: ToolDescriptor[]) => {
    startTransition(() => setAvailableTools(tools))
  }, [])

  const refresh = useCallback(async () => {
    const [components, catalogEntries, loadedRuntimeConfig, loadedSkills, automations, scheduled, background, usage] = await Promise.allSettled([
      getSystemComponents(),
      listToolCatalogEntries(),
      getRuntimeConfig(),
      listSkills(),
      listAutomations(),
      listScheduledTasks(),
      listBackgroundTasks(),
      getTokenUsageSummary(),
    ])
    startTransition(() => {
      if (components.status === 'fulfilled') setSystemComponents(components.value)
      if (catalogEntries.status === 'fulfilled') setToolCatalogEntries(catalogEntries.value ?? [])
      if (loadedRuntimeConfig.status === 'fulfilled') setRuntimeConfigDocument(loadedRuntimeConfig.value)
      if (loadedSkills.status === 'fulfilled') setSkillCatalog(loadedSkills.value)
      if (automations.status === 'fulfilled') {
        setAutomationDefinitions(automations.value.definitions)
        setAutomationDiagnostics(automations.value.diagnostics)
        setAutomationValidation(automations.value.validation)
      }
      if (scheduled.status === 'fulfilled') {
        setScheduledTasks(scheduled.value.tasks)
        setAutomationRuns(scheduled.value.automationRuns)
      }
      if (background.status === 'fulfilled') setBackgroundTasks(background.value.tasks)
      if (usage.status === 'fulfilled') setTokenUsageSummary(usage.value)
    })
    const rejected = [components, catalogEntries, loadedRuntimeConfig, loadedSkills, automations, scheduled, background, usage].find(result => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
  }, [])

  useEffect(() => {
    // 配置、Automation 和系统状态只在对应控制面可见时加载，不能占用首页关键路径。
    if (!enabled || !loadDiagnostics) return
    void refresh().catch(error => setUiError(formatUiError(error, '部分系统状态加载失败。')))
  }, [enabled, loadDiagnostics, refresh, setUiError])

  useEffect(() => {
    if (!enabled || !loadDiagnostics) return
    const timer = window.setInterval(() => {
      void refreshAutomationState().catch(error => setUiError(formatUiError(error, '自动化流程状态刷新失败。')))
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [enabled, loadDiagnostics, refreshAutomationState, setUiError])

  const saveRuntimeConfig = useCallback(async (nextConfig: AgentRuntimeConfig) => {
    const expectedRevision = runtimeConfigDocument?.revision
    if (expectedRevision === undefined) {
      setUiError('运行时配置尚未加载完成，请稍后再保存。')
      return
    }
    try {
      setUiError(undefined)
      setIsRuntimeConfigSubmitting(true)
      const saved = await updateRuntimeConfig(nextConfig, expectedRevision)
      setRuntimeConfigDocument(saved)
      setSkillCatalog(await listSkills())
    } catch (error) {
      setUiError(error instanceof PlatformTransportError && error.code === 'version_conflict'
        ? '运行时配置已在另一个窗口更新，当前草稿已保留。请重新打开配置后合并修改。'
        : formatUiError(error, '运行时配置保存失败。'))
    } finally {
      setIsRuntimeConfigSubmitting(false)
    }
  }, [runtimeConfigDocument?.revision, setUiError])

  const searchSkillCatalog = useCallback(async (query: string) => {
    const normalized = query.trim()
    if (!normalized) {
      setSkillSearchResults([])
      return []
    }
    try {
      setUiError(undefined)
      setIsSkillSearching(true)
      const response = await searchSkills(normalized)
      setSkillSearchResults(response.matches)
      return response.matches
    } catch (error) {
      setUiError(formatUiError(error, 'Skill 搜索失败。'))
      return []
    } finally {
      setIsSkillSearching(false)
    }
  }, [setUiError])

  const saveCatalogEntry = useCallback(async (
    tool: ToolDescriptor,
    payload: Record<string, unknown>,
    sortOrder?: number,
  ) => {
    try {
      setUiError(undefined)
      setIsToolCatalogSubmitting(true)
      await upsertToolCatalogEntry(tool.toolKind, tool.name, payload, sortOrder)
      await Promise.all([refresh(), refreshToolDescriptors()])
    } catch (error) {
      setUiError(formatUiError(error, `${tool.label} 目录配置保存失败。`))
    } finally {
      setIsToolCatalogSubmitting(false)
    }
  }, [refresh, refreshToolDescriptors, setUiError])

  const removeCatalogEntry = useCallback(async (tool: ToolDescriptor) => {
    try {
      setUiError(undefined)
      setIsToolCatalogSubmitting(true)
      await deleteToolCatalogEntry(tool.toolKind, tool.name)
      await Promise.all([refresh(), refreshToolDescriptors()])
    } catch (error) {
      setUiError(formatUiError(error, `${tool.label} 目录配置删除失败。`))
    } finally {
      setIsToolCatalogSubmitting(false)
    }
  }, [refresh, refreshToolDescriptors, setUiError])

  const runAutomation = useCallback(async (payload: StartAutomationPayload) => {
    try {
      setUiError(undefined)
      setIsAutomationSubmitting(true)
      await startAutomation(payload)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, '自动化流程启动失败。'))
    } finally {
      setIsAutomationSubmitting(false)
    }
  }, [refresh, setUiError])

  const stopAutomation = useCallback(async (automationRunId: string) => {
    try {
      setUiError(undefined)
      setIsAutomationSubmitting(true)
      await cancelAutomation(automationRunId)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, '自动化流程取消失败。'))
    } finally {
      setIsAutomationSubmitting(false)
    }
  }, [refresh, setUiError])

  const validateAutomationDraft = useCallback(async (payload: AutomationDraftPayload) => {
    setUiError(undefined)
    return validateAutomation(payload)
  }, [setUiError])

  const createAutomationDraft = useCallback(async (payload: AutomationDraftPayload) => {
    try {
      setUiError(undefined)
      setIsAutomationSubmitting(true)
      const definition = await createAutomation(payload)
      await refresh()
      return definition
    } catch (error) {
      setUiError(formatUiError(error, '自动化流程草稿创建失败。'))
      throw error
    } finally {
      setIsAutomationSubmitting(false)
    }
  }, [refresh, setUiError])

  const updateAutomationDraft = useCallback(async (payload: AutomationUpdatePayload) => {
    try {
      setUiError(undefined)
      setIsAutomationSubmitting(true)
      const definition = await updateAutomation(payload)
      await refresh()
      return definition
    } catch (error) {
      setUiError(formatUiError(error, '自动化流程草稿保存失败。'))
      throw error
    } finally {
      setIsAutomationSubmitting(false)
    }
  }, [refresh, setUiError])

  const publishAutomationDraft = useCallback(async (automationId: string, revision: number) => {
    try {
      setUiError(undefined)
      setIsAutomationSubmitting(true)
      await publishAutomation(automationId, revision)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, '自动化流程发布失败。'))
      throw error
    } finally {
      setIsAutomationSubmitting(false)
    }
  }, [refresh, setUiError])

  const disableAutomationDefinition = useCallback(async (automationId: string) => {
    try {
      setUiError(undefined)
      setIsAutomationSubmitting(true)
      await disableAutomation(automationId)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, '自动化流程停用失败。'))
      throw error
    } finally {
      setIsAutomationSubmitting(false)
    }
  }, [refresh, setUiError])

  const respondToAutomationApproval = useCallback(async (
    automationRunId: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
  ) => {
    try {
      setUiError(undefined)
      setIsAutomationSubmitting(true)
      await respondAutomationApproval(automationRunId, approvalId, decision)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, '自动化流程审批响应失败。'))
      throw error
    } finally {
      setIsAutomationSubmitting(false)
    }
  }, [refresh, setUiError])

  const saveScheduledTask = useCallback(async (payload: ScheduledTaskCreatePayload | ScheduledTaskUpdatePayload) => {
    try {
      setUiError(undefined)
      setIsAutomationSubmitting(true)
      if ('taskId' in payload) {
        await updateScheduledTask(payload)
      } else {
        await createScheduledTask(payload)
      }
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, '定时任务保存失败。'))
    } finally {
      setIsAutomationSubmitting(false)
    }
  }, [refresh, setUiError])

  const removeScheduledTask = useCallback(async (taskId: string) => {
    try {
      setUiError(undefined)
      setIsAutomationSubmitting(true)
      await deleteScheduledTask(taskId)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, '定时任务删除失败。'))
    } finally {
      setIsAutomationSubmitting(false)
    }
  }, [refresh, setUiError])

  const stopBackgroundTask = useCallback(async (taskId: string) => {
    try {
      setUiError(undefined)
      setIsAutomationSubmitting(true)
      await cancelBackgroundTask(taskId)
      await refresh()
    } catch (error) {
      setUiError(formatUiError(error, '后台任务取消失败。'))
    } finally {
      setIsAutomationSubmitting(false)
    }
  }, [refresh, setUiError])

  const promoteTask = useCallback(async (taskId: string) => {
    try {
      setUiError(undefined)
      const task = await promoteBackgroundTask(taskId)
      await refresh()
      return task
    } catch (error) {
      setUiError(formatUiError(error, '后台任务定位失败。'))
    }
  }, [refresh, setUiError])

  return {
    applyToolDescriptors,
    availableTools,
    backgroundTasks,
    isToolCatalogSubmitting,
    isRuntimeConfigSubmitting,
    isSkillSearching,
    isToolSubmitting,
    isAutomationSubmitting,
    removeCatalogEntry,
    removeScheduledTask,
    runtimeConfig,
    skillCatalog,
    skillSearchResults,
    searchSkillCatalog,
    runTool,
    runAutomation,
    saveCatalogEntry,
    saveRuntimeConfig,
    saveScheduledTask,
    setIsToolSubmitting,
    setToolRunResult,
    stopBackgroundTask,
    stopAutomation,
    promoteTask,
    systemComponents,
    scheduledTasks,
    toolCatalogEntries,
    toolRunResult,
    tokenUsageSummary,
    automationDefinitions,
    automationDiagnostics,
    automationValidation,
    automationRuns,
    validateAutomationDraft,
    createAutomationDraft,
    updateAutomationDraft,
    publishAutomationDraft,
    disableAutomationDefinition,
    respondToAutomationApproval,
  }
}

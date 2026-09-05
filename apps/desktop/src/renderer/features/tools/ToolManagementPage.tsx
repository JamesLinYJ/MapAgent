// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工具管理页面
//
//   文件:       ToolManagementPage.tsx
//
//   日期:       2026年06月17日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 面向主工作台展示工具目录、Provider 可用性、参数 schema、目录 override
// 与试运行入口。页面只消费 WebSocket 控制器传入的服务端状态，不直接发请求。

import { useMemo, useState } from 'react'
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Box,
  CloudSun,
  Code2,
  DatabaseZap,
  Search,
  ShieldCheck,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type {
  AgentRuntimeConfig,
  ArtifactRef,
  BackgroundTaskInfo,
  LayerDescriptor,
  ScheduledTask,
  SkillCatalogSnapshot,
  SkillMatchResult,
  SystemComponentsStatus,
  ToolDescriptor,
  ToolValueRef,
  TokenUsageSummary,
  AutomationDefinition,
  AutomationRunRecord,
  AutomationValidationResult,
} from '@geo-agent-platform/shared-types'

import { StatusPill } from '../../shared/components/StatusPill'
import {
  ToolCatalogEditor,
  ToolParameterForm,
  ToolRunControls,
} from './toolForm'
import {
  buildToolFormState,
  resolveToolDefaults,
} from './toolFormState'
import { ToolMiniAppPanel } from './ToolMiniApp'
import { isRecord } from '../../shared/utils/guards'
import type { MemoryEntry } from '../memory/types'
import { SdkExtensionManagement, type SdkManagementView } from './SdkExtensionManagement'
import type {
  ScheduledTaskCreatePayload,
  ScheduledTaskUpdatePayload,
  StartAutomationPayload,
  AutomationDraftPayload,
  AutomationUpdatePayload,
} from '../../api/client'
import { requireDesktopBridge } from '../../api/transport'
import { AutomationManagementPanel } from './AutomationManagementPanel'
import { UsageManagementPanel } from './UsageManagementPanel'
import {
  filterTools,
  findToolCatalogEntry,
  groupToolsForManagement,
  providerLabel,
  summarizeTools,
} from './toolManagementModel'

export interface ToolManagementPageProps {
  tools: ToolDescriptor[]
  artifacts: ArtifactRef[]
  layers: LayerDescriptor[]
  valueRefs: ToolValueRef[]
  runtimeConfig?: AgentRuntimeConfig
  skillCatalog?: SkillCatalogSnapshot
  skillSearchResults?: SkillMatchResult[]
  memories?: MemoryEntry[]
  activeSkills?: string[]
  activeMcpServers?: string[]
  toolRunResult?: Record<string, unknown> | null
  toolCatalogEntries: Array<Record<string, unknown>>
  systemComponents?: SystemComponentsStatus
  tokenUsageSummary?: TokenUsageSummary
  automationDefinitions: AutomationDefinition[]
  automationDiagnostics: Array<Record<string, unknown>>
  automationValidation: Record<string, AutomationValidationResult>
  scheduledTasks: ScheduledTask[]
  automationRuns: AutomationRunRecord[]
  backgroundTasks: BackgroundTaskInfo[]
  isToolSubmitting: boolean
  isAutomationSubmitting: boolean
  isToolCatalogSubmitting?: boolean
  isRuntimeConfigSubmitting?: boolean
  isSkillSearching?: boolean
  canManageRuntimeConfiguration?: boolean
  onRunTool: (tool: ToolDescriptor, args: Record<string, unknown>) => void
  onUpsertToolCatalogEntry: (tool: ToolDescriptor, payload: Record<string, unknown>, sortOrder?: number) => void
  onDeleteToolCatalogEntry: (tool: ToolDescriptor) => void
  onSaveRuntimeConfig?: (config: AgentRuntimeConfig) => void | Promise<void>
  onSearchSkills?: (query: string) => Promise<SkillMatchResult[]>
  onStartAutomation: (payload: StartAutomationPayload) => void
  onValidateAutomation: (payload: AutomationDraftPayload) => Promise<AutomationValidationResult>
  onCreateAutomation: (payload: AutomationDraftPayload) => Promise<AutomationDefinition>
  onUpdateAutomation: (payload: AutomationUpdatePayload) => Promise<AutomationDefinition>
  onPublishAutomation: (automationId: string, revision: number) => Promise<void>
  onDisableAutomation: (automationId: string) => Promise<void>
  onRespondAutomationApproval: (automationRunId: string, approvalId: string, decision: 'approved' | 'rejected') => Promise<void>
  onCancelAutomation: (automationRunId: string) => void
  onOpenAutomationRun: (sessionId: string, runId: string, threadId?: string) => void
  onSaveScheduledTask: (payload: ScheduledTaskCreatePayload | ScheduledTaskUpdatePayload) => void
  onDeleteScheduledTask: (taskId: string) => void
  onCancelBackgroundTask: (taskId: string) => void
  onPromoteBackgroundTask: (taskId: string) => void
  onRefreshMemories?: () => void
}

type AutomationManagementView = 'automations' | 'scheduled' | 'background'
type UsageManagementView = 'usage'
type ToolManagementView = 'tools' | SdkManagementView | AutomationManagementView | UsageManagementView

export function ToolManagementPage({
  tools,
  artifacts,
  layers,
  valueRefs,
  runtimeConfig,
  skillCatalog,
  skillSearchResults = [],
  memories = [],
  activeSkills = [],
  activeMcpServers = [],
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
  isSkillSearching,
  canManageRuntimeConfiguration = false,
  onRunTool,
  onUpsertToolCatalogEntry,
  onDeleteToolCatalogEntry,
  onSaveRuntimeConfig,
  onSearchSkills,
  onStartAutomation,
  onValidateAutomation,
  onCreateAutomation,
  onUpdateAutomation,
  onPublishAutomation,
  onDisableAutomation,
  onRespondAutomationApproval,
  onCancelAutomation,
  onOpenAutomationRun,
  onSaveScheduledTask,
  onDeleteScheduledTask,
  onCancelBackgroundTask,
  onPromoteBackgroundTask,
  onRefreshMemories,
}: ToolManagementPageProps) {
  const [activeView, setActiveView] = useState<ToolManagementView>('tools')
  const [query, setQuery] = useState('')
  const [selectedToolName, setSelectedToolName] = useState('')
  const [toolFormsByName, setToolFormsByName] = useState<Record<string, Record<string, string>>>({})
  const filteredTools = useMemo(() => filterTools(tools, query), [query, tools])
  const groupedTools = useMemo(() => groupToolsForManagement(filteredTools), [filteredTools])
  const summary = useMemo(() => summarizeTools(tools, systemComponents), [systemComponents, tools])
  const selectedTool =
    tools.find((tool) => tool.name === selectedToolName) ??
    filteredTools.find((tool) => tool.available) ??
    filteredTools[0] ??
    tools[0]
  const selectedToolCatalogEntry = findToolCatalogEntry(toolCatalogEntries, selectedTool)
  const toolFormValues = selectedTool ? toolFormsByName[selectedTool.name] ?? resolveToolDefaults(selectedTool) : {}
  const formState = selectedTool
    ? buildToolFormState(selectedTool, toolFormValues)
    : { values: {}, missing: [], parsed: { args: {}, error: null } }
  const schemaPreview = selectedTool ? buildSchemaPreview(selectedTool) : null
  const providers = systemComponents?.toolProviders ?? []
  const mcpServerCount = runtimeConfig?.sdk.mcp.servers.length ?? 0
  const skillCount = skillCatalog?.entries.length ?? 0
  const viewTabs: Array<{ id: ToolManagementView; label: string; count: number; description: string }> = [
    { id: 'tools', label: '内置工具', count: tools.length, description: 'Provider 工具与目录治理' },
    { id: 'automations', label: '自动化流程编排', count: automationDefinitions.length, description: '可视化工具流、版本与运行审批' },
    { id: 'scheduled', label: '定时任务', count: scheduledTasks.length, description: '定时唤醒与周期执行' },
    { id: 'background', label: '后台任务', count: backgroundTasks.length, description: '运行中任务观察' },
    { id: 'usage', label: '用量统计', count: tokenUsageSummary?.totals.runsWithUsage ?? 0, description: '输入 / 输出 / 缓存' },
    { id: 'mcp', label: 'MCP', count: mcpServerCount, description: '外部 MCP Server' },
    { id: 'skills', label: 'Skill', count: skillCount, description: 'SDK Skill 目录' },
    { id: 'memory', label: '记忆', count: memories.length, description: '长期与会话记忆' },
  ]

  return (
    <section className="tool-management ui-page">
      <section className="tool-management__hero ui-page-header">
        <div className="tool-management__hero-copy">
          <div className="tool-management__hero-icon">
            <Sparkles size={20} aria-hidden="true" />
          </div>
          <div>
            <div className="panel__eyebrow">智能体工具注册表</div>
            <h1>工具与能力中心</h1>
            <p>
              管理 Agent 可调用的空间分析、气象计算与产品生成能力，并在同一工作区完成参数配置、运行验证和目录治理。
            </p>
          </div>
        </div>
        <div className="tool-management__top-actions">
          <label className="tool-management__search tool-management__search--hero">
            <Search size={15} aria-hidden="true" />
            <input
              value={query}
              placeholder="搜索工具或能力"
              aria-label="搜索工具或能力"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="tool-doc-grid">
            <DocShortcut icon={BookOpen} title="工具接入规范" pathValue="docs/standards/tool-integration-standard.md" />
            <DocShortcut icon={Code2} title="Provider Demo" pathValue="demo/tool-provider-demo" />
          </div>
        </div>
      </section>

      <div className="tool-management__tabs" role="tablist" aria-label="能力管理视图">
        {viewTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeView === tab.id}
            className={activeView === tab.id ? 'tool-management-tab tool-management-tab--active' : 'tool-management-tab'}
            onClick={() => setActiveView(tab.id)}
          >
            <span>{tab.label}</span>
            <strong>{tab.count}</strong>
            <small>{tab.description}</small>
          </button>
        ))}
      </div>

      <div className="tool-management__overview">
        <OverviewCard icon={Wrench} label="工具总数" value={String(summary.total)} hint={`${summary.available} 个可用`} />
        <OverviewCard icon={ShieldCheck} label="只读工具" value={String(summary.readOnly)} hint="默认无需审批" />
        <OverviewCard icon={DatabaseZap} label="需谨慎工具" value={String(summary.destructive)} hint="破坏性操作会标识风险" />
        <OverviewCard icon={Box} label="Provider" value={String(summary.providers)} hint={`${summary.unavailableProviders} 个不可用`} />
      </div>

      {activeView === 'tools' ? (
        <div className="tool-management__grid">
        <aside className="tool-management__sidebar ui-card">
          <div className="tool-management__sidebar-header">
            <div>
              <div className="panel__eyebrow">目录</div>
              <h2>能力目录</h2>
            </div>
            <span className="tool-management__count">{filteredTools.length}</span>
          </div>
          <div className="tool-management__search-wrap">
            <label className="tool-management__search">
              <Search size={15} aria-hidden="true" />
              <input
                value={query}
                placeholder="搜索工具、标签或 Provider"
                aria-label="搜索工具"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          <div className="tool-management__catalog">
            {groupedTools.length ? groupedTools.map((group) => (
              <div className="tool-management__group" key={group.key}>
                <div className="tool-management__group-title">
                  <span>{group.label}</span>
                  <small>{group.availableCount}/{group.tools.length}</small>
                </div>
                {group.tools.map((tool) => (
                  <button
                    key={`${tool.toolKind}:${tool.name}`}
                    type="button"
                    className={selectedTool?.name === tool.name ? 'tool-card tool-card--active' : 'tool-card'}
                    onClick={() => setSelectedToolName(tool.name)}
                  >
                    <span className="tool-card__icon">
                      {tool.group === '气象' || tool.tags.some((tag) => tag.includes('meteorology') || tag.includes('气象'))
                        ? <CloudSun size={15} aria-hidden="true" />
                        : <Wrench size={15} aria-hidden="true" />}
                    </span>
                    <span className="tool-card__body">
                      <span className="tool-card__title">{tool.label}</span>
                      <span className="tool-card__meta">{providerLabel(tool)}</span>
                    </span>
                    <span className={tool.available ? 'tool-card__status tool-card__status--ready' : 'tool-card__status'} />
                  </button>
                ))}
              </div>
            )) : (
              <div className="panel__empty">没有匹配的工具。</div>
            )}
          </div>
        </aside>

        <main className="tool-management__detail">
          <section className="panel ui-page-section">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">服务状态</div>
                <h2>能力服务状态</h2>
              </div>
              <StatusPill label={providers.length ? `${providers.length} 个服务` : '等待系统状态'} tone="accent" />
            </div>
            <div className="panel__section">
              <div className="tool-provider-list">
                {providers.length ? providers.map((provider) => (
                  <article className="tool-provider-row" key={provider.providerId}>
                    <div>
                      <strong>{provider.name}</strong>
                      <p>
                        {provider.providerId} · {provider.language ?? 'unknown'} · {provider.toolCount} tools
                      </p>
                    </div>
                    <div className="tool-provider-row__meta">
                      <span className={provider.available ? 'dc-pill-meta badge-green' : 'dc-pill-meta badge-red'}>
                        {provider.available ? '可用' : '不可用'}
                      </span>
                      <span className="dc-pill-meta">{provider.version ?? 'no-version'}</span>
                      <span className="dc-pill-meta">{provider.author ?? 'unknown-author'}</span>
                    </div>
                    {provider.error ? <p className="tool-provider-row__error">{provider.error}</p> : null}
                  </article>
                )) : (
                  <div className="panel__empty">系统状态尚未返回 Provider 信息。</div>
                )}
              </div>
            </div>
          </section>

          <section className="panel tool-management__primary-panel ui-page-section">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">工具详情</div>
                <h2>{selectedTool?.label ?? '未选择工具'}</h2>
              </div>
              {selectedTool ? (
                <div className="tool-management__risk">
                  <span className={selectedTool.available ? 'dc-pill-meta badge-green' : 'dc-pill-meta badge-red'}>
                    {selectedTool.available ? '可运行' : '不可运行'}
                  </span>
                  <span className="dc-pill-meta">{selectedTool.isReadOnly ? '只读' : '写操作'}</span>
                  {selectedTool.isDestructive ? <span className="dc-pill-meta badge-amber">破坏性</span> : null}
                </div>
              ) : null}
            </div>
            {selectedTool ? (
              <>
                <div className="panel__section">
                  <div className="tool-management__description">
                    <p>{selectedTool.description}</p>
                    <div className="tool-management__tag-row">
                      <span className="dc-pill-meta">{selectedTool.toolKind}</span>
                      <span className="dc-pill-meta">{providerLabel(selectedTool)}</span>
                      <span className="dc-pill-meta">{selectedTool.group}</span>
                      {selectedTool.tags.map((tag) => (
                        <span key={tag} className="dc-pill-meta">{tag}</span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="panel__section">
                  <div className="tool-schema-grid">
                    <div>
                      <div className="panel__subheader">
                        <span>参数表单</span>
                        <span className="panel__muted">{selectedTool.parameters.length} 个参数</span>
                      </div>
                      <ToolMiniAppPanel
                        tool={selectedTool}
                        formState={formState}
                        valueRefs={valueRefs}
                        isSubmitting={isToolSubmitting}
                        onRunTool={onRunTool}
                      />
                      <ToolParameterForm
                        tool={selectedTool}
                        values={formState.values}
                        artifacts={artifacts}
                        layers={layers}
                        valueRefs={valueRefs}
                        onValuesChange={setToolFormsByName}
                      />
                      <ToolRunControls
                        tool={selectedTool}
                        formState={formState}
                        isSubmitting={isToolSubmitting}
                        onRunTool={onRunTool}
                      />
                    </div>
                    <div className="tool-management__schema-column">
                      <div className="panel__subheader">
                        <span>参数 schema</span>
                        <span className="panel__muted">只读预览</span>
                      </div>
                      <pre className="debug-pre">{JSON.stringify(schemaPreview, null, 2)}</pre>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="panel__section">
                <div className="panel__empty">当前还没有工具 descriptor。</div>
              </div>
            )}
          </section>

          {selectedTool ? (
            <section className="panel ui-page-section">
              <div className="panel__header">
                <div>
                  <div className="panel__eyebrow">目录展示配置</div>
                  <h2>目录展示配置</h2>
                </div>
                <StatusPill
                  label={selectedToolCatalogEntry ? '已有覆盖配置' : '使用默认说明'}
                  tone={selectedToolCatalogEntry ? 'success' : 'accent'}
                />
              </div>
              <div className="panel__section">
                {canManageRuntimeConfiguration ? (
                  <StatefulToolCatalogEditor
                    key={`${selectedTool.toolKind}:${selectedTool.name}:${selectedToolCatalogEntry?.sortOrder ?? 'new'}`}
                    tool={selectedTool}
                    entry={selectedToolCatalogEntry}
                    isSubmitting={Boolean(isToolCatalogSubmitting)}
                    onSave={onUpsertToolCatalogEntry}
                    onDelete={onDeleteToolCatalogEntry}
                  />
                ) : (
                  <p className="panel__muted">
                    当前身份可以查看目录配置；修改配置需要平台管理员或本机托管工作台权限。
                  </p>
                )}
                <p className="panel__muted">
                  覆盖配置只改变目录展示、排序和管理元数据；工具处理器、参数结构和审批边界仍来自仓库内服务实现。
                </p>
              </div>
            </section>
          ) : null}

          <section className="panel ui-page-section">
            <div className="panel__header">
              <div>
                <div className="panel__eyebrow">试运行</div>
                <h2>最近试运行结果</h2>
              </div>
              <Activity size={16} aria-hidden="true" />
            </div>
            <div className="panel__section">
              <pre className="debug-pre">{toolRunResult ? JSON.stringify(toolRunResult, null, 2) : '暂无工具运行结果。'}</pre>
            </div>
          </section>
        </main>
        </div>
      ) : activeView === 'automations' || activeView === 'scheduled' || activeView === 'background' ? (
        <AutomationManagementPanel
          view={activeView}
          tools={tools}
          automations={automationDefinitions}
          automationDiagnostics={automationDiagnostics}
          automationValidation={automationValidation}
          scheduledTasks={scheduledTasks}
          automationRuns={automationRuns}
          backgroundTasks={backgroundTasks}
          isSubmitting={isAutomationSubmitting}
          onStartAutomation={onStartAutomation}
          onValidateAutomation={onValidateAutomation}
          onCreateAutomation={onCreateAutomation}
          onUpdateAutomation={onUpdateAutomation}
          onPublishAutomation={onPublishAutomation}
          onDisableAutomation={onDisableAutomation}
          onRespondAutomationApproval={onRespondAutomationApproval}
          onCancelAutomation={onCancelAutomation}
          onOpenAutomationRun={onOpenAutomationRun}
          onSaveScheduledTask={onSaveScheduledTask}
          onDeleteScheduledTask={onDeleteScheduledTask}
          onCancelBackgroundTask={onCancelBackgroundTask}
          onPromoteBackgroundTask={onPromoteBackgroundTask}
        />
      ) : activeView === 'usage' ? (
        <UsageManagementPanel summary={tokenUsageSummary} />
      ) : (
        <SdkExtensionManagement
          view={activeView}
          runtimeConfig={runtimeConfig}
          skillCatalog={skillCatalog}
          skillSearchResults={skillSearchResults}
          memories={memories}
          activeSkills={activeSkills}
          activeMcpServers={activeMcpServers}
          isSaving={isRuntimeConfigSubmitting}
          isSkillSearching={isSkillSearching}
          onRefreshMemories={onRefreshMemories}
          {...(canManageRuntimeConfiguration && onSaveRuntimeConfig
            ? { onSaveRuntimeConfig }
            : {})}
          onSearchSkills={onSearchSkills}
        />
      )}
    </section>
  )
}

function OverviewCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: LucideIcon
  label: string
  value: string
  hint: string
}) {
  return (
    <article className="overview-card tool-management__overview-card ui-card">
      <span className="tool-management__overview-icon">
        <Icon size={17} aria-hidden="true" />
      </span>
      <div>
        <span className="overview-card__label">{label}</span>
        <strong className="overview-card__value">{value}</strong>
        <p className="overview-card__footer">{hint}</p>
      </div>
    </article>
  )
}

function DocShortcut({
  icon: Icon,
  title,
  pathValue,
}: {
  icon: LucideIcon
  title: string
  pathValue: string
}) {
  const [copyStatus, setCopyStatus] = useState('')

  const copyPath = async () => {
    try {
      await requireDesktopBridge().clipboard.writeText(pathValue)
      setCopyStatus('已复制')
    } catch (error) {
      setCopyStatus(error instanceof Error ? `复制失败：${error.message}` : '复制失败')
    }
  }

  return (
    <button
      className="tool-doc-card"
      type="button"
      title={`点击复制路径：${pathValue}`}
      onClick={() => void copyPath()}
    >
      <span className="tool-doc-card__icon"><Icon size={16} aria-hidden="true" /></span>
      <span className="tool-doc-card__body">
        <strong>{title}</strong>
        <small>{pathValue}{copyStatus ? ` · ${copyStatus}` : ''}</small>
      </span>
      <ArrowUpRight size={15} aria-hidden="true" />
    </button>
  )
}

function StatefulToolCatalogEditor({
  tool,
  entry,
  isSubmitting,
  onSave,
  onDelete,
}: {
  tool: ToolDescriptor
  entry?: Record<string, unknown>
  isSubmitting: boolean
  onSave: (tool: ToolDescriptor, payload: Record<string, unknown>, sortOrder?: number) => void
  onDelete: (tool: ToolDescriptor) => void
}) {
  const initialPayload = entry?.payload
  const [draft, setDraft] = useState(initialPayload ? JSON.stringify(initialPayload, null, 2) : '')
  const [sortOrder, setSortOrder] = useState(entry?.sortOrder != null ? String(entry.sortOrder) : '')
  const [error, setError] = useState<string>()

  return (
    <ToolCatalogEditor
      tool={tool}
      entry={entry}
      draft={draft}
      sortOrder={sortOrder}
      error={error}
      isSubmitting={isSubmitting}
      onDraftChange={setDraft}
      onSortOrderChange={setSortOrder}
      onErrorChange={setError}
      onSave={onSave}
      onDelete={onDelete}
    />
  )
}

function buildSchemaPreview(tool: ToolDescriptor) {
  const rawSchema = tool.meta.jsonSchema
  if (isRecord(rawSchema)) {
    return rawSchema
  }
  const required = tool.parameters.filter((parameter) => parameter.required).map((parameter) => parameter.key)
  const properties = tool.parameters.reduce<Record<string, Record<string, unknown>>>((accumulator, parameter) => {
    accumulator[parameter.key] = {
      title: parameter.label,
      type: parameter.dataType,
      description: parameter.description,
      default: parameter.defaultValue,
      enum: parameter.options.length ? parameter.options.map((option) => option.value) : undefined,
      'x-source': parameter.source,
    }
    return accumulator
  }, {})
  return {
    type: 'object',
    required,
    properties,
  }
}

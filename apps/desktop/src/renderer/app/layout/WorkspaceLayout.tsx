// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面 GIS 工作台布局
//
//   文件:       WorkspaceLayout.tsx
//
//   日期:       2026年06月05日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
//
//   维护记录 (2026-07-29):
//     作者: JamesLinYJ
//     协助: OpenAI Codex:GPT-5.6 Sol
//     说明: 将浏览器工作台壳重构为 Electron Ribbon、停靠面板与文档区。
// --------------------------------------------------------------------------

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { AgentThreadRecord } from '@geo-agent-platform/shared-types'
import {
  desktopMenuCommandSchema,
  type DesktopMenuCommand,
} from '../../../contracts/desktopIpc'
import {
  Activity,
  Bot,
  CircleHelp,
  Database,
  FileArchive,
  FileText,
  FilePlus2,
  FolderOpen,
  Gauge,
  History,
  Layers3,
  Map as MapIcon,
  MapPinned,
  Maximize2,
  MessageSquareText,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Ruler,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  TableProperties,
  Upload,
  Workflow,
  X,
  ZoomIn,
} from 'lucide-react'
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  usePanelRef,
} from 'react-resizable-panels'

import type { SidebarItemId, WorkspaceMode } from '../types'
import { useDesktopEventRouter } from '../events/DesktopEventRouterContext'
import { useProductIdentity } from '../ProductIdentityContext'
import {
  subscribeDesktopCommand,
} from '../desktopNavigation'
import {
  formatMapCoordinates,
  formatMapScale,
  INITIAL_MAP_WORKBENCH_STATUS,
  requestMapWorkbenchCommand,
  subscribeMapWorkbenchStatus,
  type MapWorkbenchCommand,
} from '../../features/map/mapWorkbenchBridge'
import {
  closeDesktopDocument,
  isFocusedDesktopDocument,
  moveDesktopDocument,
  openDesktopDocument,
  stepDesktopDocument,
  type DesktopDocument,
} from './documentTabs'

export type { DesktopDocument } from './documentTabs'

export interface DesktopDocumentSlots {
  account: ReactNode
  settings: ReactNode
  security: ReactNode
  debug: ReactNode
  terms: ReactNode
  privacy: ReactNode
}

export interface WorkspaceLayoutProps {
  topBar: ReactNode
  onSidebarItemClick: (id: SidebarItemId) => void
  dataReferenceCount: number
  selectedBasemapName: string
  uploadedLayerName?: string
  providerLabel: string
  modelLabel: string
  modelStatusLabel: string
  modelRouteAvailable: boolean
  artifactCount: number
  selectedArtifactName?: string
  currentThreadId?: string
  workspaceLayoutKey: string
  sessionThreads: AgentThreadRecord[]
  onNewTask: () => void
  onSelectThread: (threadId: string) => void
  mainSlot: ReactNode
  mapSlot: ReactNode
  workflowSlot: ReactNode
  contentsSlot: ReactNode
  inspectorSlot: ReactNode
  toolsSlot: ReactNode
  workspaceMode: WorkspaceMode
  onWorkspaceModeChange: (mode: WorkspaceMode) => void
  onContentsModeChange: (mode: DesktopLayerView) => void
  onExportResults: () => void
  desktopDocuments?: DesktopDocumentSlots
  activeDesktopDocument: DesktopDocument
  onDesktopDocumentChange: (document: DesktopDocument) => void
  backendActionDisabledReason?: string
  canAccessAccount?: boolean
  canAccessDiagnostics?: boolean
  canAccessSecurity?: boolean
}

type RibbonTab = 'project' | 'map' | 'analysis' | 'view' | 'manage'
type DesktopLayerView = 'drawing' | 'sources'
export type DesktopContentsMode = 'layers' | 'history'

const RIBBON_TABS: ReadonlyArray<{ id: RibbonTab; label: string }> = [
  { id: 'project', label: '工程' },
  { id: 'map', label: '地图' },
  { id: 'analysis', label: '分析' },
  { id: 'view', label: '视图' },
  { id: 'manage', label: '管理' },
]

export function WorkspaceLayout(props: WorkspaceLayoutProps) {
  const { productName } = useProductIdentity()
  const {
    topBar,
    onSidebarItemClick,
    dataReferenceCount,
    selectedBasemapName,
    uploadedLayerName,
    providerLabel,
    modelLabel,
    modelStatusLabel,
    modelRouteAvailable,
    artifactCount,
    selectedArtifactName,
    currentThreadId,
    workspaceLayoutKey,
    sessionThreads,
    onNewTask,
    onSelectThread,
    mainSlot,
    mapSlot,
    workflowSlot,
    contentsSlot,
    inspectorSlot,
    toolsSlot,
    workspaceMode,
    onWorkspaceModeChange,
    desktopDocuments,
    onContentsModeChange,
    onDesktopDocumentChange,
    onExportResults,
    backendActionDisabledReason,
    canAccessAccount = false,
    canAccessDiagnostics = false,
    canAccessSecurity = false,
  } = props
  const desktopEvents = useDesktopEventRouter()
  const [ribbonTab, setRibbonTab] = useState<RibbonTab>('map')
  const [openDocuments, setOpenDocuments] = useState<DesktopDocument[]>(
    () => openDesktopDocument(['map'], props.activeDesktopDocument),
  )
  const [draggedDocument, setDraggedDocument] = useState<DesktopDocument | null>(null)
  const [mapStatus, setMapStatus] = useState(INITIAL_MAP_WORKBENCH_STATUS)
  const pendingMapCommandRef = useRef<MapWorkbenchCommand | null>(null)
  const canOpenDocument = useCallback((document: DesktopDocument) => {
    if (document === 'account') return canAccessAccount
    if (document === 'security') return canAccessSecurity
    if (document === 'debug') return canAccessDiagnostics
    return true
  }, [canAccessAccount, canAccessDiagnostics, canAccessSecurity])
  const activeDocument = canOpenDocument(props.activeDesktopDocument)
    ? props.activeDesktopDocument
    : 'map'
  const visibleOpenDocuments = openDesktopDocument(
    openDocuments,
    activeDocument,
  ).filter(canOpenDocument)
  const [contentsMode, setContentsMode] = useState<DesktopContentsMode>('layers')
  const commandSearchRef = useRef<HTMLInputElement>(null)
  const contentsPanelRef = usePanelRef()
  const chatPanelRef = usePanelRef()
  const focusedDocumentPanelStateRef = useRef<{
    contentsCollapsed: boolean
    assistantCollapsed: boolean
  } | null>(null)
  useEffect(() => {
    const handleWorkbenchShortcut = (event: KeyboardEvent) => {
      if (
        event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && event.key.toLowerCase() === 'q'
      ) {
        event.preventDefault()
        const commandSearch = commandSearchRef.current
        commandSearch?.focus()
        commandSearch?.select()
        return
      }
      const commandSearch = commandSearchRef.current
      if (event.key === 'Escape' && document.activeElement === commandSearch) {
        commandSearch?.blur()
      }
    }
    // 原生菜单提供操作系统 accelerator；Renderer 监听确保焦点已在 WebContents
    // 内时同样可靠，并让键盘行为可由真实 Electron E2E 验证。
    window.addEventListener('keydown', handleWorkbenchShortcut, { capture: true })
    return () => window.removeEventListener('keydown', handleWorkbenchShortcut, { capture: true })
  }, [])
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `geo-agent-platform-desktop:${workspaceLayoutKey}`,
    panelIds: ['contents', 'document', 'assistant'],
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
  })
  const visibleRibbonTabs = RIBBON_TABS

  useEffect(() => {
    const focused = isFocusedDesktopDocument(activeDocument)
    if (focused && !focusedDocumentPanelStateRef.current) {
      focusedDocumentPanelStateRef.current = {
        contentsCollapsed: contentsPanelRef.current?.isCollapsed() ?? false,
        assistantCollapsed: chatPanelRef.current?.isCollapsed() ?? false,
      }
      contentsPanelRef.current?.collapse()
      chatPanelRef.current?.collapse()
      return
    }
    if (focused || !focusedDocumentPanelStateRef.current) return

    const previous = focusedDocumentPanelStateRef.current
    focusedDocumentPanelStateRef.current = null
    if (previous.contentsCollapsed) contentsPanelRef.current?.collapse()
    else contentsPanelRef.current?.expand()
    if (previous.assistantCollapsed) chatPanelRef.current?.collapse()
    else chatPanelRef.current?.expand()
  }, [activeDocument, chatPanelRef, contentsPanelRef])

  const effectiveRibbonTab = visibleRibbonTabs.some(tab => tab.id === ribbonTab)
    ? ribbonTab
    : 'map'

  const openDocument = useCallback((document: DesktopDocument) => {
    if (!canOpenDocument(document)) return
    setOpenDocuments(current => openDesktopDocument(
      openDesktopDocument(current, props.activeDesktopDocument),
      document,
    ))
    onDesktopDocumentChange(document)
    if (document === 'tools') onSidebarItemClick('tools')
    if (document === 'results') onSidebarItemClick('export')
  }, [
    canOpenDocument,
    onDesktopDocumentChange,
    onSidebarItemClick,
    props.activeDesktopDocument,
  ])

  const closeDocument = useCallback((document: DesktopDocument) => {
    const result = closeDesktopDocument(visibleOpenDocuments, activeDocument, document)
    setOpenDocuments(result.documents)
    if (result.activeDocument !== activeDocument) {
      onDesktopDocumentChange(result.activeDocument)
    }
  }, [activeDocument, onDesktopDocumentChange, visibleOpenDocuments])

  const reorderDocument = useCallback((
    document: DesktopDocument,
    target: DesktopDocument,
  ) => {
    setOpenDocuments(current => moveDesktopDocument(current, document, target))
  }, [])

  useEffect(() => subscribeMapWorkbenchStatus(setMapStatus), [])

  const runMapCommand = useCallback((command: MapWorkbenchCommand) => {
    if (activeDocument === 'map') {
      requestMapWorkbenchCommand(command)
      return
    }
    pendingMapCommandRef.current = command
    openDocument('map')
  }, [activeDocument, openDocument])

  useEffect(() => {
    if (activeDocument !== 'map' || !pendingMapCommandRef.current) return
    const command = pendingMapCommandRef.current
    pendingMapCommandRef.current = null
    requestMapWorkbenchCommand(command)
  }, [activeDocument])

  const selectContentsMode = useCallback((mode: DesktopContentsMode) => {
    setContentsMode(mode)
  }, [])

  const selectLayerView = useCallback((mode: DesktopLayerView) => {
    setContentsMode('layers')
    onContentsModeChange(mode)
  }, [onContentsModeChange])

  const focusWorkspacePicker = useCallback(() => {
    const picker = document.getElementById('geo-agent-platform-workspace-picker')
    if (picker instanceof HTMLSelectElement) {
      picker.focus()
      picker.showPicker?.()
    }
  }, [])

  const handleDesktopCommand = useCallback((command: DesktopMenuCommand) => {
    if (command === 'new-analysis') {
      if (!backendActionDisabledReason) onNewTask()
    }
    else if (command === 'open-workspace') {
      if (backendActionDisabledReason) return
      focusWorkspacePicker()
    } else if (command === 'focus-command') commandSearchRef.current?.focus()
    else if (command === 'open-map') openDocument('map')
    else if (command === 'open-tools') openDocument('tools')
    else if (command === 'open-workflow') openDocument('workflow')
    else if (command === 'open-results') openDocument('results')
    else if (command === 'open-account') openDocument('account')
    else if (command === 'open-security') openDocument('security')
    else if (command === 'open-diagnostics') openDocument('debug')
    else if (command === 'toggle-contents') {
      if (contentsPanelRef.current?.isCollapsed()) contentsPanelRef.current.expand()
      else contentsPanelRef.current?.collapse()
    } else if (command === 'toggle-assistant') {
      if (chatPanelRef.current?.isCollapsed()) chatPanelRef.current.expand()
      else chatPanelRef.current?.collapse()
    } else if (command === 'export-results') {
      if (!backendActionDisabledReason) onExportResults()
    }
  }, [
    backendActionDisabledReason,
    chatPanelRef,
    contentsPanelRef,
    focusWorkspacePicker,
    onExportResults,
    onNewTask,
    openDocument,
  ])

  useEffect(() => {
    const unsubscribeLocal = subscribeDesktopCommand(handleDesktopCommand)
    const unsubscribeNative = desktopEvents.subscribe(event => {
      if (event.event !== 'desktop:command') return
      const payload = event.payload
      const command = desktopMenuCommandSchema.safeParse(
        payload && typeof payload === 'object' && 'command' in payload
          ? payload.command
          : undefined,
      )
      if (command.success) handleDesktopCommand(command.data)
    })
    return () => {
      unsubscribeLocal()
      unsubscribeNative()
    }
  }, [desktopEvents, handleDesktopCommand])

  const selectSidebarItem = useCallback((itemId: SidebarItemId) => {
    if (itemId === 'sources') {
      selectLayerView('sources')
      contentsPanelRef.current?.expand()
    }
    onSidebarItemClick(itemId)
  }, [contentsPanelRef, onSidebarItemClick, selectLayerView])

  const executeCommandSearch = (value: string) => {
    const normalized = value.trim().toLowerCase()
    if (!normalized) return
    if (/图层|数据源|内容/u.test(normalized)) {
      contentsPanelRef.current?.expand()
      selectLayerView(normalized.includes('数据源') ? 'sources' : 'drawing')
    } else if (/对话|智能|助手/u.test(normalized)) {
      chatPanelRef.current?.expand()
    } else if (/工具|自动化/u.test(normalized)) openDocument('tools')
    else if (/工作流|计划/u.test(normalized)) openDocument('workflow')
    else if (/结果|成果/u.test(normalized)) openDocument('results')
    else if (/账户|账号/u.test(normalized) && canAccessAccount) openDocument('account')
    else if (/安全|权限/u.test(normalized) && canAccessSecurity) openDocument('security')
    else if (/诊断/u.test(normalized) && canAccessDiagnostics) openDocument('debug')
    else if (/配置|设置|模型|路由/u.test(normalized)) openDocument('settings')
    else openDocument('map')
  }

  return (
    <main className="gf-desktop-shell" data-workspace-mode={workspaceMode}>
      <div className="gf-titlebar-region">
        {topBar}
        <label className="gf-command-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={commandSearchRef}
            placeholder="命令搜索 (Alt+Q)"
            aria-label="命令搜索"
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              executeCommandSearch(event.currentTarget.value)
              event.currentTarget.select()
            }}
          />
        </label>
      </div>

      <section className="gf-ribbon" aria-label={`${productName} 功能区`}>
        <div className="gf-ribbon-tabs" role="tablist" aria-label="功能区选项卡">
          {visibleRibbonTabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={effectiveRibbonTab === tab.id}
              className={effectiveRibbonTab === tab.id ? 'is-active' : ''}
              onClick={() => setRibbonTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <RibbonContent
          tab={effectiveRibbonTab}
          workspaceMode={workspaceMode}
          onWorkspaceModeChange={onWorkspaceModeChange}
          onNewTask={onNewTask}
          onOpenDocument={openDocument}
          onOpenContents={() => contentsPanelRef.current?.expand()}
          onOpenAssistant={() => chatPanelRef.current?.expand()}
          onOpenDrawingOrder={() => {
            selectLayerView('drawing')
            contentsPanelRef.current?.expand()
          }}
          onOpenHistory={() => selectContentsMode('history')}
          onOpenWorkspace={focusWorkspacePicker}
          onMapCommand={runMapCommand}
          onSelectSidebar={selectSidebarItem}
          backendActionDisabledReason={backendActionDisabledReason}
          canAccessAccount={canAccessAccount}
          canAccessDiagnostics={canAccessDiagnostics}
          canAccessSecurity={canAccessSecurity}
        />
      </section>

      <Group
        className="gf-workspace-panels"
        orientation="horizontal"
        defaultLayout={defaultLayout ?? {
          contents: 17,
          document: 58,
          assistant: 25,
        }}
        onLayoutChanged={onLayoutChanged}
      >
        <Panel
          id="contents"
          panelRef={contentsPanelRef}
          defaultSize="17%"
          minSize="230px"
          maxSize="390px"
          collapsedSize={0}
          collapsible
        >
          <aside className="gf-dock gf-contents-dock" aria-label="内容">
            <header className="gf-dock-title">
              <span>
                <Layers3 size={16} aria-hidden="true" />
                <strong>内容</strong>
              </span>
              <button
                type="button"
                aria-label="收起内容面板"
                title="收起内容面板"
                onClick={() => contentsPanelRef.current?.collapse()}
              >
                <PanelLeftClose size={15} />
              </button>
            </header>
            <div className="gf-contents-tabs" role="tablist" aria-label="内容视图">
              <button
                type="button"
                className={contentsMode === 'layers' ? 'is-active' : ''}
                onClick={() => selectContentsMode('layers')}
              >
                图层
              </button>
              <button
                type="button"
                className={contentsMode === 'history' ? 'is-active' : ''}
                onClick={() => selectContentsMode('history')}
              >
                历史
              </button>
            </div>
            {contentsMode === 'history' ? (
              <ThreadContents
                currentThreadId={currentThreadId}
                sessionThreads={sessionThreads}
                onNewTask={onNewTask}
                onSelectThread={onSelectThread}
                disabledReason={backendActionDisabledReason}
              />
            ) : (
              <div className="gf-contents-body" data-mode="layers">
                {contentsSlot}
              </div>
            )}
          </aside>
        </Panel>

        <Separator className="gf-panel-separator" aria-label="调整内容面板宽度" />

        <Panel id="document" defaultSize="58%" minSize="480px">
          <section className="gf-document-workspace">
            <header className="gf-document-tabs" aria-label="文档标签">
              {visibleOpenDocuments.map(document => (
                <div
                  key={document}
                  className={[
                    'gf-document-tab',
                    activeDocument === document ? 'is-active' : '',
                    document === 'map' ? 'is-pinned' : '',
                    draggedDocument === document ? 'is-dragging' : '',
                  ].filter(Boolean).join(' ')}
                  role="presentation"
                  draggable={document !== 'map'}
                  onDragStart={event => {
                    if (document === 'map') {
                      event.preventDefault()
                      return
                    }
                    setDraggedDocument(document)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', document)
                  }}
                  onDragEnd={() => setDraggedDocument(null)}
                  onDragOver={event => {
                    if (!draggedDocument || document === 'map') return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={event => {
                    event.preventDefault()
                    if (draggedDocument) reorderDocument(draggedDocument, document)
                    setDraggedDocument(null)
                  }}
                >
                  <button
                    type="button"
                    className="gf-document-tab__activate"
                    role="tab"
                    aria-selected={activeDocument === document}
                    onClick={() => openDocument(document)}
                    onKeyDown={event => {
                      if (!event.altKey || document === 'map') return
                      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                      event.preventDefault()
                      setOpenDocuments(current => stepDesktopDocument(
                        current,
                        document,
                        event.key === 'ArrowLeft' ? -1 : 1,
                      ))
                    }}
                  >
                    {document === 'map' ? <MapIcon size={14} aria-hidden="true" /> : documentIcon(document)}
                    <span>{document === 'map' ? '地图' : documentTitleFor(document)}</span>
                  </button>
                  {document !== 'map' ? (
                    <button
                      type="button"
                      className="gf-document-tab__close"
                      aria-label={`关闭${documentTitleFor(document)}`}
                      title={`关闭${documentTitleFor(document)}`}
                      onClick={() => closeDocument(document)}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              ))}
              <span className="gf-document-tab-spacer" />
              <button
                type="button"
                className="gf-panel-reveal"
                aria-label="显示内容面板"
                title="显示内容面板"
                onClick={() => contentsPanelRef.current?.expand()}
              >
                <PanelLeftOpen size={15} />
              </button>
              <button
                type="button"
                className="gf-panel-reveal"
                aria-label="显示智能对话面板"
                title="显示智能对话面板"
                onClick={() => chatPanelRef.current?.expand()}
              >
                <PanelRightOpen size={15} />
              </button>
            </header>
            <div
              key={activeDocument}
              className="gf-document-canvas"
              data-document={activeDocument}
            >
              {renderDocument(activeDocument, {
                mapSlot,
                toolsSlot,
                workflowSlot,
                inspectorSlot,
                desktopDocuments,
              })}
            </div>
          </section>
        </Panel>

        <Separator className="gf-panel-separator" aria-label="调整智能对话面板宽度" />

        <Panel
          id="assistant"
          panelRef={chatPanelRef}
          defaultSize="25%"
          minSize="320px"
          maxSize="560px"
          collapsedSize={0}
          collapsible
        >
          <aside className="gf-dock" aria-label="智能对话">
            <header className="gf-dock-title">
              <span>
                <Sparkles size={16} aria-hidden="true" />
                <strong>智能对话</strong>
              </span>
              <button
                type="button"
                aria-label="收起智能对话面板"
                title="收起智能对话面板"
                onClick={() => chatPanelRef.current?.collapse()}
              >
                <PanelRightClose size={15} />
              </button>
            </header>
            <div className="gf-assistant-body">{mainSlot}</div>
          </aside>
        </Panel>
      </Group>

      <footer className="gf-statusbar" aria-label="地图状态">
        <span><MousePointer2 size={12} /> {mapStatus.ready ? '地图就绪' : '地图未激活'}</span>
        <span>{formatMapScale(mapStatus.scaleDenominator)}</span>
        <span>{formatMapCoordinates(mapStatus.longitude, mapStatus.latitude)}</span>
        <span>CRS: {mapStatus.crs ?? '—'}</span>
        <span>选择 {mapStatus.selectedFeatureCount} 项</span>
        <span>底图: {selectedBasemapName}</span>
        <span>{uploadedLayerName ? `数据: ${uploadedLayerName}` : `引用 ${dataReferenceCount} 项`}</span>
        <span>{selectedArtifactName ?? `${artifactCount} 项成果`}</span>
        <span className="gf-statusbar__spacer" />
        <span
          className={!modelRouteAvailable ? 'is-warning' : modelStatusLabel.includes('失败') ? 'is-error' : 'is-online'}
          title={modelStatusLabel}
        >
          <i aria-hidden="true" />
          {modelRouteAvailable
            ? `${providerLabel} · ${modelLabel}${modelStatusLabel === '准备就绪' ? '' : ` · ${modelStatusLabel}`}`
            : modelStatusLabel}
        </span>
      </footer>
    </main>
  )
}

interface RibbonContentProps {
  tab: RibbonTab
  workspaceMode: WorkspaceMode
  onWorkspaceModeChange: (mode: WorkspaceMode) => void
  onNewTask: () => void
  onOpenDocument: (document: DesktopDocument) => void
  onOpenContents: () => void
  onOpenAssistant: () => void
  onOpenDrawingOrder: () => void
  onOpenHistory: () => void
  onOpenWorkspace: () => void
  onMapCommand: (command: MapWorkbenchCommand) => void
  onSelectSidebar: (id: SidebarItemId) => void
  backendActionDisabledReason?: string
  canAccessAccount: boolean
  canAccessDiagnostics: boolean
  canAccessSecurity: boolean
}

function RibbonContent(props: RibbonContentProps) {
  const {
    tab,
    workspaceMode,
    onWorkspaceModeChange,
    onNewTask,
    onOpenDocument,
    onOpenContents,
    onOpenAssistant,
    onOpenDrawingOrder,
    onOpenHistory,
    onOpenWorkspace,
    onMapCommand,
    onSelectSidebar,
    backendActionDisabledReason,
    canAccessAccount,
    canAccessDiagnostics,
    canAccessSecurity,
  } = props
  if (tab === 'project') {
    return (
      <div className="gf-ribbon-groups">
        <RibbonGroup label="工程">
          <RibbonAction icon={<FilePlus2 />} label="新建分析" large onClick={onNewTask} disabledReason={backendActionDisabledReason} />
          <RibbonAction icon={<FolderOpen />} label="打开工作区" onClick={onOpenWorkspace} disabledReason={backendActionDisabledReason} />
          <RibbonAction icon={<Upload />} label="导入数据" onClick={() => onSelectSidebar('sources')} disabledReason={backendActionDisabledReason} />
          <RibbonAction icon={<FileArchive />} label="导出成果" onClick={() => onOpenDocument('results')} disabledReason={backendActionDisabledReason} />
        </RibbonGroup>
        <RibbonGroup label="最近">
          <RibbonAction icon={<History />} label="任务历史" onClick={onOpenHistory} disabledReason={backendActionDisabledReason} />
          <RibbonAction icon={<TableProperties />} label="成果清单" onClick={() => onOpenDocument('results')} disabledReason={backendActionDisabledReason} />
        </RibbonGroup>
      </div>
    )
  }
  if (tab === 'analysis') {
    return (
      <div className="gf-ribbon-groups">
        <RibbonGroup label="智能分析">
          <RibbonAction icon={<Sparkles />} label="新建分析" large onClick={onNewTask} disabledReason={backendActionDisabledReason} />
          <RibbonAction icon={<Bot />} label="智能对话" onClick={onOpenAssistant} />
          <RibbonAction icon={<Workflow />} label="计划与工作流" onClick={() => onOpenDocument('workflow')} disabledReason={backendActionDisabledReason} />
          <RibbonAction icon={<Play />} label="工具与自动化" onClick={() => onOpenDocument('tools')} disabledReason={backendActionDisabledReason} />
        </RibbonGroup>
        <RibbonGroup label="空间分析">
          <RibbonAction icon={<MapPinned />} label="空间查询" onClick={() => onSelectSidebar('query')} disabledReason={backendActionDisabledReason} />
          <RibbonAction icon={<Database />} label="数据源" onClick={() => onSelectSidebar('sources')} disabledReason={backendActionDisabledReason} />
          <RibbonAction icon={<Activity />} label="分析结果" onClick={() => onOpenDocument('results')} disabledReason={backendActionDisabledReason} />
        </RibbonGroup>
      </div>
    )
  }
  if (tab === 'view') {
    return (
      <div className="gf-ribbon-groups">
        <RibbonGroup label="停靠窗口">
          <RibbonAction icon={<PanelLeftOpen />} label="内容" large onClick={onOpenContents} />
          <RibbonAction icon={<PanelRightOpen />} label="智能对话" large onClick={onOpenAssistant} />
          <RibbonAction icon={<Layers3 />} label="绘制顺序" onClick={onOpenDrawingOrder} />
        </RibbonGroup>
        <RibbonGroup label="视图">
          <RibbonAction icon={<Maximize2 />} label="地图视图" onClick={() => onOpenDocument('map')} />
          {canAccessDiagnostics ? (
            <RibbonAction icon={<Gauge />} label="诊断视图" onClick={() => onOpenDocument('debug')} />
          ) : null}
        </RibbonGroup>
      </div>
    )
  }
  if (tab === 'manage') {
    return (
      <div className="gf-ribbon-groups">
        <RibbonGroup label="平台">
          <RibbonAction icon={<Settings2 />} label="服务与模型" large onClick={() => onOpenDocument('settings')} />
          {canAccessDiagnostics ? (
            <RibbonAction icon={<Gauge />} label="运行诊断" onClick={() => onOpenDocument('debug')} />
          ) : null}
          {canAccessSecurity ? (
            <RibbonAction icon={<ShieldCheck />} label="安全管理" large onClick={() => onOpenDocument('security')} />
          ) : null}
          {canAccessAccount ? (
            <RibbonAction icon={<CircleHelp />} label="账号中心" onClick={() => onOpenDocument('account')} />
          ) : null}
        </RibbonGroup>
      </div>
    )
  }
  return (
    <div className="gf-ribbon-groups">
      <RibbonGroup label="地图">
        <RibbonAction
          icon={<MapIcon />}
          label="地图浏览"
          large
          active={workspaceMode === 'map'}
          onClick={() => {
            onWorkspaceModeChange('map')
            onOpenDocument('map')
          }}
        />
        <RibbonAction
          icon={<Bot />}
          label="气象分析"
          large
          active={workspaceMode === 'meteorology'}
          onClick={() => onWorkspaceModeChange('meteorology')}
          disabledReason={backendActionDisabledReason}
        />
        <RibbonAction icon={<Layers3 />} label="图层" onClick={onOpenContents} />
        <RibbonAction icon={<Database />} label="添加数据" onClick={() => onSelectSidebar('sources')} disabledReason={backendActionDisabledReason} />
      </RibbonGroup>
      <RibbonGroup label="导航">
        <RibbonAction icon={<ZoomIn />} label="放大" onClick={() => onMapCommand('zoom-in')} />
        <RibbonAction icon={<MapPinned />} label="定位" onClick={() => onSelectSidebar('query')} disabledReason={backendActionDisabledReason} />
        <RibbonAction icon={<Ruler />} label="测量" onClick={() => onMapCommand('toggle-measure')} />
      </RibbonGroup>
      <RibbonGroup label="视图">
        <RibbonAction icon={<MessageSquareText />} label="智能对话" onClick={onOpenAssistant} />
        <RibbonAction icon={<Workflow />} label="工作流" onClick={() => onOpenDocument('workflow')} />
      </RibbonGroup>
    </div>
  )
}

function RibbonGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="gf-ribbon-group">
      <div className="gf-ribbon-actions">{children}</div>
      <span className="gf-ribbon-group__label">{label}</span>
    </section>
  )
}

function RibbonAction({
  icon,
  label,
  large = false,
  active = false,
  onClick,
  disabledReason,
}: {
  icon: ReactNode
  label: string
  large?: boolean
  active?: boolean
  onClick: () => void
  disabledReason?: string
}) {
  return (
    <button
      type="button"
      className={`gf-ribbon-action${large ? ' is-large' : ''}${active ? ' is-active' : ''}`}
      onClick={onClick}
      disabled={Boolean(disabledReason)}
      title={disabledReason}
    >
      <span aria-hidden="true">{icon}</span>
      <em>{label}</em>
    </button>
  )
}

function ThreadContents({
  currentThreadId,
  sessionThreads,
  onNewTask,
  onSelectThread,
  disabledReason,
}: {
  currentThreadId?: string
  sessionThreads: AgentThreadRecord[]
  onNewTask: () => void
  onSelectThread: (threadId: string) => void
  disabledReason?: string
}) {
  return (
    <div className="gf-thread-contents">
      <button type="button" className="gf-thread-new" onClick={onNewTask} disabled={Boolean(disabledReason)} title={disabledReason}>
        <FilePlus2 size={14} /> 新建分析
      </button>
      <div className="gf-thread-list">
        {sessionThreads.slice(0, 30).map(thread => (
          <button
            key={thread.id}
            type="button"
            className={thread.id === currentThreadId ? 'is-active' : ''}
            onClick={() => onSelectThread(thread.id)}
            disabled={Boolean(disabledReason)}
            title={disabledReason}
          >
            <MessageSquareText size={13} />
            <span>{thread.title || '未命名分析'}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function renderDocument(
  document: DesktopDocument,
  slots: {
    mapSlot: ReactNode
    toolsSlot: ReactNode
    workflowSlot: ReactNode
    inspectorSlot: ReactNode
    desktopDocuments?: DesktopDocumentSlots
  },
): ReactNode {
  if (document === 'map') return slots.mapSlot
  if (document === 'tools') return slots.toolsSlot
  if (document === 'workflow') return slots.workflowSlot
  if (document === 'results') return slots.inspectorSlot
  if (document === 'settings') return slots.desktopDocuments?.settings ?? <DocumentUnavailable />
  if (document === 'account') return slots.desktopDocuments?.account ?? <DocumentUnavailable />
  if (document === 'security') return slots.desktopDocuments?.security ?? <DocumentUnavailable />
  if (document === 'terms') return slots.desktopDocuments?.terms ?? <DocumentUnavailable />
  if (document === 'privacy') return slots.desktopDocuments?.privacy ?? <DocumentUnavailable />
  return slots.desktopDocuments?.debug ?? <DocumentUnavailable />
}

function DocumentUnavailable() {
  return (
    <div className="gf-document-unavailable">
      <CircleHelp size={24} />
      <strong>该文档暂不可用</strong>
      <span>请检查当前账户权限或后台服务状态。</span>
    </div>
  )
}

function documentIcon(document: DesktopDocument): ReactNode {
  if (document === 'settings') return <Settings2 size={14} />
  if (document === 'tools') return <Settings2 size={14} />
  if (document === 'workflow') return <Workflow size={14} />
  if (document === 'results') return <Activity size={14} />
  if (document === 'security') return <ShieldCheck size={14} />
  if (document === 'account') return <CircleHelp size={14} />
  if (document === 'terms' || document === 'privacy') return <FileText size={14} />
  return <Gauge size={14} />
}

function documentTitleFor(document: DesktopDocument): string {
  if (document === 'map') return '地图'
  if (document === 'tools') return '工具与自动化'
  if (document === 'workflow') return '智能体工作流'
  if (document === 'results') return '分析结果'
  if (document === 'settings') return '服务与模型'
  if (document === 'account') return '账号中心'
  if (document === 'security') return '安全管理'
  if (document === 'terms') return '服务协议'
  if (document === 'privacy') return '隐私政策'
  return '配置与诊断'
}

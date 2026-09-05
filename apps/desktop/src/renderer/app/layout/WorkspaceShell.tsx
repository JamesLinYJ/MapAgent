// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台内容装配
//
//   文件:       WorkspaceShell.tsx
//
//   说明:
//   这里只负责把已准备好的工作台数据装入布局和面板。数据读取、请求编排、
//   Zustand 订阅以及导航动作仍由 AppShell 的控制器组合负责。
// --------------------------------------------------------------------------

import type { ComponentProps, ComponentType } from 'react'
import type { DesktopDocumentSlots, WorkspaceLayoutProps } from './WorkspaceLayout'
import type { DesktopDocument } from './documentTabs'
import { TopBar } from './TopBar'
import { WorkspaceConversationPanel } from './WorkspaceConversationPanel'
import { WorkspaceInspectorPanel, type WorkspaceInspectorProgress } from './WorkspaceInspectorPanel'
import { WorkspaceMapPanel } from './WorkspaceMapPanel'
import { WorkspaceToolPanel } from './WorkspaceToolPanel'
import { WorkspaceWorkflowPanel } from './WorkspaceWorkflowPanel'
import {
  WorkspaceRestrictedContents,
  WorkspaceRestrictedConversation,
  WorkspaceRestrictedDocument,
} from './WorkspaceRestrictedPanels'
import { ExportWizard } from '../../features/export/ExportWizard'
import { LoginScreen } from '../auth/LoginScreen'
import {
  createWorkspaceShellInspectorDetails,
  type WorkspaceInspectorDetailsInput,
} from '../workspaceInspectorDetails'
import { useProductIdentity } from '../ProductIdentityContext'

type LayoutProps = Omit<WorkspaceLayoutProps,
  | 'topBar'
  | 'mainSlot'
  | 'mapSlot'
  | 'workflowSlot'
  | 'contentsSlot'
  | 'inspectorSlot'
  | 'toolsSlot'
  | 'desktopDocuments'
  | 'activeDesktopDocument'
  | 'onDesktopDocumentChange'
>

type ExportWizardView = Omit<ComponentProps<typeof ExportWizard>, 'onOpenChange' | 'onConfirm'>

interface WorkspaceShellAccess {
  backendActionsEnabled: boolean
  unavailableReason: string
  showInteractiveLogin: boolean
}

interface WorkspaceShellPanels {
  tools: ComponentProps<typeof WorkspaceToolPanel>
  conversation: ComponentProps<typeof WorkspaceConversationPanel>
  map: ComponentProps<typeof WorkspaceMapPanel>
  workflow: ComponentProps<typeof WorkspaceWorkflowPanel>
  inspector: {
    details: WorkspaceInspectorDetailsInput
    progress: WorkspaceInspectorProgress
    basemapName: string
  }
}

export interface WorkspaceShellProps {
  Workspace: ComponentType<WorkspaceLayoutProps>
  desktopDocuments: DesktopDocumentSlots
  activeDesktopDocument: DesktopDocument
  onDesktopDocumentChange: (document: DesktopDocument) => void
  layout: LayoutProps
  topBar: ComponentProps<typeof TopBar>
  access: WorkspaceShellAccess
  panels: WorkspaceShellPanels
  exportWizard: ExportWizardView | null
  onCloseExportWizard: () => void
  onConfirmExport: ComponentProps<typeof ExportWizard>['onConfirm']
  onAuthenticated: () => void
}

export function WorkspaceShell({
  Workspace,
  desktopDocuments,
  activeDesktopDocument,
  onDesktopDocumentChange,
  layout,
  topBar,
  access,
  panels,
  exportWizard,
  onCloseExportWizard,
  onConfirmExport,
  onAuthenticated,
}: WorkspaceShellProps) {
  const { productName } = useProductIdentity()
  const { inspectorDetails, contentsDetails } = createWorkspaceShellInspectorDetails(
    panels.inspector.details,
  )

  return (
    <>
      {exportWizard ? (
        <ExportWizard
          {...exportWizard}
          onOpenChange={open => {
            if (!open) onCloseExportWizard()
          }}
          onConfirm={onConfirmExport}
        />
      ) : null}
      <Workspace
        {...layout}
        desktopDocuments={desktopDocuments}
        activeDesktopDocument={activeDesktopDocument}
        onDesktopDocumentChange={onDesktopDocumentChange}
        topBar={<TopBar {...topBar} />}
        toolsSlot={access.backendActionsEnabled
          ? <WorkspaceToolPanel {...panels.tools} />
          : <WorkspaceRestrictedDocument title="工具与自动化" reason={access.unavailableReason} />}
        mainSlot={access.backendActionsEnabled
          ? <WorkspaceConversationPanel {...panels.conversation} />
          : <WorkspaceRestrictedConversation reason={access.unavailableReason} onRetry={onAuthenticated} />}
        mapSlot={<WorkspaceMapPanel {...panels.map} />}
        workflowSlot={access.backendActionsEnabled
          ? <WorkspaceWorkflowPanel key={panels.workflow.runId ?? 'no-run'} {...panels.workflow} />
          : <WorkspaceRestrictedDocument title="智能体工作流" reason={access.unavailableReason} />}
        contentsSlot={access.backendActionsEnabled
          ? <WorkspaceInspectorPanel detail={contentsDetails} />
          : <WorkspaceRestrictedContents basemapName={panels.inspector.basemapName} reason={access.unavailableReason} />}
        inspectorSlot={access.backendActionsEnabled
          ? <WorkspaceInspectorPanel detail={inspectorDetails} progress={panels.inspector.progress} />
          : <WorkspaceRestrictedDocument title="分析结果" reason={access.unavailableReason} />}
      />
      {access.showInteractiveLogin ? (
        <div
          className="gf-login-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`登录 ${productName}`}
        >
          <LoginScreen onAuthenticated={onAuthenticated} />
        </div>
      ) : null}
    </>
  )
}

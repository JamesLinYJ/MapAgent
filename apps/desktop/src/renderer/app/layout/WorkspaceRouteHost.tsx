// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台路由宿主
//
//   文件:       WorkspaceRouteHost.tsx
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { lazy, type ComponentType, type ReactNode } from 'react'
import type { DebugPageProps } from '../../features/debug/DebugPage'
import { WorkspaceDebugPanel } from './WorkspaceDebugPanel'
import {
  WorkspaceLayout,
  type DesktopDocumentSlots,
  type WorkspaceLayoutProps,
} from './WorkspaceLayout'

const SecurityAdminPage = lazy(() => import('../../features/security/SecurityAdminPage'))
const ModelSettingsPage = lazy(() => import('../../features/settings/ModelSettingsPage').then(module => ({
  default: module.ModelSettingsPage,
})))
const AccountCenterPage = lazy(() => import('../../features/account/AccountCenterPage').then(module => ({
  default: module.AccountCenterPage,
})))
const LegalPolicyPage = lazy(() => import('../../features/account/LegalPolicyPage').then(module => ({
  default: module.LegalPolicyPage,
})))
interface WorkspaceRouteHostProps {
  renderWorkspace: (
    Workspace: ComponentType<WorkspaceLayoutProps>,
    documents: DesktopDocumentSlots,
  ) => ReactNode
  renderDebug: (Debug: ComponentType<DebugPageProps>) => ReactNode
  account: ReactNode
  settings: ReactNode
  canAccessDiagnostics: boolean
  canAccessSecurity: boolean
  terms: ReactNode
  privacy: ReactNode
}

export function WorkspaceRouteHost({
  renderWorkspace,
  renderDebug,
  account,
  settings,
  canAccessDiagnostics,
  canAccessSecurity,
  terms,
  privacy,
}: WorkspaceRouteHostProps) {
  return renderWorkspace(WorkspaceLayout, {
    account,
    settings,
    security: canAccessSecurity ? <SecurityAdminPage /> : null,
    debug: canAccessDiagnostics ? renderDebug(WorkspaceDebugPanel) : null,
    terms,
    privacy,
  })
}

export { AccountCenterPage, LegalPolicyPage, ModelSettingsPage }

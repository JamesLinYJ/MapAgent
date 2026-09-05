// +-------------------------------------------------------------------------
//
//   地理智能平台 - 离线桌面工作台渲染测试
//
//   文件:       workspaceOfflineShell.test.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

import { TopBar } from '../app/layout/TopBar'
import {
  DesktopEventRouterContext,
  type DesktopEventConsumer,
} from '../app/events/DesktopEventRouterContext'
import { WorkspaceLayout } from '../app/layout/WorkspaceLayout'
import {
  WorkspaceRestrictedContents,
  WorkspaceRestrictedConversation,
  WorkspaceRestrictedDocument,
} from '../app/layout/WorkspaceRestrictedPanels'
import {
  deriveDesktopWorkspaceAccess,
  shouldShowManagedDesktopStartup,
  shouldShowDesktopLogin,
} from '../app/workspaceAccess'

const offlineReason = '平台 API 未运行。地图与本地布局仍可使用，远程操作已安全禁用。'

describe('offline desktop workspace', () => {
  it('fails closed without hiding the desktop GIS shell', () => {
    const access = deriveDesktopWorkspaceAccess({
      authStatus: 'error',
      backendAvailability: 'offline',
      backendError: offlineReason,
      authenticationError: '自动认证无法连接服务端。',
      hasAuthenticatedIdentity: false,
      platformRoles: [],
    })

    expect(access).toEqual({
      backendActionsEnabled: false,
      canAccessAccount: false,
      canAccessDiagnostics: false,
      canManageRuntimeConfiguration: false,
      canAccessSecurity: false,
      statusLabel: '离线工作台',
      unavailableReason: offlineReason,
    })
  })

  it('renders the complete local workbench with remote actions disabled and admin entry points hidden', () => {
    installMemoryStorage()
    const html = renderToStaticMarkup(
      <DesktopEventRouterContext.Provider value={noDesktopEvents}>
        <WorkspaceLayout
          activeDesktopDocument="map"
          artifactCount={0}
          backendActionDisabledReason={offlineReason}
          canAccessAccount={false}
          canAccessDiagnostics={false}
          canAccessSecurity={false}
          contentsSlot={<WorkspaceRestrictedContents basemapName="天地图" reason={offlineReason} />}
          currentThreadId={undefined}
          workspaceLayoutKey="offline-workspace"
          dataReferenceCount={0}
          inspectorSlot={<WorkspaceRestrictedDocument title="分析结果" reason={offlineReason} />}
          mainSlot={<WorkspaceRestrictedConversation reason={offlineReason} onRetry={() => undefined} />}
          mapSlot={<section aria-label="本地地图画布">地图画布（本地）</section>}
          modelLabel="不可用"
          modelRouteAvailable={false}
          modelStatusLabel="离线工作台"
          onContentsModeChange={() => undefined}
          onDesktopDocumentChange={() => undefined}
          onExportResults={() => undefined}
          onNewTask={() => undefined}
          onSelectThread={() => undefined}
          onSidebarItemClick={() => undefined}
          onWorkspaceModeChange={() => undefined}
          providerLabel="本机离线"
          selectedBasemapName="天地图"
          sessionThreads={[]}
          toolsSlot={<WorkspaceRestrictedDocument title="工具与自动化" reason={offlineReason} />}
          topBar={(
            <TopBar
              activeWorkspaceId={null}
              authMe={null}
              onOpenDocument={() => undefined}
              onOpenWorkspace={() => undefined}
              unavailableReason={offlineReason}
              workspaces={[]}
            />
          )}
          workflowSlot={<WorkspaceRestrictedDocument title="智能体工作流" reason={offlineReason} />}
          workspaceMode="map"
        />
      </DesktopEventRouterContext.Provider>,
    )

    expect(html).toContain(PRODUCT_CODENAME)
    expect(html).toContain('地图画布（本地）')
    expect(html).toContain('智能对话')
    expect(html).toContain('服务恢复并完成认证后即可输入消息')
    expect(html).toContain('身份状态：未验证')
    expect(html).toContain('disabled=""')
    expect(html).toContain('>管理<')
    expect(html).not.toContain('安全管理')
    expect(html).not.toContain('配置与诊断')
    expect(html).not.toContain('账号中心')
    expect(html).not.toContain('type="password"')
  })

  it('only exposes sensitive documents after an online verified platform-admin projection', () => {
    const access = deriveDesktopWorkspaceAccess({
      authStatus: 'authenticated',
      authMode: 'interactive',
      backendAvailability: 'online',
      hasAuthenticatedIdentity: true,
      platformRoles: ['platform_admin'],
    })

    expect(access.backendActionsEnabled).toBe(true)
    expect(access.canAccessAccount).toBe(true)
    expect(access.canAccessDiagnostics).toBe(true)
    expect(access.canManageRuntimeConfiguration).toBe(true)
    expect(access.canAccessSecurity).toBe(true)
    expect(access.unavailableReason).toBeUndefined()
  })

  it('grants a verified local managed desktop only the narrow runtime configuration capability', () => {
    const access = deriveDesktopWorkspaceAccess({
      authMode: 'local_auto',
      authStatus: 'authenticated',
      backendAvailability: 'online',
      hasAuthenticatedIdentity: true,
      platformRoles: ['analyst'],
    })

    expect(access.backendActionsEnabled).toBe(true)
    expect(access.canAccessAccount).toBe(false)
    expect(access.canManageRuntimeConfiguration).toBe(true)
    expect(access.canAccessDiagnostics).toBe(false)
    expect(access.canAccessSecurity).toBe(false)
  })

  it('hides login in local auto-auth and offline modes but preserves the online interactive entry', () => {
    expect(shouldShowDesktopLogin({
      authMode: 'local_auto',
      authStatus: 'unauthenticated',
      backendAvailability: 'online',
      hasAuthenticatedIdentity: false,
    })).toBe(false)
    expect(shouldShowDesktopLogin({
      authMode: 'interactive',
      authStatus: 'unauthenticated',
      backendAvailability: 'offline',
      hasAuthenticatedIdentity: false,
    })).toBe(false)
    expect(shouldShowDesktopLogin({
      authMode: 'interactive',
      authStatus: 'unauthenticated',
      backendAvailability: 'online',
      hasAuthenticatedIdentity: false,
    })).toBe(true)
  })

  it('keeps local managed startup full-screen until the verified identity projection exists', () => {
    expect(shouldShowManagedDesktopStartup({
      authMode: 'unknown',
      authStatus: 'checking',
      backendAvailability: 'online',
      hasAuthenticatedIdentity: false,
    })).toBe(true)
    expect(shouldShowManagedDesktopStartup({
      authMode: 'local_auto',
      authStatus: 'error',
      backendAvailability: 'online',
      hasAuthenticatedIdentity: false,
    })).toBe(true)
    expect(shouldShowManagedDesktopStartup({
      authMode: 'local_auto',
      authStatus: 'authenticated',
      backendAvailability: 'online',
      hasAuthenticatedIdentity: true,
    })).toBe(false)
    expect(shouldShowManagedDesktopStartup({
      authMode: 'interactive',
      authStatus: 'unauthenticated',
      backendAvailability: 'online',
      hasAuthenticatedIdentity: false,
    })).toBe(false)
  })
})

const noDesktopEvents: DesktopEventConsumer = {
  subscribe: () => () => undefined,
}

function installMemoryStorage(): void {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size
      },
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    } satisfies Storage,
  })
}

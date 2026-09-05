// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机产品显示身份提供器
//
//   文件:       ProductIdentityProvider.tsx
// --------------------------------------------------------------------------

import { useMemo, type ReactNode } from 'react'
import type { DesktopProductSetupStatus } from '../../contracts/desktopIpc'

import { ProductIdentityContext } from './ProductIdentityContext'

export function ProductIdentityProvider({
  productName,
  onOpenSettings,
  setupStatus = null,
  children,
}: {
  productName: string
  onOpenSettings: () => void
  setupStatus?: Extract<DesktopProductSetupStatus, { state: 'configured' }> | null
  children: ReactNode
}) {
  const value = useMemo(() => ({
    productName,
    openProductSettings: onOpenSettings,
    setupStatus,
  }), [onOpenSettings, productName, setupStatus])
  return <ProductIdentityContext.Provider value={value}>{children}</ProductIdentityContext.Provider>
}

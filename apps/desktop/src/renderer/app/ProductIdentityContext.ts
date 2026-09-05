// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机产品显示身份上下文
//
//   文件:       ProductIdentityContext.ts
// --------------------------------------------------------------------------

import { createContext, useContext } from 'react'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'
import type { DesktopProductSetupStatus } from '../../contracts/desktopIpc'

export interface ProductIdentityContextValue {
  productName: string
  openProductSettings: () => void
  setupStatus: Extract<DesktopProductSetupStatus, { state: 'configured' }> | null
}

export const ProductIdentityContext = createContext<ProductIdentityContextValue>({
  productName: PRODUCT_CODENAME,
  openProductSettings: () => undefined,
  setupStatus: null,
})

export function useProductIdentity(): ProductIdentityContextValue {
  return useContext(ProductIdentityContext)
}

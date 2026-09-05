// +-------------------------------------------------------------------------
//
//   地理智能平台 - 统一桌面启动体验
//
//   文件:       StartupScreen.tsx
// --------------------------------------------------------------------------

import { PRODUCT_DESKTOP_NAME } from '@geo-agent-platform/shared-types/product-identity'
import type { ReactNode } from 'react'

export function StartupScreen({
  productName = PRODUCT_DESKTOP_NAME,
  stage,
  title,
  description,
  busy,
  errorMessage,
  actions,
  footer,
}: {
  productName?: string
  stage: string
  title: string
  description: string
  busy: boolean
  errorMessage?: string | null
  actions?: ReactNode
  footer: string
}) {
  const displayName = desktopDisplayName(productName)
  return (
    <main className="dc-startup" data-state={busy ? 'busy' : 'error'} aria-live="polite">
      <section className="dc-startup__shell" aria-labelledby="desktop-startup-title">
        <header className="dc-startup__brand">
          <span aria-hidden="true">{displayName.slice(0, 1).toLocaleUpperCase()}</span>
          <div>
            <strong>{displayName}</strong>
            <small>{stage}</small>
          </div>
        </header>

        <div className="dc-startup__indicator" aria-hidden="true">
          <span />
          <i />
        </div>

        <div className="dc-startup__copy">
          <h1 id="desktop-startup-title">{title}</h1>
          <p>{description}</p>
        </div>

        {errorMessage ? (
          <p className="dc-startup__error" role="alert">{errorMessage}</p>
        ) : null}

        {actions ? <div className="dc-startup__actions">{actions}</div> : null}
        <p className="dc-startup__status"><span aria-hidden="true" />{footer}</p>
      </section>
    </main>
  )
}

function desktopDisplayName(productName: string): string {
  const name = productName.trim() || PRODUCT_DESKTOP_NAME
  return /(?:工作台|平台)$/u.test(name) ? name : `${name} GIS 工作台`
}

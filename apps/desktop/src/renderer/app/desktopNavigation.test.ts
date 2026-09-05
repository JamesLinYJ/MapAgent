// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面文档导航事件测试
//
//   文件:       desktopNavigation.test.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PLATFORM_RENDERER_EVENT_PREFIX,
} from '@geo-agent-platform/shared-types/product-identity'

import type { DesktopDocument } from './layout/WorkspaceLayout.js'
import {
  requestDesktopDocument,
  subscribeDesktopDocument,
} from './desktopNavigation.js'

describe('desktop document navigation', () => {
  const legalDocuments = ['terms', 'privacy'] as const satisfies readonly DesktopDocument[]

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(legalDocuments)(
    'delivers the %s legal document through the desktop navigation boundary',
    document => {
      vi.stubGlobal('window', new EventTarget())
      const listener = vi.fn()
      const unsubscribe = subscribeDesktopDocument(listener)

      requestDesktopDocument(document)

      expect(listener).toHaveBeenCalledOnce()
      expect(listener).toHaveBeenCalledWith(document)
      unsubscribe()
    },
  )

  it('ignores document values outside the registered desktop document set', () => {
    vi.stubGlobal('window', new EventTarget())
    const listener = vi.fn()
    const unsubscribe = subscribeDesktopDocument(listener)

    window.dispatchEvent(new CustomEvent(`${PLATFORM_RENDERER_EVENT_PREFIX}:desktop-document`, {
      detail: 'external-url',
    }))

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})

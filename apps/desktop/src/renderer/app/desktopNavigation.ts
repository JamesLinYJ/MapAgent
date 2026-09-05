// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面文档导航事件
//
//   文件:       desktopNavigation.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { DesktopDocument } from './layout/WorkspaceLayout'
import {
  PLATFORM_RENDERER_EVENT_PREFIX,
} from '@geo-agent-platform/shared-types/product-identity'
import {
  desktopMenuCommandSchema,
  type DesktopMenuCommand,
} from '../../contracts/desktopIpc'

const DESKTOP_DOCUMENT_EVENT = `${PLATFORM_RENDERER_EVENT_PREFIX}:desktop-document`
const DESKTOP_COMMAND_EVENT = `${PLATFORM_RENDERER_EVENT_PREFIX}:desktop-command`
const DOCUMENTS = new Set<DesktopDocument>([
  'map',
  'tools',
  'workflow',
  'results',
  'account',
  'security',
  'debug',
  'terms',
  'privacy',
])

export function requestDesktopDocument(document: DesktopDocument): void {
  window.dispatchEvent(new CustomEvent(DESKTOP_DOCUMENT_EVENT, { detail: document }))
}

export function subscribeDesktopDocument(
  listener: (document: DesktopDocument) => void,
): () => void {
  const handleEvent = (event: Event) => {
    if (!(event instanceof CustomEvent) || !DOCUMENTS.has(event.detail)) return
    listener(event.detail)
  }
  window.addEventListener(DESKTOP_DOCUMENT_EVENT, handleEvent)
  return () => window.removeEventListener(DESKTOP_DOCUMENT_EVENT, handleEvent)
}

export function requestDesktopCommand(command: DesktopMenuCommand): void {
  window.dispatchEvent(new CustomEvent(DESKTOP_COMMAND_EVENT, { detail: command }))
}

export function subscribeDesktopCommand(
  listener: (command: DesktopMenuCommand) => void,
): () => void {
  const handleEvent = (event: Event) => {
    if (!(event instanceof CustomEvent)) return
    const command = desktopMenuCommandSchema.safeParse(event.detail)
    if (command.success) listener(command.data)
  }
  window.addEventListener(DESKTOP_COMMAND_EVENT, handleEvent)
  return () => window.removeEventListener(DESKTOP_COMMAND_EVENT, handleEvent)
}

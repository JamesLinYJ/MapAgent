// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面文档标签状态
//
//   文件:       documentTabs.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

export type DesktopDocument =
  | 'map'
  | 'tools'
  | 'workflow'
  | 'results'
  | 'settings'
  | 'account'
  | 'security'
  | 'debug'
  | 'terms'
  | 'privacy'

export interface DesktopDocumentCloseResult {
  documents: DesktopDocument[]
  activeDocument: DesktopDocument
}

const PINNED_DOCUMENT: DesktopDocument = 'map'
const FOCUSED_DOCUMENTS = new Set<DesktopDocument>([
  'settings',
  'account',
  'security',
  'debug',
  'terms',
  'privacy',
])

// 页面型文档需要完整的文档画布；地图、工具、工作流和成果仍保留停靠面板语义。
export function isFocusedDesktopDocument(document: DesktopDocument): boolean {
  return FOCUSED_DOCUMENTS.has(document)
}

export function openDesktopDocument(
  documents: readonly DesktopDocument[],
  document: DesktopDocument,
): DesktopDocument[] {
  const normalized = uniqueDocuments(documents)
  if (!normalized.includes(document)) normalized.push(document)
  return pinMapFirst(normalized)
}

export function closeDesktopDocument(
  documents: readonly DesktopDocument[],
  activeDocument: DesktopDocument,
  document: DesktopDocument,
): DesktopDocumentCloseResult {
  const current = pinMapFirst(uniqueDocuments(documents))
  if (document === PINNED_DOCUMENT || !current.includes(document)) {
    return { documents: current, activeDocument }
  }

  const closingIndex = current.indexOf(document)
  const nextDocuments = current.filter(candidate => candidate !== document)
  if (activeDocument !== document) {
    return { documents: nextDocuments, activeDocument }
  }
  const adjacent = nextDocuments[Math.min(closingIndex, nextDocuments.length - 1)]
    ?? PINNED_DOCUMENT
  return { documents: nextDocuments, activeDocument: adjacent }
}

export function moveDesktopDocument(
  documents: readonly DesktopDocument[],
  document: DesktopDocument,
  target: DesktopDocument,
): DesktopDocument[] {
  const current = pinMapFirst(uniqueDocuments(documents))
  if (
    document === PINNED_DOCUMENT
    || target === PINNED_DOCUMENT
    || document === target
    || !current.includes(document)
    || !current.includes(target)
  ) {
    return current
  }

  const withoutDocument = current.filter(candidate => candidate !== document)
  const targetIndex = withoutDocument.indexOf(target)
  withoutDocument.splice(targetIndex, 0, document)
  return pinMapFirst(withoutDocument)
}

export function stepDesktopDocument(
  documents: readonly DesktopDocument[],
  document: DesktopDocument,
  direction: -1 | 1,
): DesktopDocument[] {
  const current = pinMapFirst(uniqueDocuments(documents))
  const index = current.indexOf(document)
  const targetIndex = index + direction
  if (
    document === PINNED_DOCUMENT
    || index < 1
    || targetIndex < 1
    || targetIndex >= current.length
  ) {
    return current
  }
  const target = current[targetIndex]
  return target ? moveDesktopDocument(current, document, target) : current
}

function uniqueDocuments(documents: readonly DesktopDocument[]): DesktopDocument[] {
  return [...new Set<DesktopDocument>([PINNED_DOCUMENT, ...documents])]
}

function pinMapFirst(documents: DesktopDocument[]): DesktopDocument[] {
  return [
    PINNED_DOCUMENT,
    ...documents.filter(document => document !== PINNED_DOCUMENT),
  ]
}

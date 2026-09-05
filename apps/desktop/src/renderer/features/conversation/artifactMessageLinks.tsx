// +-------------------------------------------------------------------------
//
//   地理智能平台 - 对话 Artifact 链接投影
//
//   文件:       artifactMessageLinks.tsx
//
//   日期:       2026年08月12日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ArtifactRef } from '@geo-agent-platform/shared-types'
import type { ConversationEntry } from '@geo-agent-platform/conversation-presentation'
import type { Components } from 'react-markdown'

const ARTIFACT_HREF_PREFIX = '#artifact/'
const ARTIFACT_ID_BOUNDARY = '[A-Za-z0-9_-]'

interface MarkdownNode {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

export function resolveConversationEntryArtifacts(
  entry: ConversationEntry,
  artifacts: ReadonlyArray<ArtifactRef>,
): ArtifactRef[] {
  const requested = Array.isArray(entry.details?.artifactIds)
    ? entry.details.artifactIds.filter((value): value is string => typeof value === 'string')
    : []
  const requestedIds = new Set(requested)
  return artifacts.filter(artifact => requestedIds.has(artifact.artifactId))
}

export function createArtifactReferenceRemarkPlugin(
  artifacts: ReadonlyArray<ArtifactRef>,
): () => (tree: unknown) => void {
  const references = new Map(artifacts.map(artifact => [artifact.artifactId, artifactLabel(artifact)]))
  const identifiers = [...references.keys()].sort((left, right) => right.length - left.length)
  const source = identifiers.map(escapeRegExp).join('|')

  return () => (tree: unknown) => {
    if (!source || !isMarkdownNode(tree)) return
    linkifyNode(tree, references, source, false)
  }
}

export function createArtifactMarkdownComponents(
  onSelectArtifact: (artifactId: string) => void,
): Components {
  return {
    a({ node: _node, href, children, className, ...props }) {
      const artifactId = artifactIdFromHref(href)
      if (artifactId) {
        return (
          <a
            {...props}
            className={['cc-artifact-link', className].filter(Boolean).join(' ')}
            href={href}
            onClick={(event) => {
              event.preventDefault()
              onSelectArtifact(artifactId)
            }}
          >
            {children}
          </a>
        )
      }
      const external = typeof href === 'string' && /^https?:\/\//iu.test(href)
      return (
        <a
          {...props}
          className={className}
          href={href}
          target={external ? '_blank' : undefined}
          rel={external ? 'noopener noreferrer' : undefined}
        >
          {children}
        </a>
      )
    },
  }
}

export function artifactLinkHref(artifactId: string): string {
  return `${ARTIFACT_HREF_PREFIX}${encodeURIComponent(artifactId)}`
}

export function artifactLabel(artifact: ArtifactRef): string {
  return artifact.name.trim() || '结果文件'
}

function artifactIdFromHref(href: string | undefined): string | null {
  if (!href?.startsWith(ARTIFACT_HREF_PREFIX)) return null
  const encoded = href.slice(ARTIFACT_HREF_PREFIX.length)
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

function linkifyNode(
  node: MarkdownNode,
  references: ReadonlyMap<string, string>,
  identifierPattern: string,
  insideLink: boolean,
): void {
  if (!node.children?.length) return
  const nextChildren: MarkdownNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string' && !insideLink) {
      nextChildren.push(...linkifyText(child.value, references, identifierPattern))
      continue
    }
    linkifyNode(
      child,
      references,
      identifierPattern,
      insideLink || child.type === 'link' || child.type === 'linkReference',
    )
    nextChildren.push(child)
  }
  node.children = nextChildren
}

function linkifyText(
  value: string,
  references: ReadonlyMap<string, string>,
  identifierPattern: string,
): MarkdownNode[] {
  const matcher = new RegExp(
    `(?<!${ARTIFACT_ID_BOUNDARY})(${identifierPattern})(?!${ARTIFACT_ID_BOUNDARY})`,
    'gu',
  )
  const nodes: MarkdownNode[] = []
  let cursor = 0
  for (const match of value.matchAll(matcher)) {
    const index = match.index
    const artifactId = match[1]
    if (index === undefined || !artifactId) continue
    if (index > cursor) nodes.push({ type: 'text', value: value.slice(cursor, index) })
    nodes.push({
      type: 'link',
      url: artifactLinkHref(artifactId),
      children: [{ type: 'text', value: references.get(artifactId) ?? '结果文件' }],
    })
    cursor = index + artifactId.length
  }
  if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) })
  return nodes.length ? nodes : [{ type: 'text', value }]
}

function isMarkdownNode(value: unknown): value is MarkdownNode {
  return typeof value === 'object' && value !== null && 'type' in value
    && typeof (value as { type?: unknown }).type === 'string'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

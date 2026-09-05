// +-------------------------------------------------------------------------
//
//   地理智能平台 - 开发文件匹配
//
//   文件:       glob.ts
//
//   日期:       2026年06月25日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 这里实现受控 glob，不走 shell 展开。目录遍历跳过常见依赖和 VCS 目录，
// 输出稳定排序并由调用方截断。

import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { toPortablePath } from './pathPolicy.js'

const SKIPPED_DIRS = new Set(['.git', '.hg', '.svn', '.jj', 'node_modules', 'dist', 'build', '.next', '.vite'])
const MAX_REPORTED_ISSUES = 50

interface GlobTraversalIssue {
  path: string
  reason: 'permission_denied' | 'disappeared'
}

export interface GlobSearchResult {
  matches: string[]
  truncated: boolean
  partial: boolean
  issueCount: number
  issues: GlobTraversalIssue[]
}

export interface GlobSearchDependencies {
  readDirectory?: (directory: string) => Promise<Dirent[]>
  allowPath?: (candidate: string) => boolean
}

export async function globFiles(
  root: string,
  pattern: string,
  limit: number,
  dependencies: GlobSearchDependencies = {},
): Promise<GlobSearchResult> {
  if (path.isAbsolute(pattern)) throw new Error('glob pattern 必须是相对路径；请用 path 指定搜索根目录')
  const regex = globToRegex(toPortablePath(pattern))
  const matches: string[] = []
  const traversal = { issueCount: 0, issues: [] as GlobTraversalIssue[] }
  await walk(
    root,
    root,
    regex,
    matches,
    Math.max(1, limit) + 1,
    traversal,
    dependencies.readDirectory ?? readDirectory,
    dependencies.allowPath ?? (() => true),
  )
  matches.sort((a, b) => a.localeCompare(b))
  traversal.issues.sort((left, right) => left.path.localeCompare(right.path))
  const truncated = matches.length > limit
  return {
    matches: truncated ? matches.slice(0, limit) : matches,
    truncated,
    partial: traversal.issueCount > 0,
    issueCount: traversal.issueCount,
    issues: traversal.issues,
  }
}

async function walk(
  root: string,
  current: string,
  regex: RegExp,
  matches: string[],
  hardLimit: number,
  traversal: { issueCount: number; issues: GlobTraversalIssue[] },
  readDirectoryEntries: (directory: string) => Promise<Dirent[]>,
  allowPath: (candidate: string) => boolean,
): Promise<void> {
  if (matches.length >= hardLimit) return
  let entries: Dirent[]
  try {
    entries = await readDirectoryEntries(current)
  } catch (error) {
    const reason = traversalIssueReason(error)
    if (!reason) throw error
    traversal.issueCount += 1
    if (traversal.issues.length < MAX_REPORTED_ISSUES) {
      traversal.issues.push({
        path: toPortablePath(path.relative(root, current)) || '.',
        reason,
      })
    }
    return
  }
  for (const entry of entries) {
    if (matches.length >= hardLimit) return
    if (entry.isSymbolicLink()) continue
    const absolutePath = path.join(current, entry.name)
    if (!allowPath(absolutePath)) continue
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      await walk(root, absolutePath, regex, matches, hardLimit, traversal, readDirectoryEntries, allowPath)
      continue
    }
    if (!entry.isFile()) continue
    const relative = toPortablePath(path.relative(root, absolutePath))
    if (regex.test(relative)) matches.push(relative)
  }
}

async function readDirectory(directory: string): Promise<Dirent[]> {
  return readdir(directory, { withFileTypes: true })
}

function traversalIssueReason(error: unknown): GlobTraversalIssue['reason'] | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied'
  if (code === 'ENOENT') return 'disappeared'
  return null
}

function globToRegex(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === undefined) continue
    const next = pattern[index + 1]
    if (char === '*' && next === '*') {
      const after = pattern[index + 2]
      if (after === '/') {
        source += '(?:.*\\/)?'
        index += 2
      } else {
        source += '.*'
        index += 1
      }
      continue
    }
    if (char === '*') {
      source += '[^/]*'
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '{') {
      const end = pattern.indexOf('}', index)
      if (end > index) {
        const alternatives = pattern.slice(index + 1, end).split(',').map(escapeRegex).join('|')
        source += `(?:${alternatives})`
        index = end
        continue
      }
    }
    source += escapeRegex(char)
  }
  source += '$'
  return new RegExp(source)
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}
